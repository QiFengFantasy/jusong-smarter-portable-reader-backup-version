import { cn } from "../../lib/utils";

export interface BrandGlyphProps {
  className?: string;
}

/**
 * 品牌抽象图形（图标中的叠页 / 沮形记号）的透明遮罩材质。
 * 颜色由父级 text-* 决定：组件用 bg-current + CSS mask 上色，
 * 适合 Hero 水印、印章内图形等可复用装饰；不承载任何文案。
 */
export function BrandGlyph({ className }: BrandGlyphProps) {
  return <span aria-hidden="true" className={cn("brand-glyph block bg-current", className)} />;
}
