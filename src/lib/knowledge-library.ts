import type { BookMeta, KnowledgeEntry, Library, TocNode } from "@jusong/core";

import {
  cacheBookChapterTitles,
  getCachedBookKnowledgeSnapshot,
  loadBookKnowledgeSnapshot,
} from "./knowledge-cache";
import type {
  BookKnowledgeSnapshot,
  KnowledgeArchiveProjection,
  KnowledgeDigestProjection,
} from "./knowledge-cache";
import { sortArchives } from "./knowledge";
import type { LegacyDossierPayload } from "./knowledge";

/**
 * 首页「知识」总览的数据层：把每本书的两类知识来源合并成可展示的卡片。
 *
 * 数据来源都经 @jusong/core 的 Library 读取（不直接读文件），但统一走 `knowledge-cache.ts`
 * 的内存会话缓存：
 * - 档案：`library.listKnowledge(bookId)`，即 shared/archives.json 的条目
 *   （主要是 legacy-article 等人工整理内容）；缓存只保留展示所需投影，不驻留完整 payload；
 * - 摘要：`library.listChapterDigests(bookId)`，即各章 digest.json，导入时自动生成的
 *   结构摘要（opening / keyPoints / stats 等，字段见 core 的 ChapterDigest）；缓存剔除
 *   stats/headings/citations 等长字段；
 * - 书签：`library.listBookmarks(bookId)`，用户库 bookmarks.json 的阅读现场记录；
 *   **只缓存数量**，作为独立计数展示，不是知识条目（不进 typeCounts / total，阅读器知识面板也不显示）。
 *
 * 口径（已与用户确认）：
 * - 首页「知识」统计**算入自动摘要**，但档案与摘要必须分类展示、分别计数；
 * - 阅读器左栏「知识库」（components/reader/KnowledgeSearchPanel.tsx）**只显示人工档案与
 *   AGENT 笔记**，复用同一份缓存投影（`loadReaderArchives`）；
 * - 阅读器「当前章摘要 / 档案详情弹窗」等需要完整 payload 的路径仍走原 Library 调用，不回退缓存。
 *
 * 排序：先按 chapterId 字典序（种子书形如 v1-0101，可还原阅读顺序），同章内档案在前、
 * 摘要在后；没有 chapterId 的条目排在最后。去重按卡片 id。
 */

/** 知识库条目的来源分类：人工档案 / 自动生成的结构摘要。 */
export type KnowledgeCardKind = "archive" | "digest";

export interface KnowledgeCard {
  /** 书内唯一：档案用 KnowledgeEntry.id，摘要用 `digest:<chapterId>`。 */
  id: string;
  kind: KnowledgeCardKind;
  /** 档案为 KnowledgeEntry.type（如 legacy-article）；摘要固定为 "digest"。 */
  type: string;
  title: string;
  body: string;
  chapterId?: string;
  chapterTitle?: string;
  createdAt?: string;
}

export interface KnowledgeBookSummary {
  book: BookMeta;
  archiveCount: number;
  digestCount: number;
  /** 档案 + 摘要总数；书签不计入（书签不是知识条目）。 */
  total: number;
  /** 该书阅读书签数；仅统计展示，不计入 total / typeCounts。 */
  bookmarkCount: number;
  /** 有档案或摘要的章节数（按 chapterId 去重）。 */
  chapterCount: number;
  /** 档案 type 与 "digest" 的条目数分布。 */
  typeCounts: Record<string, number>;
}

/** 类型徽标文案：类型值来自数据，展示时不直接抛英文 key。 */
export const KNOWLEDGE_TYPE_LABEL: Record<string, string> = {
  "legacy-article": "人工档案",
  "legacy-topic": "专题档案",
  search: "检索记录",
  note: "AGENT",
  digest: "结构摘要",
  /** 探索数据生成的条目（首页知识/检索可见，阅读器左栏不显示）。 */
  place: "地图地点",
  timeline: "时间线",
};

export function knowledgeTypeLabel(type: string): string {
  return KNOWLEDGE_TYPE_LABEL[type] ?? type;
}

/** 摘要条目的展示类型；archive 条目直接用 entry.type。 */
export const DIGEST_KNOWLEDGE_TYPE = "digest";

function warn(message: string, error: unknown): void {
  console.warn(`[jusong] ${message}`, error);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipText(text: string, max: number): string {
  const clean = collapseWhitespace(text);
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

function countType(counts: Record<string, number>, type: string): void {
  const key = type.trim() || "unknown";
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * 书内卡片排序：chapterId 字典序 → 同章档案在前 → 标题。
 * 种子书 chapterId（v1-0101）按字典序即为阅读顺序，不依赖 toc。
 */
function compareCards(left: KnowledgeCard, right: KnowledgeCard): number {
  const leftKey = left.chapterId ?? "\uffff";
  const rightKey = right.chapterId ?? "\uffff";
  const byChapter = leftKey.localeCompare(rightKey, "en");
  if (byChapter !== 0) return byChapter;
  if (left.kind !== right.kind) return left.kind === "archive" ? -1 : 1;
  return left.title.localeCompare(right.title, "zh-Hans-CN");
}

/** 摘要卡片正文：keyPoints 前两条文本；没有要点时回退 opening / closing。 */
function digestBody(digest: KnowledgeDigestProjection): string {
  const points = digest.keyPoints
    .slice(0, 2)
    .map((point) => collapseWhitespace(point.text ?? ""))
    .filter(Boolean);
  if (points.length > 0) return clipText(points.join("；"), 320);
  const fallback = [digest.opening, digest.closing]
    .map((part) => (part ?? "").trim())
    .find(Boolean);
  return fallback ? clipText(fallback, 320) : "";
}

function collectChapterTitles(nodes: readonly TocNode[], into: Map<string, string>): void {
  for (const node of nodes) {
    if (node.chapterId && !into.has(node.chapterId)) {
      into.set(node.chapterId, node.title);
    }
    if (node.children?.length) collectChapterTitles(node.children, into);
  }
}

/** 章节 id → 章节标题：用于档案条目显示章节名（摘要条目自带 title）。 */
async function loadChapterTitles(library: Library, bookId: string): Promise<Map<string, string>> {
  try {
    const toc = await library.getToc(bookId);
    const titles = new Map<string, string>();
    collectChapterTitles(toc, titles);
    return titles;
  } catch (error) {
    warn(`读取目录失败，档案将只显示章节 id（${bookId}）：`, error);
    return new Map<string, string>();
  }
}

function digestTitlesOf(snapshot: BookKnowledgeSnapshot): Map<string, string> {
  const titles = new Map<string, string>();
  for (const digest of snapshot.digests) {
    if (digest.chapterId && !titles.has(digest.chapterId)) titles.set(digest.chapterId, digest.title);
  }
  return titles;
}

function chapterTitleResolver(
  snapshot: BookKnowledgeSnapshot,
  tocTitles?: ReadonlyMap<string, string>,
): (chapterId: string | undefined) => string | undefined {
  const digestTitles = digestTitlesOf(snapshot);
  const cachedTitles = snapshot.chapterTitles;
  return (chapterId) => {
    if (!chapterId) return undefined;
    return tocTitles?.get(chapterId) ?? cachedTitles?.[chapterId] ?? digestTitles.get(chapterId);
  };
}

/** 缓存投影 → 书内知识卡片（档案在前、摘要在后，按章节排序）。 */
function cardsFromSnapshot(
  snapshot: BookKnowledgeSnapshot,
  tocTitles?: ReadonlyMap<string, string>,
): KnowledgeCard[] {
  const titleOf = chapterTitleResolver(snapshot, tocTitles);
  const seen = new Set<string>();
  const cards: KnowledgeCard[] = [];

  const push = (card: KnowledgeCard): void => {
    if (seen.has(card.id)) return;
    seen.add(card.id);
    cards.push(card);
  };

  for (const archive of snapshot.archives) {
    const chapterId = archive.chapterId || undefined;
    const chapterTitle = titleOf(chapterId);
    push({
      id: archive.id,
      kind: "archive",
      type: archive.type,
      title: archive.title,
      body: archive.body,
      ...(chapterId ? { chapterId } : {}),
      ...(chapterTitle ? { chapterTitle } : {}),
      ...(archive.createdAt ? { createdAt: archive.createdAt } : {}),
    });
  }

  for (const digest of snapshot.digests) {
    push({
      id: `${DIGEST_KNOWLEDGE_TYPE}:${digest.chapterId}`,
      kind: "digest",
      type: DIGEST_KNOWLEDGE_TYPE,
      title: digest.title,
      body: digestBody(digest),
      chapterId: digest.chapterId,
      chapterTitle: digest.title,
      ...(digest.generatedAt ? { createdAt: digest.generatedAt } : {}),
    });
  }

  return cards.sort(compareCards);
}

/** 档案章节在摘要标题里缺失时才从 TOC 补章节名（并写回缓存，供同步构建复用）。 */
async function ensureChapterTitles(
  library: Library,
  bookId: string,
  snapshot: BookKnowledgeSnapshot,
): Promise<BookKnowledgeSnapshot> {
  const titleOf = chapterTitleResolver(snapshot);
  const missing = snapshot.archives.some(
    (archive) => archive.chapterId && !titleOf(archive.chapterId),
  );
  if (!missing) return snapshot;
  const tocTitles = await loadChapterTitles(library, bookId);
  if (tocTitles.size === 0) return snapshot;
  cacheBookChapterTitles(bookId, tocTitles);
  return getCachedBookKnowledgeSnapshot(bookId) ?? snapshot;
}

/** 从缓存投影统计单本书的总览摘要。 */
function summaryFromSnapshot(
  book: BookMeta,
  snapshot: BookKnowledgeSnapshot,
): KnowledgeBookSummary {
  const typeCounts: Record<string, number> = {};
  const chapterIds = new Set<string>();

  for (const archive of snapshot.archives) {
    countType(typeCounts, archive.type);
    if (archive.chapterId) chapterIds.add(archive.chapterId);
  }
  for (const digest of snapshot.digests) {
    if (digest.chapterId) chapterIds.add(digest.chapterId);
  }
  if (snapshot.digests.length > 0) typeCounts[DIGEST_KNOWLEDGE_TYPE] = snapshot.digests.length;

  const archiveCount = snapshot.archives.length;
  const digestCount = snapshot.digests.length;
  return {
    book,
    archiveCount,
    digestCount,
    total: archiveCount + digestCount,
    bookmarkCount: snapshot.bookmarkCount,
    chapterCount: chapterIds.size,
    typeCounts,
  };
}

function emptySummary(book: BookMeta): KnowledgeBookSummary {
  return {
    book,
    archiveCount: 0,
    digestCount: 0,
    total: 0,
    bookmarkCount: 0,
    chapterCount: 0,
    typeCounts: {},
  };
}

/**
 * 同步读取「全部书都已缓存」时的知识总览（缓存命中路径，不发 IPC、不闪骨架）。
 * 只要有一本书没缓存就返回 null，由调用方走 `loadKnowledgeOverview`。
 */
export function getCachedKnowledgeOverview(
  books: readonly BookMeta[],
): KnowledgeBookSummary[] | null {
  const summaries: KnowledgeBookSummary[] = [];
  for (const book of books) {
    const snapshot = getCachedBookKnowledgeSnapshot(book.id);
    if (!snapshot) return null;
    summaries.push(summaryFromSnapshot(book, snapshot));
  }
  return summaries;
}

/**
 * 首页知识总览：逐本统计档案数、摘要数、书签数、覆盖章节数与类型分布。
 *
 * - 数据走内存缓存：已缓存的书写入总览不发 IPC（第二次进入首页/账号统计不重复读取）；
 * - 单本加载失败只告警并按 0 计，不影响其他书（该本失败不写缓存，下次重试）；
 * - `onProgress` 在开始（0/total）与每本完成后回调，供 UI 显示「正在统计 n/m 本」。
 */
export async function loadKnowledgeOverview(
  library: Library,
  books: BookMeta[],
  onProgress?: (done: number, total: number) => void,
): Promise<KnowledgeBookSummary[]> {
  const total = books.length;
  onProgress?.(0, total);

  const summaries: KnowledgeBookSummary[] = [];
  for (let index = 0; index < total; index += 1) {
    const book = books[index];
    try {
      const snapshot = await loadBookKnowledgeSnapshot(library, book.id);
      summaries.push(summaryFromSnapshot(book, snapshot));
    } catch (error) {
      warn(`读取知识统计失败（${book.id}）：`, error);
      summaries.push(emptySummary(book));
    }
    onProgress?.(index + 1, total);
  }

  return summaries;
}

/** 同步读取单本书的书内卡片（缓存命中路径，避免打开书时闪骨架屏）。 */
export function getCachedBookKnowledgeCards(bookId: string): KnowledgeCard[] | null {
  const snapshot = getCachedBookKnowledgeSnapshot(bookId);
  return snapshot ? cardsFromSnapshot(snapshot) : null;
}

/**
 * 单本书的知识库条目：档案（kind=archive）在前，摘要（kind=digest）在后，
 * 统一按 chapterId 字典序排成阅读顺序，并按卡片 id 去重。数据走内存缓存。
 */
export async function loadBookKnowledge(
  library: Library,
  bookId: string,
): Promise<KnowledgeCard[]> {
  const snapshot = await loadBookKnowledgeSnapshot(library, bookId);
  const withTitles = await ensureChapterTitles(library, bookId, snapshot);
  return cardsFromSnapshot(withTitles);
}

// ---------------------------------------------------------------------------
// 阅读器左栏「知识库」：同一份档案投影（只列人工档案 + AGENT 笔记）
// ---------------------------------------------------------------------------

/**
 * 投影 → 阅读器列表用的轻量 KnowledgeEntry：
 * 只带回 period/dateText 组成的小 payload（供 archiveMeta / filterArchives 使用），
 * 不带原始 payload 的 blocks/sources 等长字段——所以检索范围是标题 + 正文 + 时期/日期。
 */
function toReaderEntry(archive: KnowledgeArchiveProjection): KnowledgeEntry {
  const payload: LegacyDossierPayload = {};
  if (archive.period) payload.period = archive.period;
  if (archive.dateText) payload.dateText = archive.dateText;
  return {
    id: archive.id,
    bookId: archive.bookId,
    ...(archive.chapterId ? { chapterId: archive.chapterId } : {}),
    type: archive.type,
    title: archive.title,
    body: archive.body,
    createdAt: archive.createdAt,
    ...(payload.period || payload.dateText ? { payload } : {}),
  };
}

/**
 * 阅读器左栏「知识库」只列有章节关联的人工档案（legacy-article）与 AGENT 保存的笔记（note）；
 * 自动生成的摘要等其他类型仍不在这里展示（首页知识视图负责分类合计）。
 */
function readerEntriesFromSnapshot(snapshot: BookKnowledgeSnapshot): KnowledgeEntry[] {
  return sortArchives(
    snapshot.archives
      .filter(
        (archive) =>
          Boolean(archive.chapterId) &&
          (archive.type === "legacy-article" || archive.type === "note"),
      )
      .map(toReaderEntry),
  );
}

/** 同步读取阅读器左栏档案列表（缓存命中路径）。 */
export function getCachedReaderArchives(bookId: string): KnowledgeEntry[] | null {
  const snapshot = getCachedBookKnowledgeSnapshot(bookId);
  return snapshot ? readerEntriesFromSnapshot(snapshot) : null;
}

/** 读取阅读器左栏档案列表（缓存未命中时只加载该书知识+摘要+书签数投影）。 */
export async function loadReaderArchives(
  library: Library,
  bookId: string,
): Promise<KnowledgeEntry[]> {
  const snapshot = await loadBookKnowledgeSnapshot(library, bookId);
  return readerEntriesFromSnapshot(snapshot);
}
