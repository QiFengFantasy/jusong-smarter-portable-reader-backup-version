import { cn } from "../../lib/utils";

export type BrandMarkSize = "sm" | "md" | "lg";

const ICON_SIZES: Record<BrandMarkSize, string> = {
  sm: "h-6 w-6",
  md: "h-8 w-8",
  lg: "h-12 w-12",
};

const GAP_SIZES: Record<BrandMarkSize, string> = {
  sm: "gap-1.5",
  md: "gap-2",
  lg: "gap-3",
};

const WORDMARK_SIZES: Record<BrandMarkSize, string> = {
  sm: "text-sm tracking-[0.2em]",
  md: "text-lg tracking-[0.22em]",
  lg: "text-2xl tracking-[0.24em]",
};

const SUBTITLE_SIZES: Record<BrandMarkSize, string> = {
  sm: "mt-0.5 text-[8px] tracking-[0.32em]",
  md: "mt-1 text-[9px] tracking-[0.36em]",
  lg: "mt-1.5 text-[10px] tracking-[0.4em]",
};

export interface BrandMarkProps {
  /** 图标与字标尺寸；sm 用于列表/页脚，md 用于栏目标题，lg 用于 Hero。 */
  size?: BrandMarkSize;
  /** 是否显示右侧「沮诵」字标；关闭后只渲染图标（无障碍名仍为「沮诵」）。 */
  showWordmark?: boolean;
  /** 字标下方是否显示 JUSONG 小字。 */
  showSubtitle?: boolean;
  className?: string;
}

/**
 * 品牌标识：`/app-icon.png` + 「沮诵」字标（可选 JUSONG 小字）。
 * 纯展示组件，不产生导航；需要点击时由外层包 Link / button。
 */
export function BrandMark({
  size = "md",
  showWordmark = true,
  showSubtitle = false,
  className,
}: BrandMarkProps) {
  return (
    <span className={cn("inline-flex select-none items-center", GAP_SIZES[size], className)}>
      <img
        src="/app-icon.png"
        alt={showWordmark ? "" : "沮诵"}
        draggable={false}
        className={cn("shrink-0", ICON_SIZES[size])}
      />
      {showWordmark ? (
        <span className="flex flex-col leading-none">
          <span className={cn("font-serif font-semibold text-ink", WORDMARK_SIZES[size])}>沮诵</span>
          {showSubtitle ? (
            <span
              className={cn("uppercase text-ink-soft/60", SUBTITLE_SIZES[size])}
              aria-hidden="true"
            >
              JUSONG
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
