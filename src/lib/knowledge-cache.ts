import { invoke, isTauri } from "@tauri-apps/api/core";
import { createTauriLibrary } from "@jusong/core";
import type { ChapterDigest, KnowledgeEntry, KnowledgeType, Library } from "@jusong/core";

/**
 * 知识数据的内存会话缓存（首页「知识」+ 阅读器「知识库」共用）。
 *
 * 定位：会话级、纯内存、不落盘、不跨启动。首次需要某本书时一次性读取并裁剪成
 * 精简投影驻留；同一 `bookId` 只加载一次，并发请求共用同一个 in-flight Promise。
 *
 * 缓存内容（刻意只保留展示/统计需要的最小字段，避免完整 payload / keyPoints 原文驻留）：
 * - 知识档案投影：id/bookId/chapterId/type/title/body/createdAt + payload 里的 period/dateText，
 *   丢弃 payload.blocks / sources / map / writing 等长字段（种子书 159 条档案的 payload 合计约 430 KB JSON）；
 * - 章节摘要投影：chapterId/title/opening/closing/generatedAt + 前 2 条 keyPoints 文本（每条裁剪到 320 字），
 *   丢弃 stats/headings/themes/writing/map 与 citation 明细；
 * - 书签只缓存数量（bookmarkCount），不缓存书签正文（阅读器书签列表由 useBookmarks 自行管理）。
 *
 * 失效与增量：
 * - 手动刷新必须显式 `invalidateBook` / `invalidateAll`，之后重新加载一定绕过缓存；
 * - AGENT 保存知识库成功后 `insertKnowledgeEntryIntoCache` 就地插入投影并通知订阅者，不整书重扫；
 * - 书签增删改由阅读器派发 window 事件 `jusong:bookmarks-changed`（detail:{bookId}），
 *   这里只重新读该书的书签数量（1 次 IPC），不重读知识；
 * - 订阅机制：`subscribeKnowledgeCache` / `useKnowledgeCacheVersion` 让已挂载视图在增量更新或失效后刷新。
 *
 * 加载失败不写缓存（下次自动重试），由调用方展示既有错误/重试态。
 */

/** 知识档案投影：从 KnowledgeEntry 裁剪，只保留首页/阅读器知识库展示与统计所需字段。 */
export interface KnowledgeArchiveProjection {
  id: string;
  bookId: string;
  chapterId?: string;
  type: KnowledgeType;
  title: string;
  body: string;
  createdAt: string;
  /** 档案 payload 的时期（如「第一次国内革命战争时期」），用于列表副标题与检索。 */
  period?: string;
  /** 档案 payload 的日期文本，用于列表副标题与检索。 */
  dateText?: string;
}

/** 摘要要点投影：只保留展示用的文本（已裁剪长度）。 */
export interface KnowledgeDigestPointProjection {
  text: string;
}

/** 章节摘要投影：剔除 stats / headings / citations 等长字段。 */
export interface KnowledgeDigestProjection {
  chapterId: string;
  title: string;
  opening: string;
  closing: string;
  /** 前若干条要点文本（首页卡片正文只取前两条）；不是 keyPoints 原文全量。 */
  keyPoints: readonly KnowledgeDigestPointProjection[];
  generatedAt: string;
}

/** 单本书的知识缓存快照（不可变：更新时整体替换，便于用引用判断是否过期）。 */
export interface BookKnowledgeSnapshot {
  bookId: string;
  archives: readonly KnowledgeArchiveProjection[];
  digests: readonly KnowledgeDigestProjection[];
  bookmarkCount: number;
  /**
   * 章节 id → 章节标题的补充字典：仅当档案章节在摘要标题里找不到时才从 TOC 读取补齐（小字典），
   * 让「缓存命中时同步构建书内卡片」也能显示章节名。
   */
  chapterTitles?: Readonly<Record<string, string>>;
}

/** 缓存占用统计（调试/报告用，不参与 UI）。 */
export interface KnowledgeCacheStats {
  books: number;
  archives: number;
  digests: number;
  /** 近似字节数：JSON 序列化长度 × 2（JS 字符串按 UTF-16 计）。 */
  approxBytes: number;
}

/** 阅读器派发的书签变更事件（事件名由第三批约定固定，见 reader/useBookmarks.ts）。 */
const BOOKMARKS_CHANGED_EVENT = "jusong:bookmarks-changed";

/** 摘要投影保留的要点条数：首页卡片正文只取前两条。 */
const DIGEST_KEY_POINT_LIMIT = 2;
/** 单条要点投影的最大字符数：与卡片正文 320 字裁剪口径一致。 */
const DIGEST_KEY_POINT_MAX_CHARS = 320;

function warn(message: string, error: unknown): void {
  console.warn(`[jusong] ${message}`, error);
}

// ---------------------------------------------------------------------------
// 单本书快照加载与缓存状态
// ---------------------------------------------------------------------------

const snapshots = new Map<string, BookKnowledgeSnapshot>();
const inflight = new Map<string, Promise<BookKnowledgeSnapshot>>();
/** 失效代数：加载开始时记录，完成时不一致则丢弃结果（手动刷新期间的在途请求）。 */
let globalRevision = 0;
const bookRevisions = new Map<string, number>();

const listeners = new Set<() => void>();
let cacheVersion = 0;

let activeLibrary: Library | null = null;
let fallbackLibrary: Library | null = null;
let fallbackLibraryTried = false;
let bookmarkListenerInstalled = false;

function captureEpoch(bookId: string): string {
  return `${globalRevision}:${bookRevisions.get(bookId) ?? 0}`;
}

function notify(): void {
  cacheVersion += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      warn("知识缓存订阅者回调失败：", error);
    }
  }
}

/** 订阅缓存变更（失效 / 增量插入 / 书签数更新）；返回取消订阅函数。 */
export function subscribeKnowledgeCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 缓存版本号：每次失效或增量更新 +1，供 useSyncExternalStore 触发视图刷新。 */
export function getKnowledgeCacheVersion(): number {
  return cacheVersion;
}

/**
 * 绑定当前 Library 实例（由读取知识的组件传入）。
 * 只用于两件事：书签事件后重新读该书书签数；阅读器预热。缓存本身不依赖绑定。
 */
export function setKnowledgeCacheLibrary(library: Library | null): void {
  if (!library) return;
  activeLibrary = library;
  ensureBookmarkListener();
}

/** 兜底 Library：`warmKnowledgeBook(bookId)` 只有一个参数，若启动时还没绑定就自建一个
 *  Tauri invoke 包装（与 library.tsx 的单例同为无状态包装，仍是 @jusong/core Library → Rust）。 */
function resolveLibrary(explicit?: Library | null): Library | null {
  if (explicit) {
    setKnowledgeCacheLibrary(explicit);
    return explicit;
  }
  if (activeLibrary) return activeLibrary;
  if (fallbackLibrary) return fallbackLibrary;
  if (fallbackLibraryTried) return null;
  fallbackLibraryTried = true;
  if (!isTauri()) return null;
  fallbackLibrary = createTauriLibrary({
    invoke: (command, args) => invoke(command, args),
  });
  ensureBookmarkListener();
  return fallbackLibrary;
}

// ---------------------------------------------------------------------------
// 投影裁剪
// ---------------------------------------------------------------------------

function readDossierSpan(entry: KnowledgeEntry): { period?: string; dateText?: string } {
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return {};
  const span = payload as { period?: unknown; dateText?: unknown };
  const result: { period?: string; dateText?: string } = {};
  if (typeof span.period === "string" && span.period.trim()) result.period = span.period;
  if (typeof span.dateText === "string" && span.dateText.trim()) result.dateText = span.dateText;
  return result;
}

function clipText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

export function toArchiveProjection(entry: KnowledgeEntry): KnowledgeArchiveProjection {
  const span = readDossierSpan(entry);
  return {
    id: entry.id,
    bookId: entry.bookId,
    ...(entry.chapterId ? { chapterId: entry.chapterId } : {}),
    type: entry.type,
    title: entry.title,
    body: entry.body,
    createdAt: entry.createdAt,
    ...span,
  };
}

export function toDigestProjection(digest: ChapterDigest): KnowledgeDigestProjection {
  return {
    chapterId: digest.chapterId,
    title: digest.title,
    opening: digest.opening ?? "",
    closing: digest.closing ?? "",
    keyPoints: (digest.keyPoints ?? [])
      .slice(0, DIGEST_KEY_POINT_LIMIT)
      .map((point) => ({ text: clipText(point.text ?? "", DIGEST_KEY_POINT_MAX_CHARS) }))
      .filter((point) => point.text.length > 0),
    generatedAt: digest.generatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// 加载 / 读取 / 失效
// ---------------------------------------------------------------------------

async function fetchBookSnapshot(
  library: Library,
  bookId: string,
): Promise<BookKnowledgeSnapshot> {
  // 三个来源都必须成功才缓存：任一失败都抛出（下次重试），组件展示既有错误/重试态。
  const [entries, digests, bookmarks] = await Promise.all([
    library.listKnowledge(bookId),
    library.listChapterDigests(bookId),
    library.listBookmarks(bookId),
  ]);
  return {
    bookId,
    archives: entries.map(toArchiveProjection),
    digests: digests.map(toDigestProjection),
    bookmarkCount: bookmarks.length,
  };
}

/**
 * 读取某本书的知识缓存快照：命中直接返回；未命中则加载（同一 bookId 并发去重）。
 * 加载失败不会写入缓存。
 */
export function loadBookKnowledgeSnapshot(
  library: Library,
  bookId: string,
): Promise<BookKnowledgeSnapshot> {
  setKnowledgeCacheLibrary(library);

  const cached = snapshots.get(bookId);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(bookId);
  if (pending) return pending;

  const epoch = captureEpoch(bookId);
  const promise: Promise<BookKnowledgeSnapshot> = fetchBookSnapshot(library, bookId)
    .then((snapshot) => {
      if (captureEpoch(bookId) === epoch) snapshots.set(bookId, snapshot);
      return snapshot;
    })
    .finally(() => {
      if (inflight.get(bookId) === promise) inflight.delete(bookId);
    });

  inflight.set(bookId, promise);
  return promise;
}

/** 同步读取已缓存快照（未加载返回 null）；用于缓存命中时避免骨架屏闪烁。 */
export function getCachedBookKnowledgeSnapshot(bookId: string): BookKnowledgeSnapshot | null {
  return snapshots.get(bookId) ?? null;
}

/** 同步列出已缓存的书（调试/报告用）。 */
export function getCachedKnowledgeBookIds(): string[] {
  return [...snapshots.keys()];
}

/**
 * 失效单本书：清掉缓存与在途请求标记，并通知订阅者。之后任何读取都会重新加载。
 * 手动刷新（书内刷新 / 阅读器知识库刷新）必须先调用它。
 */
export function invalidateBook(bookId: string): void {
  bookRevisions.set(bookId, (bookRevisions.get(bookId) ?? 0) + 1);
  snapshots.delete(bookId);
  inflight.delete(bookId);
  notify();
}

/** 失效全部缓存（首页知识总览/账号统计的手动刷新）。 */
export function invalidateAll(): void {
  globalRevision += 1;
  snapshots.clear();
  inflight.clear();
  notify();
}

/** 把 TOC 标题补进已缓存的快照（不通知：只影响详情卡片的章节名，不改变计数）。 */
export function cacheBookChapterTitles(
  bookId: string,
  titles: ReadonlyMap<string, string>,
): void {
  const snapshot = snapshots.get(bookId);
  if (!snapshot || titles.size === 0) return;
  const merged: Record<string, string> = { ...(snapshot.chapterTitles ?? {}) };
  let changed = false;
  for (const [chapterId, title] of titles) {
    if (!chapterId || !title || merged[chapterId]) continue;
    merged[chapterId] = title;
    changed = true;
  }
  if (!changed) return;
  snapshots.set(bookId, { ...snapshot, chapterTitles: merged });
}

/**
 * AGENT 保存知识库成功后的增量更新：把条目投影插入对应书的缓存并通知订阅者。
 * 书未缓存（从未加载过）时返回 false——首次加载时自然会包含该条目。
 */
export function insertKnowledgeEntryIntoCache(entry: KnowledgeEntry): boolean {
  const snapshot = snapshots.get(entry.bookId);
  if (!snapshot) return false;
  if (snapshot.archives.some((archive) => archive.id === entry.id)) return false;
  snapshots.set(entry.bookId, {
    ...snapshot,
    archives: [...snapshot.archives, toArchiveProjection(entry)],
  });
  notify();
  return true;
}

// ---------------------------------------------------------------------------
// 书签数量：window 事件 → 只更新该书 bookmarkCount
// ---------------------------------------------------------------------------

async function refreshBookmarkCount(bookId: string): Promise<void> {
  if (!snapshots.has(bookId)) return; // 该书还没加载过，无需增量（首次加载会读到最新数量）
  const library = resolveLibrary();
  if (!library) return;
  try {
    const bookmarks = await library.listBookmarks(bookId);
    const snapshot = snapshots.get(bookId);
    if (!snapshot || snapshot.bookmarkCount === bookmarks.length) return;
    snapshots.set(bookId, { ...snapshot, bookmarkCount: bookmarks.length });
    notify();
  } catch (error) {
    warn(`书签变化后刷新数量失败（${bookId}）：`, error);
  }
}

/**
 * 监听阅读器的 `jusong:bookmarks-changed` 事件（只装一次）。
 * 事件 detail 只约定 { bookId }，因此收到后重新读一次该书书签列表（1 次 IPC）拿数量。
 */
function ensureBookmarkListener(): void {
  if (bookmarkListenerInstalled || typeof window === "undefined") return;
  bookmarkListenerInstalled = true;
  window.addEventListener(BOOKMARKS_CHANGED_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<{ bookId?: unknown }>).detail;
    const bookId = typeof detail?.bookId === "string" ? detail.bookId.trim() : "";
    if (bookId) void refreshBookmarkCount(bookId);
  });
}

// ---------------------------------------------------------------------------
// 阅读器预热
// ---------------------------------------------------------------------------

/**
 * 阅读器首次打开书籍时预热该书缓存（知识 + 摘要 + 书签数投影）。
 * ReaderPage 在书加载后调用；只传 bookId，Library 已绑定时复用，否则用 Tauri invoke 兜底。
 * 预热失败只告警，不影响阅读。
 */
export async function warmKnowledgeBook(
  bookId: string,
  library?: Library | null,
): Promise<void> {
  const active = resolveLibrary(library ?? null);
  if (!active || !bookId) return;
  try {
    await loadBookKnowledgeSnapshot(active, bookId);
  } catch (error) {
    warn(`预热知识缓存失败（${bookId}）：`, error);
  }
}

// ---------------------------------------------------------------------------
// 调试/报告
// ---------------------------------------------------------------------------

/** 缓存占用统计（CDP 验收与报告用；JSON 序列化 ×2 近似 UTF-16 字符内存）。 */
export function getKnowledgeCacheStats(): KnowledgeCacheStats {
  let archives = 0;
  let digests = 0;
  let approxBytes = 0;
  for (const snapshot of snapshots.values()) {
    archives += snapshot.archives.length;
    digests += snapshot.digests.length;
    try {
      approxBytes += JSON.stringify(snapshot).length * 2;
    } catch {
      // 投影均为纯数据，序列化失败理论上不会发生。
    }
  }
  return { books: snapshots.size, archives, digests, approxBytes };
}

const devEnvironment = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
if (devEnvironment?.DEV && typeof window !== "undefined") {
  // 仅供 dev + CDP 验收：查看缓存规模、模拟增量插入/失效（生产构建不挂载）。
  (window as unknown as Record<string, unknown>).__jusongKnowledgeCache = {
    stats: getKnowledgeCacheStats,
    bookIds: getCachedKnowledgeBookIds,
    insert: insertKnowledgeEntryIntoCache,
    invalidateAll,
    invalidateBook,
    warm: (bookId: string) => warmKnowledgeBook(bookId),
  };
}
