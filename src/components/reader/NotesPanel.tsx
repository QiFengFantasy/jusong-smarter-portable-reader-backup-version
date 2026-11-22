import { useEffect, useRef } from "react";
import { ArrowUpRight, StickyNote } from "lucide-react";
import { GenerateHintButton } from "./GenerateHintButton";

import type { ChapterNote } from "../../lib/notes";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";

interface NotesPanelProps {
  notes: ChapterNote[];
  chapterTitle?: string;
  /** 需要高亮/滚入视野的注释序号（文内标号点击后设置）。 */
  activeNoteNumber?: number | null;
  /** 点击注释卡片：跳到正文里引用该注释的位置。 */
  onOpenNote: (note: ChapterNote) => void;
  className?: string;
}

/** 卡片滚入视野时在上下留出的空隙，避免贴住面板边缘。 */
const ACTIVE_CARD_GAP = 22;

/** 左栏「注释」：按语料序号列出本章注释，卡片风格与知识库一致。 */
export function NotesPanel({
  notes,
  chapterTitle,
  activeNoteNumber,
  onOpenNote,
  className,
}: NotesPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (activeNoteNumber === null || activeNoteNumber === undefined) return;
    const scroller = panelRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    const card = activeRef.current;
    if (!scroller || !card) return;

    // 手动计算滚动位置：让卡片上方至少留出 ACTIVE_CARD_GAP，而不是用 nearest 贴边。
    const scrollerRect = scroller.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const delta = cardRect.top - scrollerRect.top;
    const desired = scroller.scrollTop + delta - ACTIVE_CARD_GAP;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTo({ top: Math.min(max, Math.max(0, desired)), behavior: "smooth" });
  }, [activeNoteNumber, notes]);

  return (
    <div ref={panelRef} className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-start justify-between gap-2 px-4 pb-2 pt-4">
        <div className="min-w-0">
          <h2 className="font-serif text-sm font-semibold tracking-[0.28em] text-ink-soft">注释</h2>
          <p className="mt-1 truncate text-[11px] text-ink-soft/60">
            {chapterTitle ?? "当前章节"} · 共 {notes.length} 条
          </p>
        </div>
        <StickyNote className="mt-1 h-4 w-4 shrink-0 text-ink-soft/40" aria-hidden="true" />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 px-4 pb-6 pt-3">
          {notes.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border/80 px-4 py-8 text-center text-xs leading-6 text-ink-soft">
              <span>
                本章注释尚未生成。
                <br />
                可以先阅读原文，或后续用分析接口生成注释。
              </span>
              <GenerateHintButton label="生成注释" />
            </div>
          ) : null}

          {notes.map((note) => {
            const active = activeNoteNumber === note.noteNumber;
            return (
              <button
                key={note.blockId}
                ref={active ? activeRef : undefined}
                type="button"
                onClick={() => onOpenNote(note)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "w-full rounded-md border bg-paper/70 p-3 text-left transition-colors hover:border-cinnabar/40 hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30",
                  active
                    ? "border-cinnabar/50 ring-1 ring-cinnabar/25"
                    : "border-border/80",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="rounded-sm border border-cinnabar/25 bg-cinnabar/5 px-1.5 py-0.5 text-[10px] tracking-wider text-cinnabar">
                    {note.label}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-ink-soft/55">
                    {note.noteNumber > 0 ? "文内注释" : "篇前说明"}
                  </span>
                </span>
                <span className="mt-2 block whitespace-pre-wrap break-words text-xs leading-5 text-ink-soft">
                  {note.text}
                </span>
                <span className="mt-2 inline-flex items-center gap-1 text-[11px] text-cinnabar">
                  跳到原文
                  <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
