import type { PaneWidthControls, PaneSide } from "../../lib/usePaneWidth";
import { cn } from "../../lib/utils";

interface PaneResizerProps {
  side: PaneSide;
  controls: PaneWidthControls;
  /** 与对应侧栏一致的显示断点，例如 "lg:block" / "xl:block"。 */
  className?: string;
  /** 无障碍标签，同时也作为 title。 */
  label: string;
  /** 被调整宽度的侧栏元素 id（aria-controls）。 */
  controlsTargetId?: string;
}

/**
 * 阅读器侧栏之间的拖拽分隔条。
 *
 * 外层是 0 宽占位，真正可点的把手向两侧各溢出 6px：不改变原有布局宽度，
 * 但 12px 的命中区域足够好拖。外观是一条细线，悬停/拖动时加粗成朱红。
 */
export function PaneResizer({
  side,
  controls,
  className,
  label,
  controlsTargetId,
}: PaneResizerProps) {
  const { width, limit, dragging, handleProps } = controls;
  const hint = `${label}：拖动调整宽度，双击或按 Enter 恢复默认，方向键微调`;

  return (
    <div
      data-pane-resizer={side}
      className={cn("group relative z-20 hidden w-0 shrink-0", className)}
    >
      <div
        {...handleProps}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-controls={controlsTargetId}
        aria-valuemin={controls.minWidth}
        aria-valuemax={limit}
        aria-valuenow={width}
        aria-valuetext={`${width} 像素`}
        aria-description={hint}
        tabIndex={0}
        title={hint}
        className={cn(
          "absolute inset-y-0 -left-1.5 flex w-3 cursor-col-resize touch-none select-none items-center justify-center",
          "focus-visible:outline-none",
          "focus-visible:bg-cinnabar/10",
          dragging && "bg-cinnabar/10",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none h-full rounded-full transition-[width,background-color] duration-150",
            dragging
              ? "w-[3px] bg-cinnabar/60"
              : "w-px bg-border/80 group-hover:w-[3px] group-hover:bg-cinnabar/40",
          )}
        />
        {/* 拖动时在把手中心显示一条更明显的朱红提示线（仅视觉）。 */}
        {dragging ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-cinnabar/70"
          />
        ) : null}
      </div>
    </div>
  );
}
