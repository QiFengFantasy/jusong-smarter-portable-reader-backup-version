import { AlertCircle, BookmarkPlus, Bot, Check, Loader2, UserRound } from "lucide-react";

import type { AgentContext, AgentMessage } from "../../lib/agent";
import { cn, excerpt as excerptText } from "../../lib/utils";

/** 用户消息里附带的引用块：章节摘录（插入当前章节）与划词选中原文可同时存在。 */
export function AgentQuoteBlock({ context }: { context: AgentContext }) {
  const label = [context.bookTitle, context.chapterTitle].filter(Boolean).join(" · ");
  const quoteLabel = context.quoteChapterTitle
    ? `用户选中原文 · ${context.quoteChapterTitle}`
    : "用户选中原文";
  return (
    <>
      {context.excerpt ? (
        <figure className="mb-1.5 rounded-md border-l-2 border-cinnabar/60 bg-paper-soft/90 px-2.5 py-1.5 text-left">
          <figcaption className="text-[10px] font-medium tracking-wide text-cinnabar/80">
            {label ? `引用 · ${label}` : "引用 · 当前章节"}
          </figcaption>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[11px] leading-5 text-ink-soft">
            {excerptText(context.excerpt, 180)}
          </p>
        </figure>
      ) : null}
      {context.quote ? (
        <figure className="mb-1.5 rounded-md border-l-2 border-cinnabar/60 bg-paper-soft/90 px-2.5 py-1.5 text-left">
          <figcaption className="text-[10px] font-medium tracking-wide text-cinnabar/80">
            {quoteLabel}
          </figcaption>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[11px] leading-5 text-ink-soft">
            {excerptText(context.quote, 180)}
          </p>
        </figure>
      ) : null}
    </>
  );
}

/** 「保存到知识库」按钮的三态（saved 由消息本身的 knowledgeSaved 决定，见 AgentConsole）。 */
export type AgentSaveStatus = "saving" | "saved" | "error";

interface AgentMessageBubbleProps {
  message: AgentMessage;
  compact?: boolean;
  /** 仅阅读器入口的助手消息传入；存在即显示「保存到知识库」。 */
  onSaveToKnowledge?: () => void;
  saveStatus?: AgentSaveStatus;
  saveError?: string;
}

/** 单条对话气泡：用户（右）/ 助手（左）/ 系统提示（居中）；错误消息用警示样式。 */
export function AgentMessageBubble({
  message,
  compact = false,
  onSaveToKnowledge,
  saveStatus,
  saveError,
}: AgentMessageBubbleProps) {
  if (message.role === "system") {
    return (
      <p
        className={cn(
          "mx-auto max-w-[90%] rounded-md bg-muted/60 px-2.5 py-1.5 text-center text-[11px] leading-5 text-ink-soft",
          compact && "text-[10px]",
        )}
      >
        {message.text}
      </p>
    );
  }

  const isUser = message.role === "user";
  const saveable = !isUser && !message.error && onSaveToKnowledge;
  const saved = saveStatus === "saved";
  const saving = saveStatus === "saving";
  return (
    <div className={cn("flex items-start gap-2", isUser ? "flex-row-reverse" : "flex-row")}>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid shrink-0 place-items-center rounded-md",
          compact ? "h-6 w-6" : "h-7 w-7",
          isUser ? "bg-muted text-ink-soft" : "bg-cinnabar/10 text-cinnabar",
        )}
      >
        {isUser ? (
          <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </span>
      <div className={cn("min-w-0", isUser ? "max-w-[85%] text-right" : "max-w-[90%]")}>
        {isUser && (message.context?.excerpt || message.context?.quote) ? (
          <AgentQuoteBlock context={message.context} />
        ) : null}
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-left text-[13px] leading-6",
            isUser
              ? "bg-cinnabar text-paper-soft"
              : "border border-border/70 bg-paper-soft/70 text-ink",
            message.error && "border-cinnabar/30 bg-cinnabar/5 text-cinnabar",
            compact && "px-2.5 py-1.5 text-xs leading-5",
          )}
        >
          {message.error ? (
            <span className="mb-1 flex items-center gap-1 text-[11px] font-medium">
              <AlertCircle className="h-3 w-3" aria-hidden="true" />
              请求失败
            </span>
          ) : null}
          {message.text}
        </div>
        {saveable ? (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={onSaveToKnowledge}
              disabled={saving || saved}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30",
                saved
                  ? "cursor-default border-emerald-700/30 bg-emerald-700/10 text-emerald-800"
                  : "border-border/70 bg-paper text-ink-soft hover:border-cinnabar/40 hover:text-ink disabled:cursor-wait disabled:opacity-70",
              )}
            >
              {saved ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : saving ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <BookmarkPlus className="h-3 w-3" aria-hidden="true" />
              )}
              {saved ? "已保存到知识库" : saving ? "保存中…" : "保存到知识库"}
            </button>
            {saveStatus === "error" && saveError ? (
              <p role="alert" className="mt-1 text-[10px] leading-4 text-cinnabar">
                {saveError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 流式输出中的助手气泡：空文本时显示「正在思考」。 */
export function AgentStreamingBubble({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid shrink-0 place-items-center rounded-md bg-cinnabar/10 text-cinnabar",
          compact ? "h-6 w-6" : "h-7 w-7",
        )}
      >
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "max-w-[90%] rounded-xl border border-border/70 bg-paper-soft/70 px-3 py-2 text-[13px] leading-6 text-ink",
          compact && "px-2.5 py-1.5 text-xs leading-5",
        )}
      >
        {text ? (
          <>
            <span className="whitespace-pre-wrap break-words">{text}</span>
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-cinnabar align-middle" aria-hidden="true" />
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-ink-soft">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cinnabar/70" aria-hidden="true" />
            正在思考…
          </span>
        )}
      </div>
    </div>
  );
}
