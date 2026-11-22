import { useMemo, useState } from "react";
import { RefreshCw, Search, X } from "lucide-react";

import { BookCard } from "../bookshelf/BookCard";
import { ErrorPanel } from "../feedback";
import { Button } from "../ui/button";
import { useLibrary } from "../../lib/library";
import { cn } from "../../lib/utils";

export function ShelfView() {
  const { books, status, error, seedError, booksError, booksLoading, refreshBooks, retry } = useLibrary();
  const [filter, setFilter] = useState("");

  const normalized = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalized) return books;
    return books.filter((book) => {
      const haystack = [book.title, book.author, book.sourceName, book.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [books, normalized]);

  const totalVolumes = books.reduce((total, book) => total + (book.volumeCount || 0), 0);
  const totalChapters = books.reduce((total, book) => total + (book.chapterCount || 0), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/60 px-5 py-4 sm:px-8">
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-semibold tracking-wide">书架</h1>
          <p className="mt-1 text-xs text-ink-soft">
            点击封面继续阅读；右键或长按卡片可导出书籍。左侧「导入」可接入 EPUB、加密解析包与原始文件。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft/60"
              aria-hidden="true"
            />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="筛选书架"
              aria-label="按书名或作者筛选书架"
              className="h-9 w-44 rounded-md border border-border bg-paper pl-8 pr-8 text-xs text-ink placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-cinnabar/30 sm:w-52"
            />
            {filter ? (
              <button
                type="button"
                onClick={() => setFilter("")}
                aria-label="清除筛选"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-soft/60 hover:bg-muted/70 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void refreshBooks()}
            disabled={booksLoading || status !== "ready"}
            aria-label="刷新书架"
            title="刷新书架"
          >
            <RefreshCw className={cn("h-4 w-4", booksLoading && "animate-spin")} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8 sm:py-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-soft">
          <span>
            藏书 <b className="font-serif text-base text-ink">{books.length}</b> 本
          </span>
          <span>
            卷 <b className="font-serif text-base text-ink">{totalVolumes}</b>
          </span>
          <span>
            篇 <b className="font-serif text-base text-ink">{totalChapters}</b>
          </span>
          {normalized ? (
            <span className="text-ink-soft/70">
              筛选结果 <b className="text-ink">{filtered.length}</b> 本
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-ink-soft/60">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600/70" aria-hidden="true" />
              本地存储 · 离线可读
            </span>
          )}
        </div>

        {status === "error" ? (
          <ErrorPanel
            className="mt-5"
            title="书库初始化失败"
            message={error ?? "未知错误"}
            onRetry={retry}
            retryLabel="重新初始化"
          />
        ) : null}

        {seedError ? (
          <div className="mt-5 rounded-md border border-cinnabar/20 bg-cinnabar/[0.04] px-4 py-3 text-xs leading-6 text-ink-soft">
            <span className="font-medium text-cinnabar">种子书未安装：</span>
            {seedError}
          </div>
        ) : null}

        {booksError ? (
          <ErrorPanel
            className="mt-5"
            title="书架读取失败"
            message={booksError}
            onRetry={() => void refreshBooks()}
          />
        ) : null}

        <div className="mt-5">
          {booksLoading && books.length === 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="h-[11.5rem] animate-pulse rounded-lg border border-border/70 bg-paper-soft/50"
                />
              ))}
            </div>
          ) : filtered.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {filtered.map((book) => (
                <BookCard key={book.id} book={book} />
              ))}
            </div>
          ) : books.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-paper-soft/40 px-6 py-14 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-cinnabar/30 bg-cinnabar/5 font-serif text-2xl text-cinnabar">
                沮
              </div>
              <h2 className="mt-4 font-serif text-xl font-semibold tracking-wide">书斋尚空</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-ink-soft">
                从左侧「导入 → 导入书籍」选择文件开始阅读：支持 EPUB、加密解析包（.jusong）与 MOBI / PDF / TXT
                原始文件。种子书会在数据准备完成后自动安装。
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-paper-soft/40 px-6 py-12 text-center text-sm text-ink-soft">
              没有找到匹配「{filter}」的书。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
