#!/usr/bin/env node
/**
 * 为每章生成 `chapters/<chapterId>/explore.json`，并幂等追加 place / timeline 知识条目。
 *
 * 契约：ChapterExplore 与知识条目的结构定义。
 *
 * 数据来源（按优先级）：
 * - 整书事实源：`shared/topics/map.json`（places / routes / themes）、`shared/topics/timeline.json`（config / events）。
 * - 人工档案：`shared/archives.json` 的 `legacy-article` 条目（payload.writing.date / payload.map.themeIds 等）。
 * - 章节投影：`chapters/<id>/map.json`（placeIds / routeIds / themeIds / focus，explore.map 直接取它）。
 * - 回退：`chapters/<id>/digest.json` 的 writing.date / themes（档案缺失时）。
 *
 * timeline.eventIds 规则（CONTRACTS §2.3 的迁移规则）：
 * 1. `event.articleIds` 包含本章 → 必选（不受时间窗/主题/importance 限制）；
 * 2. 否则写作日期存在时：事件日期落在 `[写作日期 - beforeYears, 写作日期 + afterYears]` 内，
 *    且（事件 themes 命中本章主题，或 `importance >= 3`）；
 * 3. 不再使用 `timeline.config.enabledArticleIds` 限制；
 * 4. 每章最多保留 12 条，最终按事件日期升序输出。
 *    截断时优先保留「本文相关」事件，其余按重要度降序 + 距写作日期由近到远、
 *    在「写成之前 / 之后」两侧交替取，尽量保留写作时刻前后两侧的上下文。
 *
 * 知识条目：
 * - place：`id=place-<placeId>`、`type=place`、`title=place.name`、
 *   `payload={schemaVersion:1,kind:"map-place",placeId,chapterIds,lon,lat,themeIds}`；
 * - timeline：`id=timeline-<eventId>`、`type=timeline`、`title=event.title`、`body=event.summary`、
 *   `payload={schemaVersion:1,kind:"timeline-event",eventId,date,dateLabel,chapterIds,placeIds}`；
 * - `chapterId = chapterIds[0]`，没有关联章节时为 `null`（允许）；
 * - 已存在同 id 条目：只更新 `payload.chapterIds` / `title` / `body`，其余字段与 `createdAt` 原样保留；
 *   其他既有 entries（legacy-article 等）一律不动。
 *
 * 幂等：条目按 id upsert、不重复追加；文件内容与期望一致时不写盘，连续运行两遍第二次零改动。
 *
 * 用法：
 *   node scripts/migrate-explore.mjs                  # 种子书 + data/library 开发用户库副本
 *   node scripts/migrate-explore.mjs --only seed      # 只处理种子书
 *   node scripts/migrate-explore.mjs --only library   # 只处理 dev 用户库副本
 *   node scripts/migrate-explore.mjs --dry-run        # 只统计，不写盘
 *   node scripts/migrate-explore.mjs --book-id <id> --books <dir> --library <dir>
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 参数与常量
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : fallback;
}

const BOOK_ID = flag("book-id", "maozedongxuanji-diyizhisijuan-8f9a8e47");
const BOOKS_ROOT = path.resolve(flag("books", "data/books"));
const LIBRARY_ROOT = path.resolve(flag("library", "data/library"));
const ONLY = flag("only", "all");
const DRY_RUN = argv.includes("--dry-run");

/** 数据 JSON 约定：UTF-8（无 BOM）、2 空格缩进、CRLF、结尾换行。 */
const JSON_EOL = "\r\n";
/** 每章 timeline.eventIds 上限。 */
const TIMELINE_EVENT_CAP = 12;
/** 新条目统一用同一次运行的 createdAt，便于对比与幂等。 */
const CREATED_AT = new Date().toISOString();

// ---------------------------------------------------------------------------
// 通用 JSON / 文件工具
// ---------------------------------------------------------------------------

function exists(file) {
  return fs.existsSync(file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function unique(list) {
  return [...new Set(list)];
}

function serializeJson(value) {
  return JSON.stringify(value, null, 2).replace(/\n/g, JSON_EOL) + JSON_EOL;
}

/** 只在内容变化时写盘；返回是否写入（幂等的关键：第二遍不应再写）。 */
function writeJsonIfChanged(file, value, dryRun) {
  const content = serializeJson(value);
  if (exists(file) && fs.readFileSync(file, "utf8") === content) return false;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return true;
}

// ---------------------------------------------------------------------------
// 日期工具
// ---------------------------------------------------------------------------

function parseDateParts(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 1)];
}

function compareDateParts(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

/** 目标日期按年平移（保留月/日），用于 [写作日期 - beforeYears, + afterYears] 时间窗。 */
function shiftYears(parts, deltaYears) {
  return [parts[0] + deltaYears, parts[1], parts[2]];
}

/** 与 `src/extensions/timeline.ts` 一致的日期标签：`YYYY年M月D日` / `YYYY年M月`。 */
function dateLabel(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!match) return String(value ?? "");
  const [, year, month, day] = match;
  return day ? `${year}年${Number(month)}月${Number(day)}日` : `${year}年${Number(month)}月`;
}

// ---------------------------------------------------------------------------
// 章节与整书数据装载
// ---------------------------------------------------------------------------

/** 按 toc 叶顺序收集章节 id；缺 toc 时回退 book.chapterIds；再并上 chapters/ 目录里多出的章节。 */
function orderedChapterIds(bookDir, book) {
  const chaptersDir = path.join(bookDir, "chapters");
  const dirIds = exists(chaptersDir)
    ? fs
        .readdirSync(chaptersDir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name)
        .sort()
    : [];
  const dirSet = new Set(dirIds);

  const tocFile = path.join(bookDir, "toc.json");
  const tocChapterIds = [];
  if (exists(tocFile)) {
    const walk = (nodes) => {
      for (const node of nodes ?? []) {
        if (node && node.type === "chapter" && typeof node.chapterId === "string") tocChapterIds.push(node.chapterId);
        if (node && Array.isArray(node.children)) walk(node.children);
      }
    };
    walk(readJson(tocFile));
  }

  const ordered = [];
  const seen = new Set();
  for (const id of [...tocChapterIds, ...asStringArray(book.chapterIds), ...dirIds]) {
    if (typeof id !== "string" || !dirSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  const extraDirIds = dirIds.filter((id) => !seen.has(id));
  return { ordered, extraDirIds };
}

function loadChapterFiles(bookDir, chapterId) {
  const chapterDir = path.join(bookDir, "chapters", chapterId);
  const mapFile = path.join(chapterDir, "map.json");
  const digestFile = path.join(chapterDir, "digest.json");
  return {
    map: exists(mapFile) ? readJson(mapFile) : null,
    digest: exists(digestFile) ? readJson(digestFile) : null,
    hasMapFile: exists(mapFile),
    hasDigestFile: exists(digestFile),
  };
}

/** 章节写作日期：人工档案 payload.writing.date 优先，digest.writing.date 回退。 */
function resolveWriting(chapterFiles, archive) {
  const archiveDate = archive?.payload?.writing?.date;
  const digestDate = chapterFiles.digest?.writing?.date;
  const date =
    typeof archiveDate === "string" && archiveDate
      ? archiveDate
      : typeof digestDate === "string" && digestDate
        ? digestDate
        : null;
  const placeIds = unique([
    ...asStringArray(archive?.payload?.writing?.placeIds),
    ...asStringArray(chapterFiles.digest?.writing?.placeIds),
  ]);
  return { date, placeIds };
}

/**
 * 时间线主题匹配用的本章主题：
 * 人工档案 payload.map.themeIds（旧时间线规则实际使用的字段）→ digest.map.themeIds → digest.themes。
 */
function resolveThemeIds(chapterFiles, archive) {
  const candidates = [
    asStringArray(archive?.payload?.map?.themeIds),
    asStringArray(chapterFiles.digest?.map?.themeIds),
    asStringArray(chapterFiles.digest?.themes),
  ];
  for (const candidate of candidates) {
    if (candidate.length > 0) return unique(candidate);
  }
  return [];
}

function resolveRouteFeatures(topicsMap) {
  const routes = topicsMap?.routes;
  const features = Array.isArray(routes) ? routes : Array.isArray(routes?.features) ? routes.features : [];
  const byId = new Map();
  for (const feature of features) {
    const properties = feature?.properties;
    if (properties && typeof properties.id === "string") byId.set(properties.id, properties);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// explore.json 构造
// ---------------------------------------------------------------------------

/** map 直接取章节 map.json 的 placeIds / routeIds / themeIds / focus；无地点、路线、焦点时置 null。 */
function buildExploreMap(chapterId, chapterFiles) {
  const mapJson = chapterFiles.map ?? {};
  const placeIds = asStringArray(mapJson.placeIds);
  const routeIds = asStringArray(mapJson.routeIds);
  const themeIds = asStringArray(mapJson.themeIds);
  const rawFocus = mapJson.focus;
  const focus =
    rawFocus && Number.isFinite(Number(rawFocus.lon)) && Number.isFinite(Number(rawFocus.lat))
      ? {
          lon: Number(rawFocus.lon),
          lat: Number(rawFocus.lat),
          ...(Number.isFinite(Number(rawFocus.zoom)) ? { zoom: Number(rawFocus.zoom) } : {}),
        }
      : null;
  // 与 `src/lib/explore.ts` 的可用性判定一致：地点 / 路线 / 焦点任一非空才算有地图数据。
  if (placeIds.length === 0 && routeIds.length === 0 && focus === null) {
    if (mapJson.chapterId !== undefined && mapJson.chapterId !== chapterId) {
      // 仅记录异常，不阻塞迁移（章节归属由 data-audit 校验）。
      return { map: null, warning: "章节 map.json 归属错误" };
    }
    return { map: null, warning: null };
  }
  return { map: { placeIds, routeIds, themeIds, focus }, warning: null };
}

/**
 * 按 CONTRACTS §2.3 规则筛选本章 timeline 事件 id（最多 12 条，按事件日期升序）。
 * 详见文件头注释。
 */
function selectTimelineEventIds({ chapterId, writingDate, themeIds, events, config }) {
  const beforeYears = Number.isFinite(Number(config?.beforeYears)) ? Number(config.beforeYears) : 8;
  const afterYears = Number.isFinite(Number(config?.afterYears)) ? Number(config.afterYears) : 10;
  const written = parseDateParts(writingDate);
  const windowStart = written ? shiftYears(written, -beforeYears) : null;
  const windowEnd = written ? shiftYears(written, afterYears) : null;
  const themeSet = new Set(themeIds);

  const mandatory = [];
  const optionalBefore = [];
  const optionalAfter = [];

  for (const event of events) {
    if (!event || typeof event.id !== "string") continue;
    const date = parseDateParts(event.date);
    const specific = asStringArray(event.articleIds).includes(chapterId);
    if (specific) {
      mandatory.push({ event, date });
      continue;
    }
    if (!written || !date || !windowStart || !windowEnd) continue;
    if (compareDateParts(date, windowStart) < 0 || compareDateParts(date, windowEnd) > 0) continue;
    const themeMatch = asStringArray(event.themes).some((theme) => themeSet.has(theme));
    const importance = Number.isFinite(Number(event.importance)) ? Number(event.importance) : 1;
    if (!themeMatch && importance < 3) continue;
    const item = { event, date, importance };
    if (compareDateParts(date, written) < 0) optionalBefore.push(item);
    else optionalAfter.push(item);
  }

  // 重要度降序；同重要度时「距写作日期由近到远」（之前日期倒序、之后日期正序）。
  const byPriority = (a, b) => {
    const importanceA = Number.isFinite(Number(a.event.importance)) ? Number(a.event.importance) : 1;
    const importanceB = Number.isFinite(Number(b.event.importance)) ? Number(b.event.importance) : 1;
    if (importanceA !== importanceB) return importanceB - importanceA;
    return compareDateParts(a.date, b.date);
  };
  optionalBefore.sort((a, b) => {
    const priority = byPriority(a, b);
    if (priority !== 0) return priority;
    return compareDateParts(b.date, a.date);
  });
  optionalAfter.sort(byPriority);

  const selected = [];
  const mandatorySorted = [...mandatory].sort(byPriority);
  if (mandatorySorted.length >= TIMELINE_EVENT_CAP) {
    selected.push(...mandatorySorted.slice(0, TIMELINE_EVENT_CAP));
  } else {
    selected.push(...mandatorySorted);
    let slots = TIMELINE_EVENT_CAP - mandatorySorted.length;
    let beforeIndex = 0;
    let afterIndex = 0;
    let turn = 0;
    while (slots > 0) {
      const hasBefore = beforeIndex < optionalBefore.length;
      const hasAfter = afterIndex < optionalAfter.length;
      if (!hasBefore && !hasAfter) break;
      // 两侧都有时交替取，避免 12 条全被同一侧占满。
      if (hasBefore && hasAfter) {
        selected.push(turn % 2 === 0 ? optionalBefore[beforeIndex++] : optionalAfter[afterIndex++]);
        turn += 1;
      } else if (hasBefore) {
        selected.push(optionalBefore[beforeIndex++]);
      } else {
        selected.push(optionalAfter[afterIndex++]);
      }
      slots -= 1;
    }
  }

  selected.sort((a, b) => compareDateParts(a.date, b.date) || String(a.event.id).localeCompare(String(b.event.id)));
  return selected.map((item) => item.event.id);
}

// ---------------------------------------------------------------------------
// 知识条目构造
// ---------------------------------------------------------------------------

/** place 文案：今地名 + 说明；没有说明时退回坐标。 */
function buildPlaceBody(place) {
  const description = typeof place.description === "string" ? place.description.trim() : "";
  const modernName = typeof place.modernName === "string" ? place.modernName.trim() : "";
  if (description) return modernName ? `今${modernName}。${description}` : description;
  const lon = Number(place.lon);
  const lat = Number(place.lat);
  if (Number.isFinite(lon) && Number.isFinite(lat)) {
    return modernName ? `今${modernName}，坐标约 ${lon}, ${lat}。` : `坐标约 ${lon}, ${lat}。`;
  }
  return place.name ?? "";
}

function makePlaceEntry(bookId, place, chapterIds) {
  return {
    id: `place-${place.id}`,
    bookId,
    chapterId: chapterIds.length > 0 ? chapterIds[0] : null,
    type: "place",
    title: place.name,
    body: buildPlaceBody(place),
    createdAt: CREATED_AT,
    payload: {
      schemaVersion: 1,
      kind: "map-place",
      placeId: place.id,
      chapterIds,
      lon: place.lon,
      lat: place.lat,
      themeIds: asStringArray(place.themes),
    },
  };
}

function makeTimelineEntry(bookId, event, chapterIds) {
  return {
    id: `timeline-${event.id}`,
    bookId,
    chapterId: chapterIds.length > 0 ? chapterIds[0] : null,
    type: "timeline",
    title: event.title,
    body: event.summary,
    createdAt: CREATED_AT,
    payload: {
      schemaVersion: 1,
      kind: "timeline-event",
      eventId: event.id,
      date: event.date,
      dateLabel: dateLabel(event.date),
      chapterIds,
      placeIds: asStringArray(event.placeIds),
    },
  };
}

/**
 * 幂等 upsert：同 id 已存在时只更新 payload.chapterIds / title / body。
 * 返回 "added" | "updated" | "unchanged"。
 */
function upsertKnowledgeEntry(entries, desired) {
  const index = entries.findIndex((entry) => entry && entry.id === desired.id);
  if (index < 0) {
    entries.push(desired);
    return "added";
  }
  const current = entries[index];
  let changed = false;
  if (current.title !== desired.title) {
    current.title = desired.title;
    changed = true;
  }
  if (current.body !== desired.body) {
    current.body = desired.body;
    changed = true;
  }
  const payloadIsObject = current.payload && typeof current.payload === "object" && !Array.isArray(current.payload);
  if (payloadIsObject) {
    const currentChapterIds = asStringArray(current.payload.chapterIds);
    if (JSON.stringify(currentChapterIds) !== JSON.stringify(desired.payload.chapterIds)) {
      current.payload.chapterIds = desired.payload.chapterIds;
      changed = true;
    }
  } else {
    current.payload = desired.payload;
    changed = true;
  }
  return changed ? "updated" : "unchanged";
}

// ---------------------------------------------------------------------------
// 单本书迁移
// ---------------------------------------------------------------------------

function migrateBook(bookDir) {
  const bookFile = path.join(bookDir, "book.json");
  if (!exists(bookFile)) return { label: bookDir, skipped: "缺少 book.json" };
  const book = readJson(bookFile);
  if (typeof book.id !== "string") return { label: bookDir, skipped: "book.json 缺少 id" };
  const bookId = book.id;

  const topicsMapFile = path.join(bookDir, "shared", "topics", "map.json");
  const topicsTimelineFile = path.join(bookDir, "shared", "topics", "timeline.json");
  const archivesFile = path.join(bookDir, "shared", "archives.json");
  if (!exists(archivesFile)) return { label: bookDir, skipped: "缺少 shared/archives.json（种子/迁移数据不完整）" };

  const topicsMap = exists(topicsMapFile) ? readJson(topicsMapFile) : null;
  const topicsTimeline = exists(topicsTimelineFile) ? readJson(topicsTimelineFile) : null;
  const archives = readJson(archivesFile);
  const entries = Array.isArray(archives.entries) ? archives.entries : [];
  const entriesBefore = entries.length;
  const events = Array.isArray(topicsTimeline?.events) ? topicsTimeline.events : [];
  const places = Array.isArray(topicsMap?.places) ? topicsMap.places : [];
  const routeById = resolveRouteFeatures(topicsMap);
  const config = topicsTimeline?.config ?? {};

  const warnings = [];
  if (!topicsMap) warnings.push("缺少 shared/topics/map.json，place 知识条目不生成");
  if (!topicsTimeline) warnings.push("缺少 shared/topics/timeline.json，timeline 知识条目不生成");

  // 章节写作档案：只认 legacy-article，避免第二次运行时把 place/timeline 条目当作章节档案。
  const archiveByChapter = new Map();
  for (const entry of entries) {
    if (entry && entry.type === "legacy-article" && typeof entry.chapterId === "string") {
      archiveByChapter.set(entry.chapterId, entry);
    }
  }

  const { ordered: chapterIds, extraDirIds } = orderedChapterIds(bookDir, book);
  if (extraDirIds.length > 0) warnings.push(`chapters/ 下 ${extraDirIds.length} 个章节不在 toc/book.chapterIds：${extraDirIds.slice(0, 5).join(",")}`);
  if (chapterIds.length === 0) warnings.push("没有可处理的章节");

  const chapterOrder = new Map(chapterIds.map((id, index) => [id, index]));
  const chapterRecords = [];
  let exploreFilesWritten = 0;
  let chapterHasMap = 0;
  let chapterHasTimeline = 0;
  let chapterMissingMapFile = 0;
  let chapterMissingTimelineDate = 0;
  let timelineEventSelections = 0;
  const selectedEventChapters = new Map(); // eventId -> Set<chapterId>
  const chapterPlaceIds = new Map(); // chapterId -> Set<placeId>

  for (const chapterId of chapterIds) {
    const chapterFiles = loadChapterFiles(bookDir, chapterId);
    if (!chapterFiles.hasMapFile) chapterMissingMapFile += 1;
    const archive = archiveByChapter.get(chapterId) ?? null;
    const writing = resolveWriting(chapterFiles, archive);
    const themeIds = resolveThemeIds(chapterFiles, archive);

    const { map, warning } = buildExploreMap(chapterId, chapterFiles);
    if (warning) warnings.push(`${chapterId}: ${warning}`);

    const eventIds = selectTimelineEventIds({
      chapterId,
      writingDate: writing.date,
      themeIds,
      events,
      config,
    });
    if (!writing.date) chapterMissingTimelineDate += 1;

    const explore = {
      schemaVersion: 1,
      bookId,
      chapterId,
      map,
      timeline: eventIds.length > 0 ? { eventIds } : null,
    };
    const exploreFile = path.join(bookDir, "chapters", chapterId, "explore.json");
    if (writeJsonIfChanged(exploreFile, explore, DRY_RUN)) exploreFilesWritten += 1;
    if (map) chapterHasMap += 1;
    if (eventIds.length > 0) chapterHasTimeline += 1;
    timelineEventSelections += eventIds.length;

    for (const eventId of eventIds) {
      if (!selectedEventChapters.has(eventId)) selectedEventChapters.set(eventId, new Set());
      selectedEventChapters.get(eventId).add(chapterId);
    }

    // 本章地图投影涉及的地点：章节 map.json + 人工档案 map/writing + digest + 路线经过的地点。
    const placeIdSet = new Set();
    for (const list of [
      chapterFiles.map?.placeIds,
      archive?.payload?.map?.placeIds,
      archive?.payload?.writing?.placeIds,
      chapterFiles.digest?.map?.placeIds,
      chapterFiles.digest?.writing?.placeIds,
    ]) {
      for (const placeId of asStringArray(list)) placeIdSet.add(placeId);
    }
    const routeIdSet = new Set([
      ...asStringArray(chapterFiles.map?.routeIds),
      ...asStringArray(archive?.payload?.map?.routeIds),
      ...asStringArray(chapterFiles.digest?.map?.routeIds),
    ]);
    for (const routeId of routeIdSet) {
      const route = routeById.get(routeId);
      for (const placeId of asStringArray(route?.placeIds)) placeIdSet.add(placeId);
    }
    chapterPlaceIds.set(chapterId, placeIdSet);

    chapterRecords.push({ chapterId, writing, themeIds, map, eventIds, placeIdSet });
  }

  // ---- place 知识条目 ----
  const placeChapters = new Map(); // placeId -> chapterId[]（按 toc 顺序）
  for (const [chapterId, placeIdSet] of chapterPlaceIds) {
    for (const placeId of placeIdSet) {
      if (!placeChapters.has(placeId)) placeChapters.set(placeId, []);
      placeChapters.get(placeId).push(chapterId);
    }
  }
  const placeStats = { added: 0, updated: 0, unchanged: 0, skipped: 0, withoutChapter: 0 };
  if (topicsMap) {
    for (const place of places) {
      if (!place || typeof place.id !== "string") {
        placeStats.skipped += 1;
        continue;
      }
      const chapterIdsForPlace = (placeChapters.get(place.id) ?? [])
        .slice()
        .sort((a, b) => (chapterOrder.get(a) ?? 0) - (chapterOrder.get(b) ?? 0));
      if (chapterIdsForPlace.length === 0) placeStats.withoutChapter += 1;
      const result = upsertKnowledgeEntry(entries, makePlaceEntry(bookId, place, chapterIdsForPlace));
      placeStats[result] += 1;
    }
  }

  // ---- timeline 知识条目 ----
  const timelineStats = { added: 0, updated: 0, unchanged: 0, skipped: 0, withoutChapter: 0 };
  if (topicsTimeline) {
    for (const event of events) {
      if (!event || typeof event.id !== "string") {
        timelineStats.skipped += 1;
        continue;
      }
      const chapterIdsForEvent = [...(selectedEventChapters.get(event.id) ?? [])].sort(
        (a, b) => (chapterOrder.get(a) ?? 0) - (chapterOrder.get(b) ?? 0),
      );
      if (chapterIdsForEvent.length === 0) timelineStats.withoutChapter += 1;
      const result = upsertKnowledgeEntry(entries, makeTimelineEntry(bookId, event, chapterIdsForEvent));
      timelineStats[result] += 1;
    }
  }

  const archivesWritten =
    placeStats.added + placeStats.updated + timelineStats.added + timelineStats.updated > 0
      ? writeJsonIfChanged(archivesFile, archives, DRY_RUN)
      : false;

  return {
    label: path.basename(bookDir),
    bookDir,
    bookId,
    chapters: chapterIds.length,
    chaptersWithMap: chapterHasMap,
    chaptersWithTimeline: chapterHasTimeline,
    chaptersWithoutTimelineDate: chapterMissingTimelineDate,
    chaptersMissingMapFile: chapterMissingMapFile,
    exploreFilesWritten,
    exploreFilesUnchanged: chapterIds.length - exploreFilesWritten,
    timelineEventSelections,
    timelineEvents: events.length,
    timelineEventsReferenced: selectedEventChapters.size,
    places: places.length,
    placesReferenced: places.length - placeStats.withoutChapter,
    placeStats,
    timelineStats,
    archivesEntriesBefore: entriesBefore,
    archivesEntriesAfter: entries.length,
    archivesWritten,
    warnings,
    dryRun: DRY_RUN,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function collectTargets() {
  const targets = [];
  if (ONLY === "all" || ONLY === "seed") {
    const seedDir = path.join(BOOKS_ROOT, BOOK_ID);
    if (exists(seedDir)) targets.push({ kind: "seed", dir: seedDir });
    else console.warn(`[migrate-explore] 跳过种子书：目录不存在 ${seedDir}`);
  }
  if (ONLY === "all" || ONLY === "library") {
    const libraryDir = path.join(LIBRARY_ROOT, "books", BOOK_ID);
    if (exists(libraryDir)) targets.push({ kind: "library", dir: libraryDir });
    else console.warn(`[migrate-explore] 跳过 dev 用户库副本：目录不存在 ${libraryDir}`);
  }
  return targets;
}

const targets = collectTargets();
if (targets.length === 0) {
  console.error("[migrate-explore] 没有找到可处理的书目录");
  process.exit(1);
}

console.log(
  (DRY_RUN ? "[migrate-explore] dry-run（不写盘）" : "[migrate-explore]") +
    " bookId=" +
    BOOK_ID +
    " targets=" +
    targets.map((target) => target.kind + ":" + target.dir).join(" | "),
);

const results = [];
for (const target of targets) {
  const result = migrateBook(target.dir);
  results.push({ kind: target.kind, ...result });
  if (result.skipped) {
    console.log(`[migrate-explore] ${target.kind} 跳过：${result.skipped}`);
    continue;
  }
  const { placeStats, timelineStats } = result;
  console.log(
    `[migrate-explore] ${target.kind} ${result.bookId}: ` +
      `chapters=${result.chapters} ` +
      `explore(map=${result.chaptersWithMap},timeline=${result.chaptersWithTimeline}) ` +
      `exploreFiles(written=${result.exploreFilesWritten},unchanged=${result.exploreFilesUnchanged})`,
  );
  console.log(
    `[migrate-explore]   知识条目: place +${placeStats.added}/~${placeStats.updated}/=${placeStats.unchanged} ` +
      `(无关联章节 ${placeStats.withoutChapter}), ` +
      `timeline +${timelineStats.added}/~${timelineStats.updated}/=${timelineStats.unchanged} ` +
      `(无关联章节 ${timelineStats.withoutChapter}); ` +
      `archives ${result.archivesEntriesBefore}→${result.archivesEntriesAfter}` +
      (result.archivesWritten ? "（已写盘）" : "（无变化）"),
  );
  for (const warning of result.warnings) console.log(`[migrate-explore]   warning: ${warning}`);
}

const summary = {
  bookId: BOOK_ID,
  dryRun: DRY_RUN,
  books: results.map((result) =>
    result.skipped
      ? { kind: result.kind, dir: result.bookDir ?? result.label, skipped: result.skipped }
      : {
          kind: result.kind,
          dir: result.bookDir,
          chapters: result.chapters,
          chaptersWithMap: result.chaptersWithMap,
          chaptersWithTimeline: result.chaptersWithTimeline,
          exploreFilesWritten: result.exploreFilesWritten,
          exploreFilesUnchanged: result.exploreFilesUnchanged,
          places: result.places,
          placesReferenced: result.placesReferenced,
          timelineEvents: result.timelineEvents,
          timelineEventsReferenced: result.timelineEventsReferenced,
          placeAdded: result.placeStats.added,
          placeUpdated: result.placeStats.updated,
          timelineAdded: result.timelineStats.added,
          timelineUpdated: result.timelineStats.updated,
          archivesEntriesBefore: result.archivesEntriesBefore,
          archivesEntriesAfter: result.archivesEntriesAfter,
        },
  ),
};
console.log("[migrate-explore] summary " + JSON.stringify(summary));
