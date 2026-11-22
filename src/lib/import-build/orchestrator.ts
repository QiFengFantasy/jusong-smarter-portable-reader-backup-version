import {
  buildChapterDigest,
  mergeDynamicDigest,
  type AgentExploreWrite,
  type AgentKnowledgeWrite,
  type AgentKnowledgeWriteResult,
  type Chapter,
  type ChapterDigest,
  type DigestPoint,
  type KnowledgeEntry,
  type Library,
} from "@jusong/core";

import { createAgentId, fetchAgentConfig, sendAgentChat } from "../agent";
import { invalidateChapterExplore } from "../explore";
import { invalidateBook } from "../knowledge-cache";
import { flattenChapters, type FlatChapter } from "../toc";
import { BATCH_SIZE } from "./estimate";
import {
  chapterExcerpt,
  LEAD_PROMPT,
  RESEARCHER_PROMPT,
  REVIEWER_PROMPT,
  WRITER_PROMPT,
} from "./prompts";
import {
  BUILD_ITEMS,
  buildItemTitle,
  isBuildItemId,
  type BuildFailedBatch,
  type BuildItemId,
  type BuildMessage,
  type BuildMessageTone,
  type BuildProgress,
  type BuildResult,
  type RunImportBuildOptions,
} from "./types";

/**
 * 导入第二流程「AGENT 团队构建」的编排器。
 *
 * 流程：
 * 1. 无 Key 抛错（UI 会禁用开始）；加载 TOC 与章节正文（并发 4）；
 * 2. Lead 计划（1 次调用）→ 按 5 章分批；
 * 3. 每批：研究员分析 → 撰写产出 → 审查判定；不通过则撰写带 issues 修订一次再审查，
 *    仍不通过立即停止并保留已完成内容；
 * 4. 通过后立即落库：digest 逐章 saveChapterDigest、archive 逐条 addKnowledge(note)，
 *    place/event 先累积（最后统一写入 topics/explore 与 place/timeline 知识条目）；
 * 5. 最后 Lead 终审（1 次调用），去重（listKnowledge 的 type+title）后写 place/timeline
 *    知识条目与 `library.applyAgentKnowledge`（map/timeline/explores），并让知识缓存失效。
 *
 * 说明：
 * - Rust `agent_chat` 会自行注入应用 system prompt，因此每个角色只发一条 `user` 消息，
 *   角色指令放在文本开头（见 prompts.ts），不传 `role:"system"`。
 * - `onMessage` 只输出简短状态；不把模型原文整段交给 UI。
 * - 模型/JSON/写入失败：错误消息 + `completed=false` + `failedBatch`，已写入的保留。
 * - `onProgress.savedPlaces/savedEvents` 是「已接受、待最终写入」的数量；
 *   最终 `BuildResult` 中的 place/event 计数是实际新增的知识条目数（去重后）。
 */

/** 章节正文加载并发数。 */
const CHAPTER_LOAD_CONCURRENCY = 4;
/** 审查意见最多展示/透传的条数与单条长度。 */
const MAX_REVIEW_ISSUES = 5;
const MAX_ISSUE_CHARS = 120;
/** AGENT 构建统一使用的主题 id（与迁移脚本、契约 §2.3 一致）。 */
const AGENT_THEME_ID = "agent-build";
const AGENT_THEME_NAME = "AGENT 构建";
const AGENT_THEME_COLOR = "#8c2f1e";
/** 模型返回字符串字段的上限，避免异常输出撑爆数据。 */
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 3000;
const MAX_DESCRIPTION_CHARS = 600;

/** 编排层错误：`code` 便于调用方/日志区分；message 面向用户可读。 */
class ImportBuildError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportBuildError";
    this.code = code;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "未知错误";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ImportBuildError("ABORTED", "构建已取消");
  }
}

function clip(text: string, max: number): string {
  const value = (text ?? "").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// 通用 JSON / 输入归一化工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text) out.push(text);
  }
  return out;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** 去重用的标题归一化：折叠空白、小写（中英文标题都适用）。 */
function normalizeTitleForDedupe(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/** 知识条目去重键：type + 归一化 title（契约要求）。 */
function dedupeKey(type: string, title: string): string {
  return `${type}\u0000${normalizeTitleForDedupe(title)}`;
}

/** 稳定短哈希（FNV-1a → base36），用于模型未给出合法 id 时兜底。 */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const PLACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EVENT_ID_PATTERN = /^ev-[a-z0-9][a-z0-9-]{0,79}$/;
const DATE_PATTERN = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/;

/** 地点 id：去掉 place-/p- 前缀后必须是短英文/拼音 slug，否则用名称哈希兜底。 */
function normalizePlaceId(rawId: string, name: string): string {
  const value = rawId
    .trim()
    .toLowerCase()
    .replace(/^place-/, "")
    .replace(/^p-/, "");
  if (PLACE_ID_PATTERN.test(value)) return value;
  return `p-${shortHash(name)}`;
}

/** 事件 id：沿用 ev-YYYYMMDD-简短名；不合法时用日期 + 标题哈希兜底。 */
function normalizeEventId(rawId: string, date: string, title: string): string {
  const value = rawId.trim().toLowerCase().replace(/^timeline-/, "");
  if (EVENT_ID_PATTERN.test(value)) return value;
  const dateDigits = date.replace(/[^0-9]/g, "").slice(0, 8) || "00000000";
  return `ev-${dateDigits}-${shortHash(title)}`;
}

/** 把 YYYY / YYYY-M / YYYY-M-D 归一化为 YYYY-MM-DD（年份级保留年份）；无法解析返回 null。 */
function normalizeDate(raw: unknown): string | null {
  const value = asString(raw).trim();
  const yearOnly = /^(\d{4})$/.exec(value);
  if (yearOnly) return yearOnly[1];
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = match[1];
  const month = Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 时间线日期标签：`YYYY年M月D日`（与迁移脚本/时间线视图一致）。 */
function formatDateLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

/**
 * 时间线事件日期：审查口径允许 YYYY / YYYY-MM / YYYY-MM-DD（契约格式为 YYYY-MM-DD）。
 * 年份/年月级日期补 01 以便排序，同时保留更精确的 `dateLabel`（如「1937年」「1937年7月」）。
 */
interface EventDateParts {
  date: string;
  dateLabel: string;
}

function normalizeEventDate(raw: unknown): EventDateParts | null {
  const value = asString(raw).trim();
  const yearOnly = /^(\d{4})$/.exec(value);
  if (yearOnly) {
    return { date: `${yearOnly[1]}-01-01`, dateLabel: `${yearOnly[1]}年` };
  }
  const monthOnly = /^(\d{4})-(\d{1,2})$/.exec(value);
  if (monthOnly) {
    const month = Number(monthOnly[2]);
    if (!Number.isFinite(month) || month < 1 || month > 12) return null;
    return {
      date: `${monthOnly[1]}-${String(month).padStart(2, "0")}-01`,
      dateLabel: `${monthOnly[1]}年${month}月`,
    };
  }
  const date = normalizeDate(value);
  if (!date) return null;
  return { date, dateLabel: formatDateLabel(date) };
}

/** 去掉 markdown 代码围栏与 BOM；真正的 JSON 截取交给调用方。 */
function stripCodeFence(text: string): string {
  const raw = (text ?? "").replace(/^\uFEFF/, "").trim();
  const fenced = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(raw);
  return fenced ? fenced[1].trim() : raw;
}

/** 容错解析：去围栏/前后说明后截取最外层 JSON 对象。 */
function parseModelJson(text: string, context: string): Record<string, unknown> {
  const cleaned = stripCodeFence(text);
  if (!cleaned) {
    throw new ImportBuildError("EMPTY_RESPONSE", `${context}：模型没有返回内容`);
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ImportBuildError("BAD_JSON", `${context}：模型返回中找不到 JSON 对象`);
  }
  const candidate = cleaned.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new ImportBuildError(
      "BAD_JSON",
      `${context}：模型返回的 JSON 无法解析（${errorMessage(error)}）`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ImportBuildError("BAD_JSON", `${context}：模型返回的 JSON 不是对象`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 模型输出解析与归一化
// ---------------------------------------------------------------------------

interface LeadPlan {
  strategy: string;
  batchFocus: string[];
  warnings: string[];
}

function parseLeadPlan(text: string): LeadPlan {
  const record = parseModelJson(text, "Lead 计划");
  return {
    strategy: clip(asString(record.strategy), 200),
    batchFocus: stringArray(record.batchFocus).map((item) => clip(item, 120)).slice(0, 500),
    warnings: stringArray(record.warnings)
      .map((item) => clip(item, 120))
      .slice(0, MAX_REVIEW_ISSUES),
  };
}

interface ResearcherNotes {
  chapters: Array<{
    chapterId: string;
    gist: string;
    keyPoints: string[];
    people: string[];
    places: Array<{ name: string; note: string }>;
    events: Array<{ date: string; title: string; summary: string }>;
    quotes: string[];
  }>;
  batchThemes: string[];
  warnings: string[];
}

function parseResearcherNotes(
  text: string,
  batchChapterIds: ReadonlySet<string>,
): ResearcherNotes {
  const record = parseModelJson(text, "研究员笔记");
  const chapters = recordArray(record.chapters)
    .map((chapter) => {
      const chapterId = asString(chapter.chapterId).trim();
      if (!chapterId || !batchChapterIds.has(chapterId)) return null;
      return {
        chapterId,
        gist: clip(asString(chapter.gist), 400),
        keyPoints: stringArray(chapter.keyPoints).map((item) => clip(item, 200)).slice(0, 8),
        people: stringArray(chapter.people).map((item) => clip(item, 60)).slice(0, 20),
        places: recordArray(chapter.places)
          .map((place) => ({
            name: clip(asString(place.name), MAX_TITLE_CHARS),
            note: clip(asString(place.note), 200),
          }))
          .filter((place) => place.name.length > 0)
          .slice(0, 20),
        events: recordArray(chapter.events)
          .map((event) => ({
            date: clip(asString(event.date), 32),
            title: clip(asString(event.title), MAX_TITLE_CHARS),
            summary: clip(asString(event.summary), 300),
          }))
          .filter((event) => event.title.length > 0)
          .slice(0, 20),
        quotes: stringArray(chapter.quotes).map((item) => clip(item, 160)).slice(0, 10),
      };
    })
    .filter((chapter): chapter is ResearcherNotes["chapters"][number] => chapter !== null);
  if (chapters.length === 0) {
    throw new ImportBuildError("EMPTY_NOTES", "研究员没有返回任何有效章节笔记");
  }
  return {
    chapters,
    batchThemes: stringArray(record.batchThemes).map((item) => clip(item, 60)).slice(0, 20),
    warnings: stringArray(record.warnings)
      .map((item) => clip(item, 120))
      .slice(0, MAX_REVIEW_ISSUES),
  };
}

interface DraftDigest {
  chapterId: string;
  summary: string;
  keyPoints: Array<{ section: string; title?: string; text: string }>;
  themes: string[];
  writing: { date?: string; placeName?: string };
}

interface DraftArchive {
  chapterId?: string;
  title: string;
  body: string;
}

interface DraftPlace {
  id: string;
  name: string;
  lon: number;
  lat: number;
  description: string;
  chapterIds: string[];
}

interface DraftEvent {
  id: string;
  date: string;
  /** 事件日期的展示标签；年份/年月级日期会保留粒度（如「1937年」「1937年7月」）。 */
  dateLabel: string;
  title: string;
  summary: string;
  chapterIds: string[];
  placeIds: string[];
  importance: number;
}

interface BatchDraft {
  digests: DraftDigest[];
  archives: DraftArchive[];
  places: DraftPlace[];
  events: DraftEvent[];
}

const KNOWN_SECTIONS = new Set([
  "overview",
  "background",
  "purpose",
  "significance",
  "structure",
  "argument",
  "context",
  "note",
]);

function normalizeSection(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (KNOWN_SECTIONS.has(value)) return value;
  return value ? clip(value, 32) : "overview";
}

function normalizeDraftDigest(
  record: Record<string, unknown>,
  batchChapterIds: ReadonlySet<string>,
): DraftDigest | null {
  const chapterId = asString(record.chapterId).trim();
  if (!chapterId || !batchChapterIds.has(chapterId)) return null;
  const keyPoints = recordArray(record.keyPoints)
    .map((point) => {
      const text = clip(asString(point.text), 400);
      if (!text) return null;
      const title = clip(asString(point.title), MAX_TITLE_CHARS);
      return {
        section: normalizeSection(asString(point.section)),
        ...(title ? { title } : {}),
        text,
      };
    })
    .filter((point): point is DraftDigest["keyPoints"][number] => point !== null)
    .slice(0, 8);
  const writingRecord = isRecord(record.writing) ? record.writing : {};
  const date = normalizeDate(writingRecord.date);
  const placeName = clip(asString(writingRecord.placeName), MAX_TITLE_CHARS);
  return {
    chapterId,
    summary: clip(asString(record.summary), 600),
    keyPoints,
    themes: stringArray(record.themes).map((item) => clip(item, 40)).slice(0, 8),
    writing: {
      ...(date ? { date } : {}),
      ...(placeName ? { placeName } : {}),
    },
  };
}

function normalizeDraftArchive(
  record: Record<string, unknown>,
  bookChapterIds: ReadonlySet<string>,
  chapterTitles: ReadonlyMap<string, string>,
): DraftArchive | null {
  const rawChapterId = asString(record.chapterId).trim();
  const chapterId =
    rawChapterId && bookChapterIds.has(rawChapterId) ? rawChapterId : undefined;
  // 兼容 body 直接给出，或 sections: [{title,text}] 分段给出。
  let body = clip(asString(record.body), MAX_BODY_CHARS);
  if (!body) {
    body = clip(
      recordArray(record.sections)
        .map((section) => {
          const title = clip(asString(section.title), MAX_TITLE_CHARS);
          const text = clip(asString(section.text), 600);
          if (!text) return "";
          return title ? `${title}：${text}` : text;
        })
        .filter(Boolean)
        .join("\n"),
      MAX_BODY_CHARS,
    );
  }
  if (!body) return null;
  const fallbackTitle = chapterId
    ? `${chapterTitles.get(chapterId) ?? chapterId} · 档案`
    : "章节档案";
  const title = clip(asString(record.title) || fallbackTitle, MAX_TITLE_CHARS);
  return { ...(chapterId ? { chapterId } : {}), title, body };
}

function normalizeDraftPlace(
  record: Record<string, unknown>,
  bookChapterIds: ReadonlySet<string>,
): DraftPlace | null {
  const name = clip(asString(record.name), MAX_TITLE_CHARS);
  if (!name) return null;
  const lon = finiteNumber(record.lon);
  const lat = finiteNumber(record.lat);
  // 没有合法坐标的地点无法进入地图：直接丢弃（不写入假坐标）。
  if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    return null;
  }
  const chapterIds = stringArray(record.chapterIds)
    .concat(stringArray(record.articleIds))
    .filter((chapterId) => bookChapterIds.has(chapterId));
  return {
    id: normalizePlaceId(asString(record.id), name),
    name,
    lon,
    lat,
    description: clip(
      asString(record.description) || asString(record.note),
      MAX_DESCRIPTION_CHARS,
    ),
    chapterIds: [...new Set(chapterIds)],
  };
}

function normalizeDraftEvent(
  record: Record<string, unknown>,
  bookChapterIds: ReadonlySet<string>,
): DraftEvent | null {
  const title = clip(asString(record.title), MAX_TITLE_CHARS);
  if (!title) return null;
  const eventDate = normalizeEventDate(record.date);
  if (!eventDate) return null;
  const chapterIds = stringArray(record.chapterIds)
    .concat(stringArray(record.articleIds))
    .filter((chapterId) => bookChapterIds.has(chapterId));
  const placeIds = stringArray(record.placeIds)
    .map((placeId) => normalizePlaceId(placeId, placeId))
    .filter(Boolean);
  return {
    id: normalizeEventId(asString(record.id), eventDate.date, title),
    date: eventDate.date,
    dateLabel: eventDate.dateLabel,
    title,
    summary: clip(asString(record.summary) || asString(record.body), 400),
    chapterIds: [...new Set(chapterIds)],
    placeIds: [...new Set(placeIds)],
    importance: clampInt(record.importance, 1, 5, 3),
  };
}

function parseBatchDraft(
  text: string,
  bookChapterIds: ReadonlySet<string>,
  batchChapterIds: ReadonlySet<string>,
  chapterTitles: ReadonlyMap<string, string>,
): BatchDraft {
  const record = parseModelJson(text, "撰写结果");
  return {
    digests: recordArray(record.digests)
      .map((item) => normalizeDraftDigest(item, batchChapterIds))
      .filter((item): item is DraftDigest => item !== null),
    archives: recordArray(record.archives)
      .map((item) => normalizeDraftArchive(item, bookChapterIds, chapterTitles))
      .filter((item): item is DraftArchive => item !== null),
    places: recordArray(record.places)
      .map((item) => normalizeDraftPlace(item, bookChapterIds))
      .filter((item): item is DraftPlace => item !== null),
    events: recordArray(record.events)
      .map((item) => normalizeDraftEvent(item, bookChapterIds))
      .filter((item): item is DraftEvent => item !== null),
  };
}

interface ReviewVerdict {
  pass: boolean;
  issues: string[];
}

function parseReviewVerdict(text: string): ReviewVerdict {
  const record = parseModelJson(text, "审查结果");
  const pass = record.pass === true || record.pass === "true";
  const issues = stringArray(record.issues)
    .map((issue) => clip(issue, MAX_ISSUE_CHARS))
    .slice(0, MAX_REVIEW_ISSUES);
  if (!pass && issues.length === 0) {
    issues.push("审查未给出具体问题，请核对内容是否只依据章节原文");
  }
  return { pass, issues };
}

// ---------------------------------------------------------------------------
// 累积数据（place/event）与最终写入 payload
// ---------------------------------------------------------------------------

interface AccumulatedPlace extends DraftPlace {}

interface AccumulatedEvent extends DraftEvent {}

interface BuildAccumulators {
  places: Map<string, AccumulatedPlace>;
  events: Map<string, AccumulatedEvent>;
  /** place 名称 → id，跨批合并同名地点，避免重复落库。 */
  placeIdByName: Map<string, string>;
  /** event 日期+标题 → id，跨批合并同一事件。 */
  eventIdByKey: Map<string, string>;
}

function uniqueUnion(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

function mergePlace(accumulators: BuildAccumulators, place: DraftPlace): void {
  const nameKey = normalizeTitleForDedupe(place.name);
  const existingId = accumulators.placeIdByName.get(nameKey);
  const targetId = existingId ?? place.id;
  if (existingId && existingId !== place.id) {
    // 同名不同 id：并入先出现的 id，保持地图数据稳定。
    accumulators.placeIdByName.set(nameKey, existingId);
  } else {
    accumulators.placeIdByName.set(nameKey, targetId);
  }
  const existing = accumulators.places.get(targetId);
  if (existing) {
    existing.chapterIds = uniqueUnion(existing.chapterIds, place.chapterIds);
    if (place.description && !existing.description) existing.description = place.description;
    return;
  }
  accumulators.places.set(targetId, {
    ...place,
    id: targetId,
    chapterIds: [...new Set(place.chapterIds)],
  });
}

function mergeEvent(accumulators: BuildAccumulators, event: DraftEvent): void {
  const key = `${event.date}\u0000${normalizeTitleForDedupe(event.title)}`;
  const existingId = accumulators.eventIdByKey.get(key);
  const targetId = existingId ?? event.id;
  accumulators.eventIdByKey.set(key, targetId);
  const existing = accumulators.events.get(targetId);
  if (existing) {
    existing.chapterIds = uniqueUnion(existing.chapterIds, event.chapterIds);
    existing.placeIds = uniqueUnion(existing.placeIds, event.placeIds);
    if (!existing.summary && event.summary) existing.summary = event.summary;
    return;
  }
  accumulators.events.set(targetId, {
    ...event,
    id: targetId,
    chapterIds: [...new Set(event.chapterIds)],
    placeIds: [...new Set(event.placeIds)],
  });
}

function buildPlaceBody(place: AccumulatedPlace): string {
  if (place.description) return place.description;
  const lon = Math.round(place.lon * 10000) / 10000;
  const lat = Math.round(place.lat * 10000) / 10000;
  return `坐标约 ${lon}, ${lat}。`;
}

function buildTopicsMap(
  bookId: string,
  places: readonly AccumulatedPlace[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    bookId,
    generatedAt: new Date().toISOString(),
    themes: [{ id: AGENT_THEME_ID, name: AGENT_THEME_NAME, color: AGENT_THEME_COLOR }],
    places: places.map((place) => ({
      id: place.id,
      name: place.name,
      lon: place.lon,
      lat: place.lat,
      themes: [AGENT_THEME_ID],
      ...(place.description ? { description: place.description } : {}),
    })),
    routes: { type: "FeatureCollection", features: [] },
  };
}

function buildTopicsTimeline(
  bookId: string,
  events: readonly AccumulatedEvent[],
  knownPlaceIds: ReadonlySet<string>,
): Record<string, unknown> {
  const enabledArticleIds = [...new Set(events.flatMap((event) => event.chapterIds))];
  return {
    schemaVersion: 1,
    bookId,
    generatedAt: new Date().toISOString(),
    config: { note: AGENT_THEME_NAME, enabledArticleIds },
    events: events.map((event) => ({
      id: event.id,
      date: event.date,
      dateLabel: event.dateLabel,
      title: event.title,
      summary: event.summary,
      articleIds: event.chapterIds,
      placeIds: event.placeIds.filter((placeId) => knownPlaceIds.has(placeId)),
      importance: event.importance,
    })),
  };
}

/** 每章 explore 投影：只包含有地点/事件关联的章节。 */
function buildExplores(
  chapterIds: readonly string[],
  accumulators: BuildAccumulators,
  includeMap: boolean,
  includeTimeline: boolean,
): AgentExploreWrite[] {
  const placeIdsByChapter = new Map<string, string[]>();
  const eventIdsByChapter = new Map<string, string[]>();
  if (includeMap) {
    for (const place of accumulators.places.values()) {
      for (const chapterId of place.chapterIds) {
        placeIdsByChapter.set(chapterId, [
          ...(placeIdsByChapter.get(chapterId) ?? []),
          place.id,
        ]);
      }
    }
  }
  if (includeTimeline) {
    for (const event of accumulators.events.values()) {
      for (const chapterId of event.chapterIds) {
        eventIdsByChapter.set(chapterId, [
          ...(eventIdsByChapter.get(chapterId) ?? []),
          event.id,
        ]);
      }
    }
  }
  const explores: AgentExploreWrite[] = [];
  for (const chapterId of chapterIds) {
    const placeIds = [...new Set(placeIdsByChapter.get(chapterId) ?? [])];
    const eventIds = [...new Set(eventIdsByChapter.get(chapterId) ?? [])];
    if (placeIds.length === 0 && eventIds.length === 0) continue;
    explores.push({
      chapterId,
      map:
        placeIds.length > 0
          ? { placeIds, routeIds: [], themeIds: [AGENT_THEME_ID], focus: null }
          : null,
      timeline: eventIds.length > 0 ? { eventIds } : null,
    });
  }
  return explores;
}

// ---------------------------------------------------------------------------
// 章节加载
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 按 TOC 顺序加载章节正文（并发 4）；单章失败跳过，不阻塞整本书。 */
async function loadChapters(
  library: Library,
  bookId: string,
  flatChapters: readonly FlatChapter[],
  signal?: AbortSignal,
): Promise<Chapter[]> {
  const loaded = await mapWithConcurrency(
    flatChapters,
    CHAPTER_LOAD_CONCURRENCY,
    async (flat) => {
      throwIfAborted(signal);
      try {
        return await library.getChapter(bookId, flat.chapterId);
      } catch {
        return null;
      }
    },
  );
  return loaded.filter((chapter): chapter is Chapter => chapter !== null);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 运行一次导入构建。
 *
 * @throws ImportBuildError（code=AGENT_NOT_CONFIGURED）未配置 AGENT Key 时抛错，由 UI 引导配置；
 * 其余失败（模型/JSON/写入/取消）不抛错，而是回传 `completed=false` 的结果并保留已完成内容。
 */
export async function runImportBuild(options: RunImportBuildOptions): Promise<BuildResult> {
  const { library, book, signal } = options;
  const state = {
    savedDigests: 0,
    savedArchives: 0,
    savedPlaces: 0,
    savedEvents: 0,
    /** 是否发生过任何写入（决定是否失效缓存）。 */
    wrote: false,
  };
  const accumulators: BuildAccumulators = {
    places: new Map(),
    events: new Map(),
    placeIdByName: new Map(),
    eventIdByKey: new Map(),
  };
  const selected = normalizeSelection(options.selected);
  const selectedSet = new Set(selected);
  const dedupe = new Set<string>();

  let batchCount = 0;
  let currentBatch = 0;

  const emit = (
    role: BuildMessage["role"],
    text: string,
    tone: BuildMessageTone = "normal",
  ): void => {
    options.onMessage({
      id: createAgentId("build-msg"),
      role,
      text,
      tone,
    });
  };

  const emitProgress = (batchIndex: number): void => {
    const progress: BuildProgress = {
      batchIndex,
      batchCount,
      savedDigests: state.savedDigests,
      savedArchives: state.savedArchives,
      // place/event 先累积、最后统一写；进度里给出「已接受待写入」数量。
      savedPlaces: accumulators.places.size,
      savedEvents: accumulators.events.size,
    };
    options.onProgress(progress);
  };

  const buildResult = (
    completed: boolean,
    failedBatch?: BuildFailedBatch,
  ): BuildResult => ({
    completed,
    savedDigests: state.savedDigests,
    savedArchives: state.savedArchives,
    savedPlaces: state.savedPlaces,
    savedEvents: state.savedEvents,
    ...(failedBatch ? { failedBatch } : {}),
  });

  /** 每个角色独立发一条 user 消息：角色指令 + JSON 输入（不传 system）。 */
  const callRole = async (rolePrompt: string, payload: unknown): Promise<string> => {
    throwIfAborted(signal);
    const text = `${rolePrompt}\n\n输入：\n${JSON.stringify(payload)}`;
    const result = await sendAgentChat({
      messages: [
        {
          id: createAgentId("build-agent"),
          role: "user",
          text,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    throwIfAborted(signal);
    return typeof result.text === "string" ? result.text : "";
  };

  try {
    // 1. 前置校验：未选条目 / 未配置 Key / 无章节。
    if (selected.length === 0) {
      emit("lead", "未选择任何构建条目，已停止。", "error");
      return buildResult(false, { index: 0, reason: "未选择构建条目" });
    }

    let agentConfigured = false;
    try {
      const status = await fetchAgentConfig();
      agentConfigured = status.configured;
    } catch (error) {
      throw new ImportBuildError(
        "AGENT_STATUS_FAILED",
        `无法读取 AGENT 配置状态：${errorMessage(error)}`,
      );
    }
    if (!agentConfigured) {
      // 契约要求：无 Key 时抛错，由 UI 禁用开始并引导配置。
      throw new ImportBuildError(
        "AGENT_NOT_CONFIGURED",
        "尚未配置 AGENT Key，无法开始构建。请先在设置中填写 API Key。",
      );
    }

    throwIfAborted(signal);
    const selectedTitles = selected.map((id) => buildItemTitle(id)).join("、");
    emit("lead", `Lead：正在准备《${book.title}》的「${selectedTitles}」构建……`);

    const toc = await library.getToc(book.id);
    const flatChapters = flattenChapters(toc);
    if (flatChapters.length === 0) {
      emit("lead", "这本书没有可构建的章节。", "error");
      return buildResult(false, { index: 0, reason: "书籍没有可构建的章节" });
    }

    const chapters = await loadChapters(library, book.id, flatChapters, signal);
    if (chapters.length === 0) {
      emit("lead", "章节正文加载失败，未获取到任何章节。", "error");
      return buildResult(false, { index: 0, reason: "章节正文加载失败" });
    }
    const missingChapters = flatChapters.length - chapters.length;
    emit(
      "lead",
      `Lead：已加载 ${chapters.length}/${flatChapters.length} 章${missingChapters > 0 ? `（${missingChapters} 章正文缺失，已跳过）` : ""}。`,
      "success",
    );

    const bookChapterIds = new Set(chapters.map((chapter) => chapter.id));
    const chapterTitles = new Map(chapters.map((chapter) => [chapter.id, chapter.title]));

    // 2. 去重集合：读取现有知识条目（type+title）；读取失败时按空集合继续并提示。
    try {
      const existing = await library.listKnowledge(book.id);
      for (const entry of existing) dedupe.add(dedupeKey(entry.type, entry.title));
    } catch (error) {
      emit(
        "lead",
        `Lead：读取已有知识失败，写入时按无重复处理（${errorMessage(error)}）。`,
        "normal",
      );
    }

    batchCount = Math.ceil(chapters.length / BATCH_SIZE);
    emitProgress(0);

    // 3. Lead 计划（基础 2 次调用之一）。
    emit("lead", "Lead：正在制定分批构建计划……");
    const plan = parseLeadPlan(
      await callRole(LEAD_PROMPT, {
        mode: "plan",
        book: { title: book.title, author: book.author ?? "" },
        requiredItems: selected,
        chapterCount: chapters.length,
        batchCount,
        chapters: chapters.map((chapter) => ({
          chapterId: chapter.id,
          title: chapter.title,
        })),
      }),
    );
    if (plan.warnings.length > 0) {
      emit("lead", `Lead 提醒：${plan.warnings.join("；")}`, "normal");
    }
    emit(
      "lead",
      `Lead：计划已就绪，共 ${batchCount} 批（每批最多 ${BATCH_SIZE} 章）。`,
      "success",
    );

    // 4. 逐批：研究员 → 撰写 → 审查（失败修订一次再审查）。
    for (let index = 0; index < batchCount; index += 1) {
      currentBatch = index;
      throwIfAborted(signal);
      emitProgress(index);
      const batch = chapters.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE);
      const batchChapterIds = new Set(batch.map((chapter) => chapter.id));
      const batchLabel = `第 ${index + 1}/${batchCount} 批（${batch.length} 章）`;
      const planFocus = plan.batchFocus[index] ?? plan.strategy;

      // 4.1 研究员
      emit("researcher", `研究员：正在分析${batchLabel}……`);
      const notes = parseResearcherNotes(
        await callRole(RESEARCHER_PROMPT, {
          book: { title: book.title, author: book.author ?? "" },
          batchIndex: index + 1,
          batchCount,
          planFocus,
          chapters: batch.map((chapter) => ({
            chapterId: chapter.id,
            title: chapter.title,
            excerpt: chapterExcerpt(chapter),
          })),
        }),
        batchChapterIds,
      );

      const writerPayload = {
        book: { title: book.title, author: book.author ?? "" },
        batchIndex: index + 1,
        batchCount,
        requiredItems: selected,
        chapters: batch.map((chapter) => ({ chapterId: chapter.id, title: chapter.title })),
        notes: notes.chapters,
      };
      const reviewerPayloadFor = (draft: BatchDraft) => ({
        book: { title: book.title, author: book.author ?? "" },
        batchIndex: index + 1,
        requiredItems: selected,
        chapters: batch.map((chapter) => ({
          chapterId: chapter.id,
          title: chapter.title,
          excerpt: chapterExcerpt(chapter),
        })),
        draft,
      });

      // 4.2 撰写
      emit("writer", `撰写：正在整理${batchLabel}内容……`);
      let draft = parseBatchDraft(
        await callRole(WRITER_PROMPT, writerPayload),
        bookChapterIds,
        batchChapterIds,
        chapterTitles,
      );

      // 4.3 审查（不通过 → 撰写带 issues 修订一次 → 再审查；仍不通过则停止）
      emit("reviewer", `审查：正在核对${batchLabel}……`);
      let verdict = parseReviewVerdict(
        await callRole(REVIEWER_PROMPT, reviewerPayloadFor(draft)),
      );
      if (!verdict.pass) {
        emit(
          "reviewer",
          `审查：${batchLabel}未通过——${verdict.issues.join("；")}`,
          "review",
        );
        emit("writer", `撰写：根据审查意见修订${batchLabel}……`);
        draft = parseBatchDraft(
          await callRole(WRITER_PROMPT, {
            ...writerPayload,
            revision: { issues: verdict.issues },
          }),
          bookChapterIds,
          batchChapterIds,
          chapterTitles,
        );
        emit("reviewer", `审查：正在复核${batchLabel}的修订……`);
        verdict = parseReviewVerdict(
          await callRole(REVIEWER_PROMPT, reviewerPayloadFor(draft)),
        );
        if (!verdict.pass) {
          throw new ImportBuildError(
            "REVIEW_FAILED",
            `审查未通过：${verdict.issues.join("；")}`,
          );
        }
        emit("reviewer", `审查：${batchLabel}修订后通过。`, "success");
      } else {
        emit("reviewer", `审查：${batchLabel}通过。`, "success");
      }

      // 4.4 立即落库（digest / archive），place/event 累积
      if (selectedSet.has("digest")) {
        for (const chapter of batch) {
          const base = buildChapterDigest(book.id, chapter, []);
          const draftDigest = draft.digests.find((item) => item.chapterId === chapter.id);
          const chapterPlaceIds = [...accumulators.places.values()]
            .filter((place) => place.chapterIds.includes(chapter.id))
            .map((place) => place.id)
            .concat(
              selectedSet.has("place")
                ? draft.places
                    .filter((place) => place.chapterIds.includes(chapter.id))
                    .map((place) => place.id)
                : [],
            );
          const digest = draftDigest
            ? mergeModelDigest(base, draftDigest, [...new Set(chapterPlaceIds)])
            : base;
          await library.saveChapterDigest(digest);
          state.savedDigests += 1;
          state.wrote = true;
        }
      }

      if (selectedSet.has("archive")) {
        for (const archive of draft.archives) {
          const key = dedupeKey("note", archive.title);
          if (dedupe.has(key)) continue;
          const chapterId =
            archive.chapterId && bookChapterIds.has(archive.chapterId)
              ? archive.chapterId
              : undefined;
          const entry: Omit<KnowledgeEntry, "id" | "createdAt"> = {
            bookId: book.id,
            ...(chapterId ? { chapterId } : {}),
            type: "note",
            title: archive.title,
            body: archive.body,
            payload: {
              schemaVersion: 1,
              kind: "agent-archive",
              chapterId: chapterId ?? null,
              batch: index,
              source: "import-build",
            },
          };
          await library.addKnowledge(entry);
          dedupe.add(key);
          state.savedArchives += 1;
          state.wrote = true;
        }
      }

      if (selectedSet.has("place")) {
        for (const place of draft.places) mergePlace(accumulators, place);
      }
      if (selectedSet.has("timeline")) {
        for (const event of draft.events) mergeEvent(accumulators, event);
      }

      emitProgress(index + 1);
      emit(
        "lead",
        `已完成 ${batchLabel}：新增摘要 ${state.savedDigests} 章、档案 ${state.savedArchives} 条。`,
        "success",
      );
    }

    // 5. Lead 终审（基础 2 次调用之一）。终审是质量复核：调用失败不阻断已通过批次的数据写入。
    currentBatch = batchCount;
    emit("lead", "Lead：正在终审全部分批结果……");
    let leadIssues: string[] = [];
    try {
      const verdictRecord = parseModelJson(
        await callRole(LEAD_PROMPT, {
          mode: "final",
          book: { title: book.title, author: book.author ?? "" },
          requiredItems: selected,
          chapterCount: chapters.length,
          batchCount,
          stats: {
            savedDigests: state.savedDigests,
            savedArchives: state.savedArchives,
            places: accumulators.places.size,
            events: accumulators.events.size,
          },
          samples: {
            places: [...accumulators.places.values()].slice(0, 30).map((place) => ({
              name: place.name,
              chapters: place.chapterIds.length,
            })),
            events: [...accumulators.events.values()]
              .slice(0, 40)
              .map((event) => ({ date: event.date, title: event.title })),
          },
        }),
        "Lead 终审",
      );
      const pass = verdictRecord.pass === true || verdictRecord.pass === "true";
      leadIssues = stringArray(verdictRecord.issues)
        .map((issue) => clip(issue, MAX_ISSUE_CHARS))
        .slice(0, MAX_REVIEW_ISSUES);
      if (pass) {
        emit("lead", "Lead：终审通过。", "success");
      } else {
        emit(
          "lead",
          `Lead：终审提出 ${leadIssues.length} 条说明（不阻断写入）${leadIssues.length > 0 ? `——${leadIssues.join("；")}` : ""}。`,
          "review",
        );
      }
    } catch (error) {
      // 终审只是质量复核：失败时保留已通过批次的数据并继续写入，避免用户白付模型费用。
      emit(
        "lead",
        `Lead：终审调用失败（${errorMessage(error)}），按分批审查结果继续写入。`,
        "error",
      );
    }

    // 6. 写入 place/timeline 知识条目与 topics/explore。
    if (selectedSet.has("place") || selectedSet.has("timeline")) {
      throwIfAborted(signal);
      const places = [...accumulators.places.values()];
      const events = [...accumulators.events.values()];
      const knownPlaceIds = new Set(places.map((place) => place.id));

      // 写入前重新读取已有知识，避免与本次批次写入/旧数据重复（type+title 去重）。
      try {
        const existing = await library.listKnowledge(book.id);
        for (const entry of existing) dedupe.add(dedupeKey(entry.type, entry.title));
      } catch (error) {
        emit(
          "lead",
          `Lead：读取已有知识失败，按无重复处理（${errorMessage(error)}）。`,
          "normal",
        );
      }

      if (selectedSet.has("place")) {
        for (const place of places) {
          const key = dedupeKey("place", place.name);
          if (dedupe.has(key)) continue;
          await library.addKnowledge({
            bookId: book.id,
            ...(place.chapterIds[0] ? { chapterId: place.chapterIds[0] } : {}),
            type: "place",
            title: place.name,
            body: buildPlaceBody(place),
            payload: {
              schemaVersion: 1,
              kind: "map-place",
              placeId: place.id,
              chapterIds: place.chapterIds,
              lon: place.lon,
              lat: place.lat,
              themeIds: [AGENT_THEME_ID],
            },
          });
          dedupe.add(key);
          state.savedPlaces += 1;
          state.wrote = true;
        }
      }

      if (selectedSet.has("timeline")) {
        for (const event of events) {
          const key = dedupeKey("timeline", event.title);
          if (dedupe.has(key)) continue;
          await library.addKnowledge({
            bookId: book.id,
            ...(event.chapterIds[0] ? { chapterId: event.chapterIds[0] } : {}),
            type: "timeline",
            title: event.title,
            body: event.summary,
            payload: {
              schemaVersion: 1,
              kind: "timeline-event",
              eventId: event.id,
              date: event.date,
              dateLabel: event.dateLabel,
              chapterIds: event.chapterIds,
              placeIds: event.placeIds.filter((placeId) => knownPlaceIds.has(placeId)),
            },
          });
          dedupe.add(key);
          state.savedEvents += 1;
          state.wrote = true;
        }
      }

      const explores = buildExplores(
        chapters.map((chapter) => chapter.id),
        accumulators,
        selectedSet.has("place"),
        selectedSet.has("timeline"),
      );
      const knowledgeWrite: AgentKnowledgeWrite = {
        map:
          selectedSet.has("place") && places.length > 0
            ? buildTopicsMap(book.id, places)
            : null,
        timeline:
          selectedSet.has("timeline") && events.length > 0
            ? buildTopicsTimeline(book.id, events, knownPlaceIds)
            : null,
        explores,
      };

      if (knowledgeWrite.map || knowledgeWrite.timeline || explores.length > 0) {
        const applied = await applyAgentKnowledge(library, book.id, knowledgeWrite);
        state.wrote = true;
        emit(
          "lead",
          `Lead：地图/时间线已合并（地点 ${applied.places}、事件 ${applied.events}、章节探索 ${applied.explores}）。`,
          "success",
        );
      }

      emitProgress(batchCount);
      emit(
        "lead",
        `构建完成：新增摘要 ${state.savedDigests} 章、档案 ${state.savedArchives} 条、地点 ${state.savedPlaces} 个、时间线 ${state.savedEvents} 条。`,
        "success",
      );
    } else {
      emit(
        "lead",
        `构建完成：新增摘要 ${state.savedDigests} 章、档案 ${state.savedArchives} 条。`,
        "success",
      );
    }

    return buildResult(true);
  } catch (error) {
    if (error instanceof ImportBuildError && error.code === "AGENT_NOT_CONFIGURED") {
      // 契约：无 Key 抛错，由 UI 引导配置。
      throw error;
    }
    const aborted =
      signal?.aborted === true ||
      (error instanceof ImportBuildError && error.code === "ABORTED");
    const reason = aborted ? "已取消" : errorMessage(error);
    emit(
      "lead",
      aborted
        ? "构建已取消，已完成的内容已保留。"
        : `构建中断：${reason}。已完成的内容已保留。`,
      "error",
    );
    const failedIndex = Math.min(currentBatch, Math.max(0, batchCount));
    return buildResult(false, { index: failedIndex, reason });
  } finally {
    // 任何写入之后都要失效缓存，否则首页知识统计/阅读器探索面板会显示旧值。
    if (state.wrote) {
      try {
        invalidateBook(book.id);
      } catch {
        // 缓存失效失败不影响构建结果。
      }
      try {
        invalidateChapterExplore(book.id);
      } catch {
        // 同上。
      }
    }
  }
}

/** 归一化选中条目：过滤非法 id、去重、按 BUILD_ITEMS 顺序。 */
function normalizeSelection(selected: readonly BuildItemId[]): BuildItemId[] {
  const seen = new Set<BuildItemId>();
  for (const id of selected) {
    if (isBuildItemId(id)) seen.add(id);
  }
  return BUILD_ITEMS.map((item) => item.id).filter((id) => seen.has(id));
}

/** 摘要合并：buildChapterDigest 基线 + 模型字段（用 mergeDynamicDigest 标记来源）。 */
function mergeModelDigest(
  base: ChapterDigest,
  draft: DraftDigest,
  placeIds: readonly string[],
): ChapterDigest {
  const keyPoints: DigestPoint[] = draft.keyPoints.map((point) => ({
    section: point.section,
    ...(point.title ? { title: point.title } : {}),
    text: point.text,
    citations: [],
  }));
  if (keyPoints.length === 0 && draft.summary) {
    keyPoints.push({ section: "overview", text: draft.summary, citations: [] });
  }
  const analysis: Pick<ChapterDigest, "keyPoints" | "writing" | "themes" | "map" | "note"> = {
    keyPoints,
  };
  if (draft.themes.length > 0) analysis.themes = draft.themes;
  const writing: NonNullable<ChapterDigest["writing"]> = {};
  if (draft.writing.date) writing.date = draft.writing.date;
  if (draft.writing.placeName) writing.placeName = draft.writing.placeName;
  if (Object.keys(writing).length > 0) analysis.writing = writing;
  if (placeIds.length > 0) analysis.map = { placeIds: [...placeIds] };
  return mergeDynamicDigest(base, analysis);
}

/** 调用 `applyAgentKnowledge`（Rust 新命令）；旧运行时缺少接口时给出可读错误。 */
async function applyAgentKnowledge(
  library: Library,
  bookId: string,
  payload: AgentKnowledgeWrite,
): Promise<AgentKnowledgeWriteResult> {
  const apply = library.applyAgentKnowledge;
  if (typeof apply !== "function") {
    throw new ImportBuildError(
      "UNSUPPORTED",
      "当前运行时缺少 applyAgentKnowledge 接口，无法写入地图/时间线数据",
    );
  }
  return apply.call(library, bookId, payload);
}
