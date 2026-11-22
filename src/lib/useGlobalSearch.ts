import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BookMeta, GlobalSearchHit, SearchOptions } from "@jusong/core";

import { useLibrary } from "./library";
import { nextCoverageTier, type SearchScopeSpec } from "./searchScope";
import { getErrorMessage } from "./utils";

interface SearchProgressPayload {
  requestId: string;
  scanned: number;
  total: number;
  done: boolean;
}

/** 单轮检索结果上限（与 Rust 侧 1..=200 的夹取一致）。 */
export const SEARCH_RESULT_LIMIT = 100;

export type SearchPhase = "initial" | "more";

/** 检索覆盖状态：最近阅读优先，按设置档位逐步扩大。 */
export interface SearchCoverage {
  /** 当前覆盖（已扫描）的书籍数。 */
  coveredBooks: number;
  /** 本次检索的书库总本数。 */
  totalBooks: number;
  /** 下一档覆盖本数；null = 没有下一档（已覆盖全部）。 */
  nextTier: number | null;
}

export interface ScopedSearchState {
  query: string;
  results: GlobalSearchHit[];
  running: boolean;
  /** 当前扫描轮次：首轮 initial / 查找更多 more；空闲为 null。 */
  phase: SearchPhase | null;
  /** 当前请求已扫描的章节/条目数。 */
  scanned: number;
  /** 当前请求要扫描的总章节/条目数。 */
  total: number;
  error: string | null;
  /** 本轮是否被用户取消（保留已扫描到的部分结果）。 */
  cancelled: boolean;
  coverage: SearchCoverage;
  run: (query: string) => Promise<void>;
  findMore: () => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

export interface ScopedSearchOptions {
  books: BookMeta[];
  scope: SearchScopeSpec;
  /** 实际发送检索请求的方法（searchAll / searchKnowledge）。 */
  search: (query: string, options: SearchOptions) => Promise<GlobalSearchHit[]>;
  /** 可选结果过滤（知识库检索只保留 kind=knowledge）。 */
  accept?: (hit: GlobalSearchHit) => boolean;
}

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/** 结果去重键：kind/bookId/chapterId/entryId/title；合并「查找更多」时保留先出现的条目。 */
export function searchHitKey(hit: GlobalSearchHit): string {
  return [hit.kind, hit.bookId, hit.chapterId ?? "", hit.entryId ?? "", hit.title].join("\u0001");
}

export function mergeSearchHits(
  existing: GlobalSearchHit[],
  incoming: GlobalSearchHit[],
): GlobalSearchHit[] {
  const seen = new Set(existing.map(searchHitKey));
  const merged = existing.slice();
  for (const hit of incoming) {
    const key = searchHitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged;
}

function coverageFor(
  scope: SearchScopeSpec,
  coveredBooks: number,
  totalBooks: number,
): SearchCoverage {
  return {
    coveredBooks,
    totalBooks,
    nextTier: coveredBooks > 0 ? nextCoverageTier(scope, coveredBooks, totalBooks) : null,
  };
}

/**
 * 检索引擎（高级检索与知识库检索共用）：
 *
 * - 有序书单 = 最近阅读（Rust recent.json，过滤已不存在的书）在前 + 其余书架顺序；
 * - 首轮覆盖 `scope.recentCount` 本，书名/作者命中始终由全库返回（includeBookLevel=true）；
 * - 「查找更多」按 `scope.tiers` 的绝对档位扩大，只把新增书籍传给 Rust（includeBookLevel=false），
 *   结果与已有结果按 kind/bookId/chapterId/entryId/title 合并去重；
 * - 新关键词重置覆盖与结果；进度事件按 requestId 过滤，取消保留已扫描到的结果。
 */
export function useScopedSearch({
  books,
  scope,
  search,
  accept,
}: ScopedSearchOptions): ScopedSearchState {
  const { library } = useLibrary();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchHit[]>([]);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<SearchPhase | null>(null);
  const [scanned, setScanned] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [coverage, setCoverage] = useState<SearchCoverage>(() =>
    coverageFor(scope, 0, books.length),
  );

  const requestRef = useRef<string | null>(null);
  /** 本次检索的有序书单快照（最近阅读优先 + 书架顺序）。 */
  const orderedIdsRef = useRef<string[]>([]);
  const coveredRef = useRef(0);
  const runningRef = useRef(false);
  const queryRef = useRef("");
  /** 每次 run/reset 自增；异步取最近阅读后用它判断是否已被更新的检索接手。 */
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);

  const booksRef = useRef(books);
  const scopeRef = useRef(scope);
  const acceptRef = useRef(accept);
  const searchRef = useRef(search);
  const libraryRef = useRef(library);
  booksRef.current = books;
  scopeRef.current = scope;
  acceptRef.current = accept;
  searchRef.current = search;
  libraryRef.current = library;

  const applyFilter = useCallback((hits: GlobalSearchHit[]): GlobalSearchHit[] => {
    const filter = acceptRef.current;
    return filter ? hits.filter(filter) : hits;
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let alive = true;
    listen<SearchProgressPayload>("library-search-progress", (event) => {
      if (!alive) return;
      const payload = event.payload;
      if (!payload || payload.requestId !== requestRef.current) return;
      setScanned(payload.scanned);
      setTotal(payload.total);
    })
      .then((dispose) => {
        if (alive) unlisten = dispose;
        else dispose();
      })
      .catch(() => {
        // 非 Tauri 环境没有事件通道；检索由 library 调用失败兜底
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // 视图卸载时取消仍在扫描的请求，避免 Rust 继续无谓扫盘。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const requestId = requestRef.current;
      requestRef.current = null;
      if (requestId) {
        void libraryRef.current?.cancelSearch(requestId).catch(() => {
          // 卸载阶段取消失败无需处理。
        });
      }
    };
  }, []);

  /** 有序书单：最近阅读优先，其余按书架顺序；找不到的最近阅读条目忽略。 */
  const buildOrderedBookIds = useCallback(async (): Promise<string[]> => {
    const list = booksRef.current;
    const known = new Set(list.map((book) => book.id));
    const ordered: string[] = [];
    const seen = new Set<string>();
    try {
      const recent = await libraryRef.current?.getRecentBooks();
      for (const entry of recent ?? []) {
        if (!known.has(entry.bookId) || seen.has(entry.bookId)) continue;
        seen.add(entry.bookId);
        ordered.push(entry.bookId);
      }
    } catch {
      // 最近阅读不可用（旧库缺 recent.json / 读失败）→ 退回书架顺序。
    }
    for (const book of list) {
      if (seen.has(book.id)) continue;
      seen.add(book.id);
      ordered.push(book.id);
    }
    return ordered;
  }, []);

  const run = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      const previousRequest = requestRef.current;
      if (previousRequest) {
        void libraryRef.current?.cancelSearch(previousRequest).catch(() => {
          // 上一轮取消失败不影响新一轮。
        });
      }
      sequenceRef.current += 1;
      const sequence = sequenceRef.current;
      queryRef.current = text;
      // 先进入 running（同步置 ref），避免取最近阅读期间「查找更多」用旧书单 + 新关键词。
      runningRef.current = true;
      setQuery(text);
      setResults([]);
      setRunning(true);
      setPhase("initial");
      setScanned(0);
      setTotal(0);
      setError(null);
      setCancelled(false);
      setCoverage(coverageFor(scopeRef.current, 0, booksRef.current.length));

      const ordered = await buildOrderedBookIds();
      if (!mountedRef.current || sequenceRef.current !== sequence) return;

      const totalBooks = ordered.length;
      orderedIdsRef.current = ordered;
      if (totalBooks === 0) {
        requestRef.current = null;
        coveredRef.current = 0;
        runningRef.current = false;
        setResults([]);
        setRunning(false);
        setPhase(null);
        setScanned(0);
        setTotal(0);
        setCoverage(coverageFor(scopeRef.current, 0, 0));
        return;
      }

      const initialCoverage = Math.min(
        Math.max(1, scopeRef.current.recentCount),
        totalBooks,
      );
      const bookIds = ordered.slice(0, initialCoverage);
      const requestId = newRequestId();
      requestRef.current = requestId;
      coveredRef.current = initialCoverage;
      setCoverage(coverageFor(scopeRef.current, initialCoverage, totalBooks));

      try {
        const hits = await searchRef.current(text, {
          requestId,
          limit: SEARCH_RESULT_LIMIT,
          bookIds,
          includeBookLevel: true,
        });
        if (!mountedRef.current || requestRef.current !== requestId) return;
        setResults(mergeSearchHits([], applyFilter(hits)));
      } catch (reason) {
        if (!mountedRef.current || requestRef.current !== requestId) return;
        setError(getErrorMessage(reason));
      } finally {
        if (mountedRef.current && requestRef.current === requestId) {
          runningRef.current = false;
          setRunning(false);
          setPhase(null);
        }
      }
    },
    [applyFilter, buildOrderedBookIds],
  );

  const findMore = useCallback(async () => {
    if (runningRef.current) return;
    const text = queryRef.current.trim();
    const ordered = orderedIdsRef.current;
    if (!text || ordered.length === 0) return;

    const currentCovered = coveredRef.current;
    const next = nextCoverageTier(scopeRef.current, currentCovered, ordered.length);
    if (next === null || next <= currentCovered) return;
    // 只把新增部分交给 Rust；书名/作者已在首轮全库扫过，这里不再重复扫。
    const bookIds = ordered.slice(currentCovered, next);
    if (bookIds.length === 0) return;

    const requestId = newRequestId();
    requestRef.current = requestId;
    runningRef.current = true;
    setRunning(true);
    setPhase("more");
    setScanned(0);
    setTotal(0);
    setError(null);
    setCancelled(false);

    try {
      const hits = await searchRef.current(text, {
        requestId,
        limit: SEARCH_RESULT_LIMIT,
        bookIds,
        includeBookLevel: false,
      });
      if (!mountedRef.current || requestRef.current !== requestId) return;
      setResults((previous) => mergeSearchHits(previous, applyFilter(hits)));
      coveredRef.current = next;
      setCoverage(coverageFor(scopeRef.current, next, ordered.length));
    } catch (reason) {
      if (!mountedRef.current || requestRef.current !== requestId) return;
      setError(getErrorMessage(reason));
    } finally {
      if (mountedRef.current && requestRef.current === requestId) {
        runningRef.current = false;
        setRunning(false);
        setPhase(null);
      }
    }
  }, [applyFilter]);

  const cancel = useCallback(async () => {
    const requestId = requestRef.current;
    // 让仍在「取最近阅读」阶段的 run 放弃启动本轮扫描。
    sequenceRef.current += 1;
    setCancelled(true);
    runningRef.current = false;
    setRunning(false);
    setPhase(null);
    if (requestId) {
      try {
        await libraryRef.current?.cancelSearch(requestId);
      } catch {
        // 取消失败不阻塞前端复位
      }
    }
  }, []);

  const reset = useCallback(() => {
    sequenceRef.current += 1;
    const requestId = requestRef.current;
    requestRef.current = null;
    if (requestId) {
      void libraryRef.current?.cancelSearch(requestId).catch(() => {
        // 复位阶段取消失败无需处理。
      });
    }
    orderedIdsRef.current = [];
    coveredRef.current = 0;
    runningRef.current = false;
    queryRef.current = "";
    setQuery("");
    setResults([]);
    setRunning(false);
    setPhase(null);
    setScanned(0);
    setTotal(0);
    setError(null);
    setCancelled(false);
    setCoverage(coverageFor(scopeRef.current, 0, booksRef.current.length));
  }, []);

  return {
    query,
    results,
    running,
    phase,
    scanned,
    total,
    error,
    cancelled,
    coverage,
    run,
    findMore,
    cancel,
    reset,
  };
}

export interface UseGlobalSearchOptions {
  books: BookMeta[];
  /** 来自 `useSettings().settings.searchScope` 的解析结果。 */
  scope: SearchScopeSpec;
}

export type GlobalSearchState = ScopedSearchState;

/**
 * 全局检索（高级检索视图）：Rust 按需扫盘（无索引），最近阅读优先 + 查找更多。
 * 结果包含书名 / 作者 / 正文 / 知识库四类；进度经 Tauri 事件回报。
 */
export function useGlobalSearch({ books, scope }: UseGlobalSearchOptions): GlobalSearchState {
  const { library } = useLibrary();
  const search = useCallback(
    (text: string, options: SearchOptions): Promise<GlobalSearchHit[]> => {
      if (!library) return Promise.reject(new Error("书库尚未就绪，请稍后重试"));
      return library.searchAll(text, options);
    },
    [library],
  );
  return useScopedSearch({ books, scope, search });
}
