import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Quote, Send, Square, X } from "lucide-react";

import { Button } from "../ui/button";
import { cn, excerpt as excerptText } from "../../lib/utils";
import type { AgentContext } from "../../lib/agent";

/** 输入框上限：与 Rust 侧单条消息上限（16000）相比留出余量。 */
const MAX_INPUT_CHARS = 4000;

/**
 * 阅读器划词引用输入：`nonce` 变化时把 `text` 插入输入区（不自动发送），
 * 与「插入当前章节」的 excerpt 引用块可叠加，同类引用只保留一个（新引用替换旧引用）。
 */
export interface AgentQuoteInput {
  text: string;
  chapterId?: string;
  chapterTitle?: string;
  nonce: number;
}

/**
 * 程序化预填输入框（可选）：`nonce` 变化时把 `text` 写入输入区（覆盖当前草稿，
 * 不自动发送）。探索面板「其他」卡片用它把「更新/添加」提示词交给 AGENT。
 */
export interface AgentPrefillInput {
  text: string;
  nonce: number;
}

export interface AgentComposerProps {
  compact: boolean;
  /** 未配置模型/配置加载中：禁止发送。 */
  disabled: boolean;
  streaming: boolean;
  /** 阅读器传入的当前章节；只有 `compact` 且带 `excerpt` 时显示「插入当前章节」。 */
  context?: AgentContext;
  /** 阅读器划词引用（可选）；nonce 变化才插入，不自动发送。 */
  quote?: AgentQuoteInput;
  /** 程序化预填提示词（可选）；nonce 变化时覆盖输入框，不自动发送。 */
  prefill?: AgentPrefillInput;
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string, context?: AgentContext) => void;
  onStop: () => void;
}

interface SelectedQuote {
  text: string;
  chapterId?: string;
  chapterTitle?: string;
}

/**
 * AGENT 输入区：发送/停止、Enter 发送，「插入当前章节」以及划词引用块。
 * 引用默认不携带，用户明确插入/划选后才随本轮消息发给模型，并显示为引用块。
 */
export function AgentComposer({
  compact,
  disabled,
  streaming,
  context,
  quote,
  prefill,
  value,
  onChange,
  onSend,
  onStop,
}: AgentComposerProps) {
  const [attached, setAttached] = useState(false);
  const [selectedQuote, setSelectedQuote] = useState<SelectedQuote | null>(null);
  const appliedQuoteNonce = useRef<number | null>(null);
  const appliedPrefillNonce = useRef<number | null>(null);
  const canAttach = Boolean(compact && context?.excerpt && context.excerpt.trim());
  const referenceLabel = [context?.bookTitle, context?.chapterTitle].filter(Boolean).join(" · ");

  // 划词引用：只在 nonce 变化时插入（替换旧引用），不自动发送、不覆盖输入框文字。
  useEffect(() => {
    if (!quote) return;
    if (appliedQuoteNonce.current === quote.nonce) return;
    appliedQuoteNonce.current = quote.nonce;
    const text = quote.text.trim();
    if (!text) return;
    setSelectedQuote({
      text,
      chapterId: quote.chapterId,
      chapterTitle: quote.chapterTitle,
    });
  }, [quote]);

  // 程序化预填（非划词引用）：nonce 变化时覆盖输入框，便于用户直接修改后发送。
  useEffect(() => {
    if (!prefill) return;
    if (appliedPrefillNonce.current === prefill.nonce) return;
    appliedPrefillNonce.current = prefill.nonce;
    const text = prefill.text.trim();
    if (!text) return;
    onChange(text);
  }, [prefill, onChange]);

  /** 组装本轮发送的上下文：章节摘录（仅在用户点插入时）+ 划词引用（可叠加）。 */
  const buildSendContext = (): AgentContext | undefined => {
    const includeChapter = Boolean(canAttach && attached && context?.excerpt?.trim());
    const includeQuote = Boolean(selectedQuote);
    if (!includeChapter && !includeQuote) return undefined;

    const chapterId = context?.chapterId ?? selectedQuote?.chapterId;
    const chapterTitle = context?.chapterTitle ?? selectedQuote?.chapterTitle;
    const next: AgentContext = {};
    if (context?.bookId) next.bookId = context.bookId;
    if (context?.bookTitle) next.bookTitle = context.bookTitle;
    if (chapterId) next.chapterId = chapterId;
    if (chapterTitle) next.chapterTitle = chapterTitle;
    if (includeChapter && context?.excerpt) next.excerpt = context.excerpt;
    if (selectedQuote) {
      next.quote = selectedQuote.text;
      if (selectedQuote.chapterTitle) next.quoteChapterTitle = selectedQuote.chapterTitle;
    }
    return next;
  };

  const submit = () => {
    const text = value.trim();
    if (!text || streaming || disabled) return;
    onSend(text, buildSendContext());
    setAttached(false);
    setSelectedQuote(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送、Shift+Enter 换行；输入法合成中不触发。
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const placeholder = disabled
    ? "配置模型后即可提问"
    : streaming
      ? "正在生成回答…"
      : "输入你的问题…";

  return (
    <div className="space-y-1.5">
      {selectedQuote ? (
        <div className="relative rounded-md border border-cinnabar/25 bg-cinnabar/5 px-2.5 py-1.5">
          <p className="pr-6 text-[10px] font-medium tracking-wide text-cinnabar/80">
            {selectedQuote.chapterTitle
              ? `用户选中原文 · ${selectedQuote.chapterTitle}`
              : "用户选中原文"}
          </p>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[11px] leading-5 text-ink-soft">
            {excerptText(selectedQuote.text, 200)}
          </p>
          <button
            type="button"
            onClick={() => setSelectedQuote(null)}
            aria-label="移除选中原文"
            className="absolute right-1.5 top-1.5 rounded p-1 text-ink-soft/70 hover:bg-paper hover:text-ink"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {canAttach ? (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setAttached((current) => !current)}
            aria-pressed={attached}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30",
              attached
                ? "border-cinnabar/40 bg-cinnabar/10 text-cinnabar"
                : "border-border/70 bg-paper text-ink-soft hover:border-cinnabar/30 hover:text-ink",
            )}
          >
            <Quote className="h-3 w-3" aria-hidden="true" />
            {attached ? "已插入当前章节" : "插入当前章节"}
          </button>
          {attached ? (
            <button
              type="button"
              onClick={() => setAttached(false)}
              className="text-[10px] text-ink-soft/70 hover:text-ink"
            >
              取消引用
            </button>
          ) : null}
        </div>
      ) : null}

      {canAttach && attached && context?.excerpt ? (
        <div className="relative rounded-md border border-cinnabar/20 bg-cinnabar/5 px-2.5 py-1.5">
          <p className="pr-6 text-[10px] font-medium tracking-wide text-cinnabar/80">
            {referenceLabel ? `本轮附带 · ${referenceLabel}` : "本轮附带 · 当前章节"}
          </p>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[11px] leading-5 text-ink-soft">
            {excerptText(context.excerpt, 200)}
          </p>
          <button
            type="button"
            onClick={() => setAttached(false)}
            aria-label="取消引用"
            className="absolute right-1.5 top-1.5 rounded p-1 text-ink-soft/70 hover:bg-paper hover:text-ink"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, MAX_INPUT_CHARS))}
          onKeyDown={handleKeyDown}
          rows={compact ? 1 : 2}
          maxLength={MAX_INPUT_CHARS}
          placeholder={placeholder}
          aria-label="AGENT 输入"
          className={cn(
            "min-h-[2.25rem] flex-1 resize-none rounded-lg border border-border bg-paper px-2.5 py-2 text-[13px] leading-5 text-ink placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-cinnabar/30",
            compact && "min-h-[2rem] py-1.5 text-xs",
          )}
        />
        {streaming ? (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={onStop}
            aria-label="停止生成"
            title="停止生成"
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            onClick={submit}
            disabled={disabled || !value.trim()}
            aria-label="发送"
            title={disabled ? "先在设置中配置模型" : "发送"}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 text-[10px] text-ink-soft/60">
        <span>{streaming ? "生成中，可点击停止" : "Enter 发送 · Shift+Enter 换行"}</span>
        {value.length > MAX_INPUT_CHARS - 400 ? (
          <span>
            {value.length}/{MAX_INPUT_CHARS}
          </span>
        ) : null}
      </div>
    </div>
  );
}
