import type {
  BookTopics,
  ChapterAssets,
  ChapterDigest,
  KnowledgeEntry,
  Library,
} from "@jusong/core";

/**
 * 阅读器章节数据共享缓存（PERF-06）：
 * 摘要面板、右栏专题、档案弹层都读同一份 digest/entries/topics，避免重复 IPC 与 JSON 解析。
 */

export interface ChapterBundle {
  digest: ChapterDigest | null;
  /** 本章的知识条目（含 legacy 档案）。 */
  entries: KnowledgeEntry[];
  /** 章节资产标记；Library 未实现时为 null。 */
  assets: ChapterAssets | null;
}

const MAX_CHAPTER_ENTRIES = 64;
const chapterCache = new Map<string, Promise<ChapterBundle>>();
const topicsCache = new Map<string, Promise<BookTopics>>();

const EMPTY_TOPICS: BookTopics = { map: null, timeline: null };

function chapterKey(bookId: string, chapterId: string): string {
  return bookId + "/" + chapterId;
}

function remember<T>(cache: Map<string, Promise<T>>, key: string, promise: Promise<T>, max: number): Promise<T> {
  cache.set(key, promise);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return promise;
}

function forget<T>(cache: Map<string, Promise<T>>, key: string): void {
  cache.delete(key);
}

/** 读取一章的摘要 + 本章知识条目 + 资产标记；同一章并发调用只发一次 IPC。 */
export function loadChapterBundle(
  library: Library,
  bookId: string,
  chapterId: string,
  force = false,
): Promise<ChapterBundle> {
  const key = chapterKey(bookId, chapterId);
  if (force) forget(chapterCache, key);
  const cached = chapterCache.get(key);
  if (cached) return cached;

  const promise = Promise.all([
    library.getChapterDigest(bookId, chapterId),
    library.listKnowledge(bookId, chapterId),
    library.getChapterAssets
      ? library.getChapterAssets(bookId, chapterId)
      : Promise.resolve<ChapterAssets | null>(null),
  ])
    .then(([digest, entries, assets]) => ({ digest, entries, assets }))
    .catch((error: unknown) => {
      // 失败不缓存，允许下次重试。
      forget(chapterCache, key);
      throw error;
    });

  return remember(chapterCache, key, promise, MAX_CHAPTER_ENTRIES);
}

/** 读取整书专题数据（地图/时间线）；同一本书并发调用只发一次 IPC。 */
export function loadBookTopics(
  library: Library,
  bookId: string,
  force = false,
): Promise<BookTopics> {
  if (force) forget(topicsCache, bookId);
  const cached = topicsCache.get(bookId);
  if (cached) return cached;

  const promise = (library.getBookTopics
    ? library.getBookTopics(bookId)
    : Promise.resolve(EMPTY_TOPICS)
  ).catch((error: unknown) => {
    forget(topicsCache, bookId);
    throw error;
  });

  return remember(topicsCache, bookId, promise, 16);
}
