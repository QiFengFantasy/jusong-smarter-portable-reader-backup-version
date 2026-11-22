import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { BookMarked, ChevronRight, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { KnowledgeEntry } from "@jusong/core";

import { archiveMeta, filterArchives } from "../../lib/knowledge";
import {
  getCachedReaderArchives,
  loadReaderArchives,
} from "../../lib/knowledge-library";
import { useLibrary } from "../../lib/library";
import { useKnowledgeCache } from "../../lib/useKnowledgeCache";
import { cn, getErrorMessage } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { HighlightText } from "./HighlightText";

interface KnowledgeSearchPanelProps {
  bookId: string;
  bookTitle?: string;
  /** 点击档案：跳到对应章节，并切到左栏「摘要」。 */
  onOpenChapter: (chapterId: string) => void;
  className?: string;
}

function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() + "…" : clean;
}

/** 左栏「知识库」：全书档案搜索 + 列表，点击档案跳到章节摘要。 */
export function KnowledgeSearchPanel({
  bookId,
  bookTitle,
  onOpenChapter,
  className,
}: KnowledgeSearchPanelProps) {
  const { library } = useLibrary();
  const cache = useKnowledgeCache();

  // 缓存命中（阅读器预热过、或刚在首页「知识」看过）时同步铺开列表，不闪载入态。
  const initialArchivesRef = useRef<KnowledgeEntry[] | null | undefined>(undefined);
  if (initialArchivesRef.current === undefined) {
    initialArchivesRef.current = getCachedReaderArchives(bookId);
  }

  const [archives, setArchives] = useState<KnowledgeEntry[]>(
    () => initialArchivesRef.current ?? [],
  );
  const [loading, setLoading] = useState(initialArchivesRef.current === null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

  useEffect(() => {
    if (!library) {
      setArchives([]);
      setLoading(false);
      setError(null);
      return;
    }

    // 数据走知识内存缓存：命中时不再发 IPC；只列人工档案与 AGENT 笔记（口径见 loadReaderArchives）。
    const cached = getCachedReaderArchives(bookId);
    if (cached) {
      setArchives(cached);
      setLoading(false);
    } else {
      setArchives([]);
      setLoading(true);
    }
    setError(null);

    let alive = true;
    loadReaderArchives(library, bookId)
      .then((list) => {
        if (!alive) return;
        setArchives(list);
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setError(getErrorMessage(reason));
        setArchives([]);
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [library, bookId, cache.version]);

  // 手动刷新必须先失效该书缓存再重载（失效会通知本视图，effect 依赖 cache.version 重新读取）。
  const refresh = () => cache.invalidateBook(bookId);

  const results = useMemo(() => filterArchives(archives, activeQuery), [archives, activeQuery]);
  const searching = activeQuery.trim().length > 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActiveQuery(query.trim());
  };

  const clearSearch = () => {
    setQuery("");
    setActiveQuery("");
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="shrink-0 space-y-2 px-4 pb-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-serif text-sm font-semibold tracking-[0.28em] text-ink-soft">知识库</h2>
            <p className="mt-1 truncate text-[11px] text-ink-soft/60">
              {bookTitle ?? "当前书籍"} · 全书档案
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-ink-soft"
            onClick={refresh}
            aria-label="刷新档案列表"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden="true" />
          </Button>
        </div>

        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="检索全书档案…"
            aria-label="检索全书档案"
            className="h-8 bg-paper text-xs"
          />
          {query ? (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="清空检索"
              className="shrink-0 rounded p-1 text-ink-soft/60 hover:bg-muted/60 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
          <Button
            type="submit"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={!query.trim()}
            aria-label="检索档案"
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </form>

        <p className="rounded-md border border-dashed border-border/80 bg-paper/50 px-2.5 py-2 text-[11px] leading-5 text-ink-soft/75">
          全书共 {archives.length} 篇档案与 AGENT 笔记。输入关键词检索标题与正文；点击条目跳到对应章节的「摘要」。
        </p>

        <div className="flex items-center justify-between gap-2 text-[11px] text-ink-soft/70">
          <span className="min-w-0 truncate">
            {searching ? "「" + activeQuery + "」的检索结果" : "全书档案与 AGENT 笔记"}
          </span>
          <span className="shrink-0 text-ink-soft/55">
            {loading && archives.length === 0 ? "载入中" : results.length + " 篇"}
          </span>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-8">
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-cinnabar/25 bg-cinnabar/5 px-3 py-2 text-xs leading-5 text-cinnabar"
            >
              {error}
            </p>
          ) : null}

          {!error && loading && archives.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-ink-soft">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              正在载入档案…
            </div>
          ) : null}

          {!error && !loading && archives.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/80 px-4 py-8 text-center text-xs leading-6 text-ink-soft">
              这本书还没有档案。
              <br />
              导入的书只有自动生成的结构摘要，可在「摘要」标签查看。
            </div>
          ) : null}

          {!error && archives.length > 0 && results.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/80 px-4 py-8 text-center text-xs leading-6 text-ink-soft">
              没有找到匹配「{activeQuery}」的档案。
              <br />
              试试更短的关键词，或清空检索查看全部。
            </div>
          ) : null}

          {results.length > 0 ? (
            <ul className="space-y-2">
              {results.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => entry.chapterId && onOpenChapter(entry.chapterId)}
                    className="w-full rounded-md border border-border/80 bg-paper/70 p-3 text-left transition-colors hover:border-cinnabar/40 hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
                  >
                    <span className="flex items-center gap-2">
                      {entry.type === "note" ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-emerald-700/25 bg-emerald-700/10 px-1.5 py-0.5 text-[10px] tracking-wider text-emerald-800">
                          <BookMarked className="h-2.5 w-2.5" aria-hidden="true" />
                          AGENT
                        </span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-cinnabar/25 bg-cinnabar/5 px-1.5 py-0.5 text-[10px] tracking-wider text-cinnabar">
                          <BookMarked className="h-2.5 w-2.5" aria-hidden="true" />
                          档案
                        </span>
                      )}
                      <span className="ml-auto min-w-0 truncate text-[10px] text-ink-soft/55">
                        {archiveMeta(entry)}
                      </span>
                    </span>
                    <span className="mt-2 block break-words font-serif text-[13px] font-semibold leading-snug text-ink">
                      <HighlightText text={entry.title} term={activeQuery} />
                    </span>
                    <span className="mt-1 line-clamp-3 block break-words text-xs leading-5 text-ink-soft">
                      <HighlightText text={shorten(entry.body, 140)} term={activeQuery} />
                    </span>
                    <span className="mt-2 inline-flex items-center gap-1 text-[11px] text-cinnabar">
                      跳到章节摘要
                      <ChevronRight className="h-3 w-3" aria-hidden="true" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
