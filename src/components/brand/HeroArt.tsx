import { BrandGlyph } from "./BrandGlyph";
import { cn } from "../../lib/utils";

export type HeroArtVariant = "large" | "compact";

interface HeroArtTokens {
  watermark: string;
  seal: string;
  corner: string;
}

const VARIANTS: Record<HeroArtVariant, HeroArtTokens> = {
  large: {
    watermark: "-right-10 -top-14 h-[16rem] w-[16rem] rotate-[-6deg] sm:h-[20rem] sm:w-[20rem]",
    seal: "bottom-5 right-5 h-14 w-14 sm:bottom-6 sm:right-7 sm:h-16 sm:w-16",
    corner: "bottom-5 left-5 h-7 w-7",
  },
  compact: {
    watermark: "-right-6 -top-10 h-[9rem] w-[9rem] rotate-[-6deg]",
    seal: "bottom-2.5 right-3 h-9 w-9",
    corner: "bottom-3 left-3 h-5 w-5",
  },
};

export interface HeroArtProps {
  /** large：关于软件页 Hero；compact：检索空状态等小面积场景。 */
  variant?: HeroArtVariant;
  className?: string;
}

/**
 * 纯装饰层：品牌抽象图形水印 + 右下书斋印章（内嵌同一图形）+ 纸纹与朱红细线。
 * 不含任何文案/交互；父容器需 `relative overflow-hidden`，本组件本身不拦截点击。
 */
export function HeroArt({ variant = "large", className }: HeroArtProps) {
  const tokens = VARIANTS[variant];
  const compact = variant === "compact";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 select-none overflow-hidden",
        className,
      )}
    >
      {/* 纸纹：横向经纬 + 右上暖光 */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, hsl(var(--ink) / 0.03) 0px, hsl(var(--ink) / 0.03) 1px, transparent 1px, transparent 4px)",
          opacity: compact ? 0.6 : 0.75,
        }}
      />
      <div className="absolute -right-20 -top-24 h-56 w-56 rounded-full bg-cinnabar/[0.06] blur-3xl" />
      {compact ? null : (
        <div className="absolute -bottom-16 -left-16 h-48 w-48 rounded-full bg-ink/[0.03] blur-3xl" />
      )}

      {/* 品牌抽象图形水印（复用图标中的米白记号，mask 上色） */}
      <BrandGlyph className={cn("absolute text-cinnabar/[0.055]", tokens.watermark)} />

      {/* 右下书斋印章：保留「书斋」文字印记 */}
      <span
        className={cn(
          "absolute flex rotate-6 items-center justify-center rounded-sm border border-cinnabar/20 font-serif tracking-widest text-cinnabar/25",
          compact ? "text-[10px] tracking-[0.12em]" : "text-lg sm:text-xl",
          tokens.seal,
        )}
      >
        书斋
      </span>

      {/* 朱红细线：顶部细线 + 左下角框线 + 斜向短线 */}
      <span
        className="absolute inset-x-0 top-0 h-px"
        style={{
          backgroundImage:
            "linear-gradient(to right, transparent, hsl(var(--cinnabar) / 0.28), transparent)",
        }}
      />
      <span className={cn("absolute border-b border-l border-cinnabar/20", tokens.corner)} />
      <span
        className="absolute -left-8 bottom-10 h-px w-44 rotate-[-14deg]"
        style={{
          backgroundImage: "linear-gradient(to right, transparent, hsl(var(--cinnabar) / 0.16))",
        }}
      />
      {compact ? null : (
        <>
          <span className="absolute right-6 top-5 h-px w-10 bg-cinnabar/20" />
          <span className="absolute right-6 top-5 h-10 w-px bg-cinnabar/10" />
        </>
      )}
    </div>
  );
}
