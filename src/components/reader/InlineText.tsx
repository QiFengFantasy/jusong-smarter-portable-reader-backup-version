import { Fragment, type ReactNode } from "react";

/** 相对原始 `text`（含 `[[n:1]]` 占位符）的高亮区间 [start, end)。 */
export interface InlineTextHighlight {
  start: number;
  end: number;
}

interface InlineTextProps {
  text: string;
  /** 点击文内注释标号 [n]：打开注释栏或滚到文内注释，由阅读器决定。 */
  onNoteClick?: (noteNumber: number) => void;
  /**
   * 只有「跳转书签」时短暂高亮选中文字：按原始文本偏移只包选中区间，
   * 不能整段套 mark（偏移口径见 lib/bookmark-highlight.ts）。
   */
  highlight?: InlineTextHighlight | null;
  /** 高亮对应的 nonce：同一书签再次跳转时让 mark 重新挂载（用于重放动画）。 */
  highlightNonce?: number;
}

/** mark 的样式写在元素上，保证不依赖全局 CSS 也能看到精确高亮。 */
const HIGHLIGHT_MARK_CLASS =
  "bookmark-jump-highlight rounded-sm bg-cinnabar/20 px-0.5 text-inherit box-decoration-clone";

function NoteMarker({
  noteNumber,
  onNoteClick,
}: {
  noteNumber: number;
  onNoteClick?: (noteNumber: number) => void;
}) {
  if (onNoteClick) {
    return (
      <button
        type="button"
        data-note-marker={noteNumber}
        onClick={() => onNoteClick(noteNumber)}
        title={"查看注释 " + noteNumber}
        aria-label={"查看注释 " + noteNumber}
        className="ml-0.5 rounded-sm align-super text-[0.68em] text-cinnabar/80 transition-colors hover:bg-cinnabar/10 hover:text-cinnabar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
      >
        [{noteNumber}]
      </button>
    );
  }
  return (
    <sup className="ml-0.5 align-super text-[0.68em] text-cinnabar/70">[{noteNumber}]</sup>
  );
}

/**
 * 把语料中的脚注占位符 [[n:1]] 渲染成可点击的上标。
 * 没有传入 onNoteClick 时退化为纯文本上标（例如注释正文内部）。
 *
 * 传入 highlight 时，只把与高亮区间相交的文字/标号包进 `<mark class="bookmark-jump-highlight">`；
 * 区间是相对 **原始 text** 的 UTF-16 偏移，脚注占位符按源长度计入，避免错位。
 */
export function InlineText({ text, onNoteClick, highlight, highlightNonce }: InlineTextProps) {
  const parts = text.split(/(\[\[n:\d+\]\])/g);
  const nodes: ReactNode[] = [];
  let cursor = 0;

  parts.forEach((part, index) => {
    const partStart = cursor;
    cursor += part.length;

    const match = part.match(/^\[\[n:(\d+)\]\]$/);
    if (match) {
      const noteNumber = Number(match[1]);
      const marker = <NoteMarker key={`${index}-note`} noteNumber={noteNumber} onNoteClick={onNoteClick} />;
      // 脚注标号是整体：只有整段都在高亮区间内才套 mark，避免半个标号被高亮。
      const markerHighlighted =
        highlight != null && partStart >= highlight.start && cursor <= highlight.end;
      nodes.push(
        markerHighlighted ? (
          <mark
            key={`${index}-mark`}
            className={HIGHLIGHT_MARK_CLASS}
            data-bookmark-highlight="true"
            data-bookmark-highlight-nonce={highlightNonce}
          >
            {marker}
          </mark>
        ) : (
          marker
        ),
      );
      return;
    }

    if (!highlight) {
      nodes.push(<Fragment key={index}>{part}</Fragment>);
      return;
    }

    const from = Math.max(partStart, highlight.start);
    const to = Math.min(cursor, highlight.end);
    if (from >= to) {
      nodes.push(<Fragment key={index}>{part}</Fragment>);
      return;
    }

    const relativeFrom = from - partStart;
    const relativeTo = to - partStart;
    nodes.push(
      <Fragment key={index}>
        {part.slice(0, relativeFrom)}
        <mark
          className={HIGHLIGHT_MARK_CLASS}
          data-bookmark-highlight="true"
          data-bookmark-highlight-nonce={highlightNonce}
        >
          {part.slice(relativeFrom, relativeTo)}
        </mark>
        {part.slice(relativeTo)}
      </Fragment>,
    );
  });

  return <>{nodes}</>;
}
