import { AlertTriangle, Loader2, RotateCcw, Settings2, Sparkles } from "lucide-react";

import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

export type AgentEmptyVariant = "loading" | "config-error" | "unconfigured" | "welcome";

interface AgentEmptyStateProps {
  variant: AgentEmptyVariant;
  compact?: boolean;
  configError?: string | null;
  /** 按入口（首页 / 阅读器）给出的示例提问，点击只填入输入框。 */
  prompts?: string[];
  onOpenSettings: () => void;
  onRetryConfig?: () => void;
  onPickPrompt?: (prompt: string) => void;
}

/** AGENT 空态：加载中 / 配置读取失败 / 未配置（引导去设置）/ 已就绪欢迎页。 */
export function AgentEmptyState({
  variant,
  compact = false,
  configError,
  prompts,
  onOpenSettings,
  onRetryConfig,
  onPickPrompt,
}: AgentEmptyStateProps) {
  if (variant === "loading") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center text-xs text-ink-soft">
        <Loader2 className="h-5 w-5 animate-spin text-cinnabar/70" aria-hidden="true" />
        <p>正在读取 AGENT 配置…</p>
      </div>
    );
  }

  if (variant === "config-error") {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-cinnabar/25 bg-cinnabar/5 px-5 py-6 text-center">
        <AlertTriangle className="mx-auto h-6 w-6 text-cinnabar" aria-hidden="true" />
        <p className="mt-3 font-serif text-base tracking-wide text-ink">无法读取 AGENT 配置</p>
        <p className="mt-1.5 text-xs leading-6 text-ink-soft">
          {configError || "请稍后重试，或到设置页重新保存配置。"}
        </p>
        {onRetryConfig ? (
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={onRetryConfig}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            重试
          </Button>
        ) : null}
      </div>
    );
  }

  if (variant === "unconfigured") {
    return (
      <div
        className={cn(
          "mx-auto rounded-xl border border-dashed border-border bg-paper-soft/40 text-center",
          compact ? "max-w-sm px-4 py-6" : "max-w-md px-6 py-10",
        )}
      >
        <Settings2 className="mx-auto h-6 w-6 text-cinnabar/70" aria-hidden="true" />
        <p className="mt-3 font-serif text-lg tracking-wide text-ink">尚未配置模型</p>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-6 text-ink-soft">
          在「设置 → AGENT」中填入 DeepSeek API Key 后即可开始对话。密钥只保存在本机用户库，
          不会出现在界面或日志里。
        </p>
        <Button type="button" size="sm" className="mt-4" onClick={onOpenSettings}>
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          前往设置配置
        </Button>
      </div>
    );
  }

  const picks = prompts && prompts.length > 0 ? prompts : [];
  const visiblePrompts = compact ? picks.slice(0, 2) : picks.slice(0, 3);
  return (
    <div
      className={cn(
        "mx-auto rounded-xl border border-border/70 bg-paper-soft/40 text-center",
        compact ? "max-w-sm px-4 py-6" : "max-w-lg px-6 py-10",
      )}
    >
      <Sparkles className="mx-auto h-6 w-6 text-cinnabar/60" aria-hidden="true" />
      <p className="mt-3 font-serif text-lg tracking-wide text-ink">从一处疑问开始</p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-ink-soft">
        {compact
          ? "可以直接提问，也可以把当前章节插入本轮对话再问。"
          : "提问、梳理、比较。阅读器侧栏还能把当前章节插进本轮对话，让回答贴合原文。"}
      </p>
      {visiblePrompts.length > 0 ? (
        <div className="mt-4 flex flex-col items-center gap-1.5">
          {visiblePrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPickPrompt?.(prompt)}
              className="w-full rounded-md border border-border/70 bg-paper px-3 py-1.5 text-left text-[11px] leading-5 text-ink-soft transition-colors hover:border-cinnabar/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
