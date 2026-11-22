import { CornerUpLeft } from "lucide-react";

import { cn } from "../../lib/utils";

/**
 * 阅读器正文区域的悬浮操作。
 *
 * 「回到刚刚阅读位置」：正文左上角 36px 圆形按钮（强调色填充 + 纸色图标），
 * 复用正文底部「创建书签 / 引用到 AGENT」悬浮按钮的视觉；仅在有可回退位置时显示。
 * 由 lead 放在中间正文面板容器（`relative`）内。
 */
export interface ReaderFloatingActionsProps {
  /** 是否有可回退的阅读位置（跳转书签/注释后为 true）。 */
  canJumpBack: boolean;
  /** 回到跳转前的位置。 */
  onJumpBack: () => void;
  /** 追加定位类名（默认 `absolute left-4 top-4`，父级需 `relative`）。 */
  className?: string;
}

export function ReaderFloatingActions({
  canJumpBack,
  onJumpBack,
  className,
}: ReaderFloatingActionsProps) {
  if (!canJumpBack) return null;

  return (
    <button
      type="button"
      data-reader-jump-back="true"
      aria-label="回到刚刚阅读位置"
      title="回到刚刚阅读位置"
      onClick={onJumpBack}
      className={cn(
        "absolute left-4 top-4 z-30 inline-flex h-9 w-9 items-center justify-center rounded-full bg-cinnabar text-paper-soft shadow-paper transition-colors hover:bg-cinnabar/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40",
        className,
      )}
    >
      <CornerUpLeft className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
