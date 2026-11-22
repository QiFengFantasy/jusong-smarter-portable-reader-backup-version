import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, MoveHorizontal } from "lucide-react";

import { cn } from "../../lib/utils";
import type { ReaderSwipeDirection } from "./useReaderGestures";

/**
 * 阅读器正文两侧的翻章控件与滑动进度反馈。
 *
 * - `ReaderEdgeNav`：桌面端正文左右边缘垂直居中的透明箭头，点击上一/下一章；
 *   移动端不渲染（`hidden lg:block`，与阅读器内联三栏断点一致），
 *   且只在 hover/focus 时加深颜色，平时不抢正文注意力。
 * - `ReaderSwipeProgress`：移动端左右滑动翻章时的进度环（SVG 环 + 方向箭头），
 *   达到阈值时环与箭头变为强调色（cinnabar）。由 `useReaderGestures` 通过
 *   `overlay` 返回渲染，也可以单独使用。
 */

/** 进度环半径与周长（viewBox 64x64）。 */
const RING_RADIUS = 26;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export interface ReaderSwipeProgressProps {
  /** 手势是否进行中；回弹动画期间为 false，但 progress 仍 > 0。 */
  active: boolean;
  /** 0-1 进度：`|dx| / 面板宽度 / 阈值`。 */
  progress: number;
  /** 当前方向；null 表示未判定或该方向无章节可翻（不显示方向箭头）。 */
  direction: ReaderSwipeDirection | null;
}

/**
 * 滑动翻章进度环。
 *
 * 视觉：纸色半透明圆底 + 中性色 SVG 环，进度用 `stroke-dashoffset` 表示；
 * 达到阈值（progress >= 1）时环与箭头切换为强调色，提示「松手即翻章」。
 * `pointer-events-none`，不阻断正文滚动/选择。
 */
export function ReaderSwipeProgress({ active, progress, direction }: ReaderSwipeProgressProps) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  // 回弹结束（progress 归零且手势已结束）时不渲染。
  if (!active && clamped <= 0.001) return null;

  const reached = clamped >= 1;
  const Arrow =
    direction === "prev" ? ArrowLeft : direction === "next" ? ArrowRight : MoveHorizontal;

  return (
    <div
      data-reader-swipe-progress="true"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center"
    >
      <div
        className={cn(
          "relative flex h-[72px] w-[72px] items-center justify-center rounded-full border border-border/60 bg-paper/90 shadow-paper backdrop-blur-sm transition-opacity",
          active ? "opacity-100" : "opacity-60",
        )}
      >
        <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full -rotate-90">
          {/* 轨道环 */}
          <circle
            cx={32}
            cy={32}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={3}
            className="stroke-border/70"
          />
          {/* 进度环：达到阈值后变为强调色 */}
          <circle
            cx={32}
            cy={32}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped)}
            className={cn(
              "transition-[stroke] duration-100",
              reached ? "stroke-cinnabar" : "stroke-ink-soft",
            )}
          />
        </svg>
        <Arrow
          className={cn(
            "relative h-7 w-7 transition-colors",
            reached ? "text-cinnabar" : "text-ink-soft",
          )}
        />
      </div>
    </div>
  );
}

export interface ReaderEdgeNavProps {
  /** 是否有上一章；没有时不渲染左侧箭头。 */
  canPrev: boolean;
  /** 是否有下一章；没有时不渲染右侧箭头。 */
  canNext: boolean;
  /** 上一章（右滑手势与左侧箭头共用）。 */
  onPrev: () => void;
  /** 下一章（左滑手势与右侧箭头共用）。 */
  onNext: () => void;
  /** 覆盖层/抽屉打开等场景下整体隐藏。 */
  hidden?: boolean;
  /** 追加到定位容器的类名（默认 `absolute inset-0`，由调用方保证父级 relative）。 */
  className?: string;
}

/**
 * 桌面端左右边缘翻章箭头。
 *
 * 透明背景 + `text-ink-soft`，hover/focus 时加深；定位容器 `pointer-events-none`，
 * 只有箭头按钮本身接收点击，避免挡住正文选中文字。移动端（< lg）不渲染。
 * 右侧箭头留出 8px 给滚动条，避免挡住 ScrollArea 的拖拽。
 */
export function ReaderEdgeNav({
  canPrev,
  canNext,
  onPrev,
  onNext,
  hidden = false,
  className,
}: ReaderEdgeNavProps) {
  if (hidden) return null;

  return (
    <div
      data-reader-edge-nav="true"
      className={cn("pointer-events-none absolute inset-0 z-20 hidden lg:block", className)}
    >
      {canPrev ? (
        <button
          type="button"
          data-reader-edge-prev="true"
          aria-label="上一章"
          title="上一章"
          onClick={onPrev}
          className="pointer-events-auto absolute left-0 top-1/2 flex h-28 w-9 -translate-y-1/2 items-center justify-start rounded-r-full pl-1 text-ink-soft/50 transition-colors hover:bg-muted/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cinnabar/40"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
      ) : null}

      {canNext ? (
        <button
          type="button"
          data-reader-edge-next="true"
          aria-label="下一章"
          title="下一章"
          onClick={onNext}
          className="pointer-events-auto absolute right-2 top-1/2 flex h-28 w-9 -translate-y-1/2 items-center justify-end rounded-l-full pr-1 text-ink-soft/50 transition-colors hover:bg-muted/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cinnabar/40"
        >
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
