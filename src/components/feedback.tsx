import type { ReactNode } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} aria-hidden="true" />;
}

export function LoadingPanel({
  label = "正在载入…",
  className,
  compact = false,
}: {
  label?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-3 text-center text-ink-soft",
        compact ? "py-10" : "py-20",
        className,
      )}
    >
      <Spinner className="h-5 w-5 text-cinnabar" />
      <p className="text-sm tracking-wide">{label}</p>
    </div>
  );
}

export function ErrorPanel({
  title = "出了点问题",
  message,
  onRetry,
  retryLabel = "重试",
  action,
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-lg border border-cinnabar/25 bg-cinnabar/[0.06] px-4 py-4 sm:px-5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-cinnabar" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-serif text-sm font-semibold tracking-wide text-ink">{title}</p>
          <p className="mt-1 break-words text-xs leading-6 text-ink-soft">{message}</p>
          {action ? <div className="mt-3">{action}</div> : null}
        </div>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {retryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
