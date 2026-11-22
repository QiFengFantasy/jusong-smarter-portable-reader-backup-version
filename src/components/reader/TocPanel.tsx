import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { BookMeta, TocNode } from "@jusong/core";

import { cn } from "../../lib/utils";
import { countChapters } from "../../lib/toc";
import { LoadingPanel } from "../feedback";
import { ScrollArea } from "../ui/scroll-area";

interface TocPanelProps {
  book: BookMeta | null;
  toc: TocNode[];
  currentChapterId?: string;
  loading?: boolean;
  onNavigate?: () => void;
  className?: string;
  /** 移动端抽屉已有自己的标题，可隐藏面板头。 */
  showHeader?: boolean;
}

export function TocPanel({
  book,
  toc,
  currentChapterId,
  loading = false,
  onNavigate,
  className,
  showHeader = true,
}: TocPanelProps) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {showHeader ? (
        <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            <p className="font-serif text-sm font-semibold tracking-[0.28em] text-ink-soft">目录</p>
            <p className="mt-1 truncate text-xs text-ink-soft/70">{book?.title ?? "未选择书籍"}</p>
          </div>
          <span className="shrink-0 text-[11px] text-ink-soft/60">
            {book?.chapterCount ?? countChapters(toc)} 篇
          </span>
        </div>
      ) : null}

      {loading ? (
        <LoadingPanel compact label="正在载入目录…" />
      ) : toc.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs leading-6 text-ink-soft">
          本书还没有目录。
          <br />
          导入的 EPUB 若缺少导航文档，解析后会按正文生成章节列表。
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <nav aria-label="书籍目录" className="px-2 py-3">
            <TocBranch
              nodes={toc}
              depth={0}
              bookId={book?.id ?? ""}
              currentChapterId={currentChapterId}
              onNavigate={onNavigate}
            />
          </nav>
        </ScrollArea>
      )}
    </div>
  );
}

interface TocBranchProps {
  nodes: TocNode[];
  depth: number;
  bookId: string;
  currentChapterId?: string;
  onNavigate?: () => void;
}

function TocBranch({ nodes, depth, bookId, currentChapterId, onNavigate }: TocBranchProps) {
  return (
    <ul className={cn("space-y-0.5", depth > 0 && "ml-2 border-l border-border/50 pl-1.5")}>
      {nodes.map((node) => (
        <TocRow
          key={node.id}
          node={node}
          depth={depth}
          bookId={bookId}
          currentChapterId={currentChapterId}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

interface TocRowProps {
  node: TocNode;
  depth: number;
  bookId: string;
  currentChapterId?: string;
  onNavigate?: () => void;
}

function TocRow({ node, depth, bookId, currentChapterId, onNavigate }: TocRowProps) {
  const [open, setOpen] = useState(true);
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const isChapter = node.type === "chapter" && Boolean(node.chapterId);
  const isActive = isChapter && node.chapterId === currentChapterId;

  if (isChapter) {
    return (
      <li>
        <Link
          to={`/read/${bookId}/${node.chapterId ?? ""}`}
          replace
          onClick={onNavigate}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            "flex items-start gap-1.5 rounded px-2 py-[7px] text-[13px] leading-snug transition-colors",
            isActive
              ? "bg-cinnabar/10 font-medium text-cinnabar"
              : "text-ink-soft hover:bg-muted/60 hover:text-ink",
          )}
        >
          <span
            className={cn(
              "mt-[7px] h-1 w-1 shrink-0 rounded-full bg-current",
              isActive ? "opacity-80" : "opacity-35",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">{node.title}</span>
        </Link>
        {hasChildren ? (
          <TocBranch
            nodes={node.children ?? []}
            depth={depth + 1}
            bookId={bookId}
            currentChapterId={currentChapterId}
            onNavigate={onNavigate}
          />
        ) : null}
      </li>
    );
  }

  if (hasChildren) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={cn(
            "flex w-full items-center gap-1 rounded px-1.5 py-1.5 text-left transition-colors hover:bg-muted/60",
            node.type === "volume"
              ? "font-serif text-[13px] font-semibold tracking-wide text-ink"
              : "text-xs font-medium text-ink-soft",
          )}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-ink-soft/60 transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
        </button>
        {open ? (
          <TocBranch
            nodes={node.children ?? []}
            depth={depth + 1}
            bookId={bookId}
            currentChapterId={currentChapterId}
            onNavigate={onNavigate}
          />
        ) : null}
      </li>
    );
  }

  return (
    <li
      className={cn(
        "px-2 py-1.5 text-xs text-ink-soft/70",
        node.type === "volume" && "font-serif text-[13px] font-semibold tracking-wide text-ink",
      )}
    >
      {node.title}
    </li>
  );
}
