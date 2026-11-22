import type { Chapter } from "@jusong/core";
import { ChevronLeft, ChevronRight } from "lucide-react";

import {
  resolveHighlightRange,
  type BookmarkJumpHighlight,
} from "../../lib/bookmark-highlight";
import { isNotesSectionHeading } from "../../lib/notes";
import type { NoteDisplayMode } from "../../lib/settings";
import type { FlatChapter } from "../../lib/toc";
import { cn } from "../../lib/utils";
import { ErrorPanel, LoadingPanel } from "../feedback";
import { InlineText } from "./InlineText";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

interface ChapterViewProps {
  chapter: Chapter | null;
  loading: boolean;
  error: string | null;
  eyebrow?: string;
  prev?: FlatChapter;
  next?: FlatChapter;
  onRetry?: () => void;
  onSelectChapter: (chapterId: string) => void;
  /** 文内注释展示方式：仅注释栏展示时不渲染注释正文。 */
  noteDisplayMode?: NoteDisplayMode;
  /** 点击文内注释标号 [n]。 */
  onNoteClick?: (noteNumber: number) => void;
  /**
   * 跳转书签的一次性精确文字高亮：只在对应 block 的原始 block.text 上包选中区间。
   * 组件只按 prop 渲染，不做滚动/计时（滚动与 2.5s 清除由 ReaderPage 负责）。
   */
  highlight?: BookmarkJumpHighlight | null;
  className?: string;
}

export function ChapterView({
  chapter,
  loading,
  error,
  eyebrow,
  prev,
  next,
  onRetry,
  onSelectChapter,
  noteDisplayMode = "inline",
  onNoteClick,
  highlight,
}: ChapterViewProps) {
  if (loading) {
    return <LoadingPanel label="正在展开章节…" className="py-24" />;
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-10">
        <ErrorPanel title="章节载入失败" message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (!chapter) {
    return (
      <div className="mx-auto w-full max-w-3xl px-5 py-24 text-center sm:px-10">
        <p className="font-serif text-lg font-semibold tracking-wide">还没有可读的章节</p>
        <p className="mt-2 text-sm leading-7 text-ink-soft">从目录选择一章，或者先在书架导入一本 EPUB。</p>
      </div>
    );
  }

  const noteOrdinal = new Map<string, number>();
  let noteCounter = 0;
  for (const block of chapter.blocks) {
    if (block.kind === "note") {
      noteCounter += 1;
      noteOrdinal.set(block.id, noteCounter);
    }
  }

  const showInlineNotes = noteDisplayMode !== "panel";
  const blocks = (
    chapter.blocks.length > 1 &&
    chapter.blocks[0].kind === "heading" &&
    chapter.blocks[0].text.trim() === chapter.title.trim()
      ? chapter.blocks.slice(1)
      : chapter.blocks
  ).filter((block) => {
    if (showInlineNotes) return true;
    if (block.kind === "note") return false;
    // 「注 释」小节标题在仅注释栏展示时同样隐藏，避免留下空标题。
    return !isNotesSectionHeading(block);
  });

  return (
    <article className="prose-reading mx-auto w-full max-w-3xl px-5 pb-16 pt-8 sm:px-10 sm:pt-12">
      {eyebrow ? (
        <p className="mb-3 text-[11px] uppercase tracking-[0.28em] text-cinnabar/80">{eyebrow}</p>
      ) : null}

      <h1 className="text-[1.75rem] font-semibold leading-snug tracking-wide text-ink sm:text-[2.1rem]">
        {chapter.title}
      </h1>
      <Separator className="my-6" />

      {blocks.length === 0 ? (
        <p className="text-sm leading-7 text-ink-soft">本章暂无正文。</p>
      ) : (
        blocks.map((block) => {
          // 只对命中的 block 解析区间：偏移相对原始 block.text（含脚注占位符），
          // 不能拿渲染后 DOM 文本偏移直接切，否则有脚注的段落会错位。
          const blockHighlight =
            highlight && highlight.blockId === block.id
              ? resolveHighlightRange(block.text, highlight)
              : null;
          const highlightNonce = highlight?.nonce;
          switch (block.kind) {
            case "heading":
              return (
                <h2
                  key={block.id}
                  id={block.id}
                  data-block-id={block.id}
                  className="mt-9 scroll-mt-6 text-xl font-semibold leading-relaxed tracking-wide"
                >
                  <InlineText
                    text={block.text}
                    onNoteClick={onNoteClick}
                    highlight={blockHighlight}
                    highlightNonce={highlightNonce}
                  />
                </h2>
              );
            case "quote":
              return (
                <blockquote
                  key={block.id}
                  id={block.id}
                  data-block-id={block.id}
                  className="my-6 scroll-mt-6 border-l-2 border-cinnabar/50 bg-paper-soft/60 px-4 py-3 font-serif text-[1.02rem] leading-8 text-ink-soft"
                >
                  <InlineText
                    text={block.text}
                    onNoteClick={onNoteClick}
                    highlight={blockHighlight}
                    highlightNonce={highlightNonce}
                  />
                </blockquote>
              );
            case "note":
              return (
                <aside
                  key={block.id}
                  id={block.id}
                  data-block-id={block.id}
                  data-note-number={block.noteNumber ?? 0}
                  className="my-4 scroll-mt-6 rounded-md border border-border/70 bg-paper-soft/60 px-4 py-3 text-sm leading-7 text-ink-soft"
                >
                  <span className="mr-2 font-serif text-cinnabar">
                    {typeof block.noteNumber === "number"
                      ? block.noteNumber > 0
                        ? "注" + block.noteNumber
                        : "说明"
                      : "注" + (noteOrdinal.get(block.id) ?? "")}
                  </span>
                  <InlineText
                    text={block.text}
                    highlight={blockHighlight}
                    highlightNonce={highlightNonce}
                  />
                </aside>
              );
            default:
              return (
                <p key={block.id} id={block.id} data-block-id={block.id} className="scroll-mt-6">
                  <InlineText
                    text={block.text}
                    onNoteClick={onNoteClick}
                    highlight={blockHighlight}
                    highlightNonce={highlightNonce}
                  />
                </p>
              );
          }
        })
      )}

      <Separator className="mt-10" />
      <nav className="mt-5 flex items-center justify-between gap-3" aria-label="章节翻页">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!prev}
          onClick={() => prev && onSelectChapter(prev.chapterId)}
          className={cn("min-w-0 max-w-[46%] justify-start", !prev && "invisible")}
        >
          <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{prev ? prev.title : "上一章"}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!next}
          onClick={() => next && onSelectChapter(next.chapterId)}
          className={cn("min-w-0 max-w-[46%] justify-end text-right", !next && "invisible")}
        >
          <span className="truncate">{next ? next.title : "下一章"}</span>
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Button>
      </nav>
    </article>
  );
}
