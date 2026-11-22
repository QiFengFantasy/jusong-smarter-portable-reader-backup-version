import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowLeft,
  BookMarked,
  ChevronRight,
  ChevronsDown,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { BookMeta, GlobalSearchHit, Library } from "@jusong/core";

import { BookCover } from "../bookshelf/BookCover";
import {
  getCachedBookKnowledgeCards,
  getCachedKnowledgeOverview,
  knowledgeTypeLabel,
  loadBookKnowledge,
  loadKnowledgeOverview,
} from "../../lib/knowledge-library";
import type { KnowledgeBookSummary, KnowledgeCard } from "../../lib/knowledge-library";
import { describeSearchScope, parseSearchScopeSpec } from "../../lib/searchScope";
import { useSettings } from "../../lib/settings";
import { useKnowledgeCache } from "../../lib/useKnowledgeCache";
import { searchHitKey } from "../../lib/useGlobalSearch";
import { useKnowledgeSearch } from "../../lib/useKnowledgeSearch";
import { cn, getErrorMessage } from "../../lib/utils";
import { ErrorPanel } from "../feedback";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface KnowledgeLibraryViewProps {
  books: BookMeta[];
  library: Library | null;
  /** 条目点击：跳到阅读器对应章节的「摘要」页（由父组件负责导航）。 */
  onOpenChapter: (bookId: string, chapterId: string) => void;
}

interface OverviewProgress {
  done: number;
  total: number;
}

const EMPTY_PROGRESS: OverviewProgress = { done: 0, total: 0 };

function isSeedBook(book: BookMeta): boolean {
  return book.format === "seed" || book.id === "maoxuan";
}

function TypeTag({ type, count }: { type: string; count: number }) {
  const digest = type === "digest";
  return (
    <span
      className={cn(
        "rounded-sm border px-1.5 py-0.5 text-[10px] tracking-wider",
        digest
          ? "border-emerald-700/25 bg-emerald-700/10 text-emerald-800"
          : "border-border bg-muted/60 text-ink-soft",
      )}
    >
      {knowledgeTypeLabel(type)} {count}
    </span>
  );
}

/** 总览书卡：仿书架 BookCard 的纸面卡片，封面统一走 BookCover，副文案改为知识统计。 */
function KnowledgeOverviewCard({
  summary,
  onOpen,
}: {
  summary: KnowledgeBookSummary;
  onOpen: () => void;
}) {
  const { book } = summary;
  const seed = isSeedBook(book);
  const typeTags = Object.entries(summary.typeCounts)
    .filter(([, count]) => count > 0)
    .sort(([leftType, leftCount], [rightType, rightCount]) => {
      if (leftType === "digest") return 1;
      if (rightType === "digest") return -1;
      return rightCount - leftCount || leftType.localeCompare(rightType, "en");
    });

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`查看《${book.title}》的知识`}
      className="group flex gap-4 rounded-lg border border-border bg-paper-soft/70 p-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-cinnabar/40 hover:shadow-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper sm:p-4"
    >
      <BookCover book={book} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded-sm border px-1.5 py-0.5 text-[10px] tracking-wider",
              seed
                ? "border-cinnabar/30 bg-cinnabar/10 text-cinnabar"
                : "border-border bg-muted/60 text-ink-soft",
            )}
          >
            {seed ? "种子书" : book.format.toUpperCase()}
          </span>
          {book.author ? (
            <span className="truncate text-[11px] text-ink-soft/80">{book.author}</span>
          ) : null}
        </div>

        <h2 className="mt-1.5 line-clamp-2 font-serif text-[17px] font-semibold leading-snug tracking-wide transition-colors group-hover:text-cinnabar">
          {book.title}
        </h2>

        <p className="mt-1.5 text-xs leading-5 text-ink-soft">
          档案{" "}
          <span className="font-serif text-[13px] font-semibold text-ink">{summary.archiveCount}</span>
          {" · "}摘要{" "}
          <span className="font-serif text-[13px] font-semibold text-ink">{summary.digestCount}</span>
          {" · "}书签{" "}
          <span className="font-serif text-[13px] font-semibold text-ink">{summary.bookmarkCount}</span>
          {" · "}覆盖{" "}
          <span className="font-serif text-[13px] font-semibold text-ink">{summary.chapterCount}</span>{" "}
          章
        </p>

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
          {summary.total === 0 ? (
            <span className="text-[11px] text-ink-soft/60">暂无档案与摘要</span>
          ) : (
            typeTags.map(([type, count]) => <TypeTag key={type} type={type} count={count} />)
          )}
        </div>

        <span className="mt-2 inline-flex items-center gap-1 text-[11px] text-cinnabar/80">
          查看书内条目
          <ChevronRight
            className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </button>
  );
}

/** 书内条目卡片：档案 / 摘要分类徽标 + 章节名 + 摘要片段。 */
function KnowledgeItemCard({
  card,
  onOpen,
}: {
  card: KnowledgeCard;
  onOpen: () => void;
}) {
  const digest = card.kind === "digest";
  const disabled = !card.chapterId;
  const chapterLabel = card.chapterTitle ?? card.chapterId ?? "";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      className={cn(
        "w-full rounded-md border border-border/80 bg-paper/70 p-3 text-left transition-colors",
        disabled
          ? "cursor-default opacity-70"
          : "hover:border-cinnabar/40 hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] tracking-wider",
            digest
              ? "border-emerald-700/25 bg-emerald-700/10 text-emerald-800"
              : "border-cinnabar/25 bg-cinnabar/5 text-cinnabar",
          )}
        >
          <BookMarked className="h-2.5 w-2.5" aria-hidden="true" />
          {digest ? "摘要" : "档案"}
        </span>
        {!digest && card.type !== "legacy-article" ? (
          <span className="rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] text-ink-soft">
            {knowledgeTypeLabel(card.type)}
          </span>
        ) : null}
        {chapterLabel ? (
          <span className="ml-auto min-w-0 truncate text-[10px] text-ink-soft/55">
            {chapterLabel}
          </span>
        ) : null}
      </span>

      <span className="mt-2 block font-serif text-[13px] font-semibold leading-snug text-ink">
        {card.title}
      </span>

      {card.body ? (
        <span className="mt-1 line-clamp-3 block text-xs leading-5 text-ink-soft">{card.body}</span>
      ) : null}

      <span
        className={cn(
          "mt-2 inline-flex items-center gap-1 text-[11px]",
          disabled ? "text-ink-soft/50" : "text-cinnabar",
        )}
      >
        {disabled ? "无关联章节" : "跳到章节摘要"}
        {disabled ? null : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
      </span>
    </button>
  );
}

/** 知识检索结果卡片：书名 + 章节 + 命中片段，点击跳章节摘要（无关联章节时进书内条目）。 */
function KnowledgeSearchResultCard({
  hit,
  onOpen,
}: {
  hit: GlobalSearchHit;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`知识结果：${hit.title}（${hit.bookTitle}）`}
      className="w-full rounded-md border border-border/80 bg-paper/70 p-3 text-left transition-colors hover:border-cinnabar/40 hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-sm border border-cinnabar/25 bg-cinnabar/5 px-1.5 py-0.5 text-[10px] tracking-wider text-cinnabar">
          <BookMarked className="h-2.5 w-2.5" aria-hidden="true" />
          知识
        </span>
        <span className="min-w-0 truncate text-[11px] text-ink-soft/80">{hit.bookTitle}</span>
        {hit.chapterTitle ? (
          <span className="ml-auto min-w-0 truncate text-[10px] text-ink-soft/55">
            {hit.chapterTitle}
          </span>
        ) : null}
      </span>

      <span className="mt-2 block font-serif text-[13px] font-semibold leading-snug text-ink">
        {hit.title}
      </span>

      {hit.snippet ? (
        <span className="mt-1 line-clamp-3 block text-xs leading-5 text-ink-soft">{hit.snippet}</span>
      ) : null}

      <span className="mt-2 inline-flex items-center gap-1 text-[11px] text-cinnabar">
        {hit.chapterId ? "跳到章节摘要" : "查看本书知识"}
        <ChevronRight className="h-3 w-3" aria-hidden="true" />
      </span>
    </button>
  );
}

/** 圆形扫描进度（与检索视图一致的 SVG ring；知识扫描按条目数推进）。 */
function KnowledgeScanRing({ percent, indeterminate }: { percent: number; indeterminate: boolean }) {
  const radius = 15.5;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const dash = indeterminate ? circumference * 0.28 : (clamped / 100) * circumference;
  return (
    <span
      role="progressbar"
      aria-label="知识检索扫描进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : clamped}
      aria-valuetext={indeterminate ? "正在准备扫描" : `已扫描 ${clamped}%`}
      className="relative grid h-10 w-10 shrink-0 place-items-center"
    >
      <svg
        viewBox="0 0 36 36"
        className={cn("h-10 w-10 -rotate-90", indeterminate && "motion-safe:animate-spin")}
        aria-hidden="true"
      >
        <circle cx="18" cy="18" r={radius} fill="none" strokeWidth="3" className="stroke-muted" />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          className="stroke-cinnabar transition-[stroke-dasharray] duration-200"
          strokeDasharray={`${dash} ${circumference}`}
        />
      </svg>
      <span
        className="absolute inset-0 grid place-items-center text-[9px] font-medium tabular-nums text-ink-soft"
        aria-hidden="true"
      >
        {indeterminate ? "" : `${clamped}%`}
      </span>
    </span>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-[11.5rem] animate-pulse rounded-lg border border-border/70 bg-paper-soft/50"
        />
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mt-3 space-y-2" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="h-[5.5rem] animate-pulse rounded-md border border-border/70 bg-paper-soft/50"
        />
      ))}
    </div>
  );
}

/**
 * 首页「知识」状态：按书总览（档案 / 摘要 / 书签 / 覆盖章节 / 类型分布）→ 书内条目列表。
 * 条目点击沿用阅读器交互：由父组件跳到对应章节的「摘要」页。
 *
 * 总览顶部另有独立的「检索知识」输入（与书架筛选框同款）：调用 library.searchKnowledge
 * 检索档案与摘要，结果在本视图内展示，支持最近阅读优先 + 查找更多，不占用高级检索视图。
 *
 * 注意：总览与书内列表都包含自动生成的结构摘要，并按档案 / 摘要分类标注；
 * 阅读器左栏「知识库」仍只显示人工档案（KnowledgeSearchPanel 自己过滤）。
 */
export function KnowledgeLibraryView({
  books,
  library,
  onOpenChapter,
}: KnowledgeLibraryViewProps) {
  const { settings } = useSettings();
  const scope = useMemo(() => parseSearchScopeSpec(settings.searchScope), [settings.searchScope]);
  const knowledgeSearch = useKnowledgeSearch({ books, scope });
  const cache = useKnowledgeCache();

  // 缓存命中时同步给出总览：不闪骨架屏，也不重复读取（冷启动缓存为空才走 IPC）。
  const mountOverviewRef = useRef<KnowledgeBookSummary[] | null | undefined>(undefined);
  if (mountOverviewRef.current === undefined) {
    mountOverviewRef.current = library ? getCachedKnowledgeOverview(books) : null;
  }

  const [overview, setOverview] = useState<KnowledgeBookSummary[]>(
    () => mountOverviewRef.current ?? [],
  );
  const [overviewLoading, setOverviewLoading] = useState(mountOverviewRef.current === null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewProgress, setOverviewProgress] = useState<OverviewProgress>(EMPTY_PROGRESS);

  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [knowledgeDraft, setKnowledgeDraft] = useState("");

  // 父组件每次渲染都可能传新数组；用内容 key 判断是否真的换了书，避免重复统计。
  const booksKey = useMemo(() => books.map((book) => book.id).join("|"), [books]);
  const booksRef = useRef(books);
  booksRef.current = books;

  useEffect(() => {
    if (!library) {
      setOverview([]);
      setOverviewLoading(false);
      setOverviewError(null);
      setOverviewProgress(EMPTY_PROGRESS);
      return;
    }

    const booksNow = booksRef.current;
    // 命中全部缓存：同步刷新即可，不发 IPC（手动刷新会先 invalidateAll，因此不会命中）。
    const cached = getCachedKnowledgeOverview(booksNow);
    if (cached) {
      setOverview(cached);
      setOverviewLoading(false);
      setOverviewError(null);
      setOverviewProgress({ done: booksNow.length, total: booksNow.length });
      return;
    }

    let alive = true;
    setOverviewLoading(true);
    setOverviewError(null);
    setOverviewProgress({ done: 0, total: booksNow.length });

    loadKnowledgeOverview(library, booksNow, (done, total) => {
      if (!alive) return;
      setOverviewProgress({ done, total });
    })
      .then((summaries) => {
        if (!alive) return;
        setOverview(summaries);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setOverview([]);
        setOverviewError(getErrorMessage(reason));
      })
      .finally(() => {
        if (alive) setOverviewLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [library, booksKey, cache.version]);

  useEffect(() => {
    if (!library || !selectedBookId) {
      setCards([]);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }

    // 缓存命中时先同步展示书内条目（不发 IPC、不闪骨架），异步部分只补章节名等细节。
    const cached = getCachedBookKnowledgeCards(selectedBookId);
    if (cached) setCards(cached);

    let alive = true;
    setDetailLoading(cached === null);
    setDetailError(null);

    loadBookKnowledge(library, selectedBookId)
      .then((list) => {
        if (!alive) return;
        setCards(list);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setCards([]);
        setDetailError(getErrorMessage(reason));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [library, selectedBookId, cache.version]);

  // 书架刷新后如果选中的书被删掉，退回总览。
  useEffect(() => {
    if (!selectedBookId) return;
    if (books.length > 0 && !books.some((book) => book.id === selectedBookId)) {
      setSelectedBookId(null);
    }
  }, [books, selectedBookId]);

  const overviewTotals = useMemo(
    () =>
      overview.reduce(
        (acc, item) => ({
          archives: acc.archives + item.archiveCount,
          digests: acc.digests + item.digestCount,
          bookmarks: acc.bookmarks + item.bookmarkCount,
        }),
        { archives: 0, digests: 0, bookmarks: 0 },
      ),
    [overview],
  );

  const selectedBook = useMemo(
    () => (selectedBookId ? books.find((book) => book.id === selectedBookId) ?? null : null),
    [books, selectedBookId],
  );

  const selectedSummary = useMemo(
    () => (selectedBookId ? overview.find((item) => item.book.id === selectedBookId) ?? null : null),
    [overview, selectedBookId],
  );

  const detailCounts = useMemo(() => {
    let archiveCount = 0;
    const chapterIds = new Set<string>();
    for (const card of cards) {
      if (card.kind === "archive") archiveCount += 1;
      if (card.chapterId) chapterIds.add(card.chapterId);
    }
    return {
      archiveCount,
      digestCount: cards.length - archiveCount,
      chapterCount: chapterIds.size,
    };
  }, [cards]);

  const shownCounts =
    selectedSummary && detailLoading && cards.length === 0
      ? {
          archiveCount: selectedSummary.archiveCount,
          digestCount: selectedSummary.digestCount,
          chapterCount: selectedSummary.chapterCount,
        }
      : detailCounts;

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return cards;
    return cards.filter(
      (card) =>
        card.title.toLowerCase().includes(needle) || card.body.toLowerCase().includes(needle),
    );
  }, [cards, query]);

  // 手动刷新必须先失效缓存再重载：失效会通知订阅者，effect 依赖 cache.version 重新读取。
  const refreshOverview = () => cache.invalidateAll();
  const refreshDetail = () => {
    if (selectedBookId) cache.invalidateBook(selectedBookId);
  };

  const openBook = (bookId: string) => {
    setSelectedBookId(bookId);
    setQuery("");
    // 缓存命中时同步铺开条目，避免先闪一下骨架屏再过一帧才有内容。
    setCards(getCachedBookKnowledgeCards(bookId) ?? []);
    setDetailError(null);
  };

  const backToOverview = () => {
    setSelectedBookId(null);
    setQuery("");
  };

  const knowledgeSearchActive = Boolean(knowledgeSearch.query);
  const knowledgeSearchRunning = knowledgeSearch.running;
  const knowledgeCoverage = knowledgeSearch.coverage;
  const knowledgePercent =
    knowledgeSearch.total > 0
      ? Math.min(100, Math.round((knowledgeSearch.scanned / knowledgeSearch.total) * 100))
      : 0;

  const submitKnowledgeSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = knowledgeDraft.trim();
    if (!text) {
      clearKnowledgeSearch();
      return;
    }
    void knowledgeSearch.run(text);
  };

  const clearKnowledgeSearch = () => {
    setKnowledgeDraft("");
    knowledgeSearch.reset();
  };

  const openKnowledgeHit = (hit: GlobalSearchHit) => {
    if (hit.chapterId) {
      onOpenChapter(hit.bookId, hit.chapterId);
      return;
    }
    if (books.some((book) => book.id === hit.bookId)) openBook(hit.bookId);
  };

  if (selectedBook) {
    const searching = query.trim().length > 0;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="shrink-0 border-b border-border/60 px-5 py-4 sm:px-8">
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={backToOverview}
              className="-ml-2 h-8 px-2 text-ink-soft hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              知识
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={refreshDetail}
              disabled={detailLoading}
              aria-label="刷新本书知识"
              title="刷新本书知识"
            >
              <RefreshCw
                className={cn("h-4 w-4", detailLoading && "animate-spin")}
                aria-hidden="true"
              />
            </Button>
          </div>

          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h1 className="font-serif text-xl font-semibold tracking-wide sm:text-2xl">
              {selectedBook.title}
            </h1>
            {selectedBook.author ? (
              <span className="text-xs text-ink-soft/80">{selectedBook.author}</span>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs text-ink-soft">
            档案 <span className="font-serif text-sm text-ink">{shownCounts.archiveCount}</span> 篇
            {" · "}摘要 <span className="font-serif text-sm text-ink">{shownCounts.digestCount}</span>{" "}
            篇 {" · "}覆盖{" "}
            <span className="font-serif text-sm text-ink">{shownCounts.chapterCount}</span> 章
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8 sm:py-6">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft/60"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="在本书知识中筛选标题或摘要…"
                aria-label="筛选本书知识条目"
                className="h-9 bg-paper pl-8 pr-8 text-xs"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="清空筛选"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-soft/60 hover:bg-muted/70 hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <span className="shrink-0 text-[11px] text-ink-soft/70">
              {searching ? `命中 ${filteredCards.length} 条` : `共 ${cards.length} 条`}
            </span>
          </div>

          <p className="mt-3 rounded-md border border-dashed border-border/80 bg-paper/50 px-3 py-2 text-[11px] leading-5 text-ink-soft/75">
            档案为人工整理，摘要为导入时自动生成的结构摘要，两者分类标注。点击条目跳到对应章节的「摘要」。
          </p>

          {detailError ? (
            <ErrorPanel
              className="mt-4"
              title="本书知识读取失败"
              message={detailError}
              onRetry={refreshDetail}
              retryLabel="重新读取"
            />
          ) : null}

          {!detailError && detailLoading && cards.length === 0 ? <DetailSkeleton /> : null}

          {!detailError && !detailLoading && cards.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-border bg-paper-soft/40 px-6 py-12 text-center">
              <p className="font-serif text-base tracking-wide text-ink">这本书还没有知识条目</p>
              <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-ink-soft">
                导入的书会在导入时自动生成各章结构摘要；人工档案需要另外整理。阅读器左栏「知识库」只显示人工档案。
              </p>
            </div>
          ) : null}

          {!detailError && cards.length > 0 && filteredCards.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs leading-6 text-ink-soft">
              没有找到匹配「{query.trim()}」的条目。
              <br />
              试试更短的关键词，或清空筛选查看全部。
            </div>
          ) : null}

          {filteredCards.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {filteredCards.map((card) => (
                <li key={card.id}>
                  <KnowledgeItemCard
                    card={card}
                    onOpen={() => {
                      if (card.chapterId) onOpenChapter(selectedBook.id, card.chapterId);
                    }}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/60 px-5 py-4 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="font-serif text-2xl font-semibold tracking-wide">知识</h1>
            <p className="mt-1 text-xs leading-5 text-ink-soft">
              按书总览人工档案、自动生成的结构摘要与书签统计；也可直接检索档案与摘要，点击结果跳到章节摘要。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <form
              onSubmit={submitKnowledgeSearch}
              role="search"
              aria-label="检索知识档案与摘要"
              className="flex items-center gap-2"
            >
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft/60"
                  aria-hidden="true"
                />
                <input
                  value={knowledgeDraft}
                  onChange={(event) => setKnowledgeDraft(event.target.value)}
                  placeholder="检索知识"
                  aria-label="检索知识档案与摘要"
                  className="h-9 w-44 rounded-md border border-border bg-paper pl-8 pr-8 text-xs text-ink placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-cinnabar/30 sm:w-52"
                />
                {knowledgeDraft ? (
                  <button
                    type="button"
                    onClick={clearKnowledgeSearch}
                    aria-label="清空知识检索"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-soft/60 hover:bg-muted/70 hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-9 px-2.5 text-xs"
                disabled={!library || !knowledgeDraft.trim() || knowledgeSearchRunning}
              >
                {knowledgeSearchRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Search className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                检索
              </Button>
            </form>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={refreshOverview}
              disabled={!library || overviewLoading}
              aria-label="刷新知识统计"
              title="刷新知识统计"
            >
              <RefreshCw
                className={cn("h-4 w-4", overviewLoading && "animate-spin")}
                aria-hidden="true"
              />
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8 sm:py-6">
        {knowledgeSearchActive ? (
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-border/80 bg-paper-soft/50 px-3 py-2">
              <span className="text-[11px] text-ink-soft">
                已检索{" "}
                <b className="font-serif text-[13px] font-semibold text-ink">
                  {knowledgeCoverage.coveredBooks}
                </b>
                <span className="text-ink-soft/70">
                  {" "}
                  / {knowledgeCoverage.totalBooks} 本
                </span>
              </span>
              <span
                className="hidden text-[11px] text-ink-soft/60 sm:inline"
                title={describeSearchScope(scope)}
              >
                最近阅读优先
              </span>
              {knowledgeCoverage.nextTier !== null && !knowledgeSearchRunning ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={() => void knowledgeSearch.findMore()}
                    aria-label={`查找更多：把知识检索范围扩大到 ${knowledgeCoverage.nextTier} 本`}
                  >
                    <ChevronsDown className="h-3 w-3" aria-hidden="true" />
                    查找更多
                    <span className="text-ink-soft/60">
                      +{Math.max(1, knowledgeCoverage.nextTier - knowledgeCoverage.coveredBooks)} 本
                    </span>
                  </Button>
                  <span className="text-[10px] text-ink-soft/50">
                    {knowledgeCoverage.nextTier >= knowledgeCoverage.totalBooks
                      ? "覆盖全部书籍"
                      : `扩大到 ${knowledgeCoverage.nextTier} 本`}
                  </span>
                </>
              ) : null}
              {knowledgeSearchRunning ? (
                <span className="ml-auto flex items-center gap-2">
                  <KnowledgeScanRing
                    percent={knowledgePercent}
                    indeterminate={knowledgeSearch.total === 0}
                  />
                  <span role="status" aria-live="polite" className="text-[11px] text-ink-soft">
                    {knowledgeSearch.total > 0
                      ? `${knowledgeSearch.phase === "more" ? "扩大检索" : "正在扫描"} ${knowledgeSearch.scanned} / ${knowledgeSearch.total}`
                      : "正在准备扫描…"}
                  </span>
                </span>
              ) : knowledgeSearch.cancelled ? (
                <span className="ml-auto text-[11px] text-ink-soft/70">
                  已取消，显示已扫描部分
                </span>
              ) : (
                <span className="ml-auto flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={clearKnowledgeSearch}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    退出检索
                  </Button>
                </span>
              )}
            </div>

            <p className="mt-2 text-xs text-ink-soft">
              「{knowledgeSearch.query}」命中{" "}
              <b className="text-ink">{knowledgeSearch.results.length}</b> 条
              {knowledgeSearchRunning ? "，仍在扫描…" : ""}
            </p>

            {knowledgeSearch.error ? (
              <ErrorPanel
                className="mt-3"
                title="知识检索失败"
                message={knowledgeSearch.error}
                onRetry={() => void knowledgeSearch.run(knowledgeSearch.query)}
                retryLabel="重新检索"
              />
            ) : null}

            {!knowledgeSearch.error &&
            !knowledgeSearchRunning &&
            knowledgeSearch.results.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-ink-soft">
                {knowledgeCoverage.totalBooks === 0 ? (
                  <p>书库还没有可检索的书籍。</p>
                ) : (
                  <>
                    <p>
                      没有找到与「{knowledgeSearch.query}」相关的档案或摘要；已检索{" "}
                      {knowledgeCoverage.coveredBooks} / {knowledgeCoverage.totalBooks} 本。
                    </p>
                    {knowledgeCoverage.nextTier !== null ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => void knowledgeSearch.findMore()}
                      >
                        <ChevronsDown className="h-3.5 w-3.5" aria-hidden="true" />
                        查找更多（扩大到 {knowledgeCoverage.nextTier} 本）
                      </Button>
                    ) : (
                      <p className="mt-2 text-xs text-ink-soft/70">已覆盖书库全部书籍。</p>
                    )}
                  </>
                )}
              </div>
            ) : null}

            {knowledgeSearch.results.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {knowledgeSearch.results.map((hit) => (
                  <li key={searchHitKey(hit)}>
                    <KnowledgeSearchResultCard
                      hit={hit}
                      onOpen={() => openKnowledgeHit(hit)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}

            {knowledgeSearchRunning ? (
              <p
                role="status"
                aria-live="polite"
                className="mt-3 text-[11px] text-ink-soft/70"
              >
                {knowledgeSearch.phase === "more" ? "正在扩大检索范围…" : "正在扫描知识…"}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-soft">
              <span>
                书 <span className="font-serif text-base text-ink">{books.length}</span> 本
              </span>
              <span>
                档案{" "}
                <span className="font-serif text-base text-ink">{overviewTotals.archives}</span> 篇
              </span>
              <span>
                摘要 <span className="font-serif text-base text-ink">{overviewTotals.digests}</span>{" "}
                篇
              </span>
              <span>
                书签{" "}
                <span className="font-serif text-base text-ink">{overviewTotals.bookmarks}</span> 个
              </span>
              {overviewLoading ? (
                <span className="flex items-center gap-1.5 text-ink-soft/70">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  {overviewProgress.total > 0
                    ? `正在统计 ${overviewProgress.done}/${overviewProgress.total} 本…`
                    : "正在准备…"}
                </span>
              ) : null}
            </div>

            <p className="mt-3 rounded-md border border-dashed border-border/80 bg-paper/50 px-3 py-2 text-[11px] leading-5 text-ink-soft/75">
              档案为人工整理，摘要由导入时自动生成、按章一份；书签只按书统计数量（在阅读器中管理）。阅读器左栏「知识库」只列人工档案；这里把档案与摘要分类合计，便于按书了解知识覆盖。
            </p>

            {overviewError ? (
              <ErrorPanel
                className="mt-4"
                title="知识统计失败"
                message={overviewError}
                onRetry={refreshOverview}
                retryLabel="重新统计"
              />
            ) : null}

            {!overviewError && !library ? (
              <div className="mt-4 rounded-xl border border-dashed border-border bg-paper-soft/40 px-6 py-12 text-center text-sm leading-7 text-ink-soft">
                书库尚未就绪，知识统计暂时不可用。
              </div>
            ) : null}

            {!overviewError && library && books.length === 0 && !overviewLoading ? (
              <div className="mt-4 rounded-xl border border-dashed border-border bg-paper-soft/40 px-6 py-14 text-center">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-cinnabar/30 bg-cinnabar/5 font-serif text-2xl text-cinnabar">
                  沮
                </div>
                <h2 className="mt-4 font-serif text-xl font-semibold tracking-wide">书架尚空</h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-ink-soft">
                  导入书籍后，知识会在这里按书汇总人工档案、自动生成的章节摘要与书签统计。
                </p>
              </div>
            ) : null}

            {!overviewError && overviewLoading && overview.length === 0 ? <OverviewSkeleton /> : null}

            {overview.length > 0 ? (
              <div className="mt-4 grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                {overview.map((summary) => (
                  <KnowledgeOverviewCard
                    key={summary.book.id}
                    summary={summary}
                    onOpen={() => openBook(summary.book.id)}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
