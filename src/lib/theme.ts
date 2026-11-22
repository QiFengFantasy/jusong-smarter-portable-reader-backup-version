/**
 * 强调色主题：UI 唯一强调色槽位 `--cinnabar` 的色板 + 封面占位渐变槽位。
 *
 * - 强调色：替换全应用 `hsl(var(--cinnabar))` 的色相（按钮/选中/进度/链接/高亮/Hero 抽象图形）；
 * - 封面占位色：独立设置，写入 `--cover-from/via/to`，由 BookCard/BookCover 的占位封面使用；
 * - 品牌 App 图标不随主题变化（脚本生成的静态图标），Hero 抽象图形/水印等艺术素材随强调色。
 *
 * 颜色统一使用 CSS 变量（`h s% l%` 三元组），主题切换只改 documentElement 的内联变量，
 * 不重建样式表；默认即现有朱红。
 */

export type AccentThemeId = "cinnabar" | "sky" | "cyan" | "orange" | "violet";

export interface AccentTheme {
  id: AccentThemeId;
  label: string;
  /** 主强调色 HSL 三元组（h s% l%），写入 `--cinnabar`。 */
  accent: string;
  /** 封面占位渐变三色（HSL 三元组）。 */
  coverGradient: { from: string; via: string; to: string };
}

/** 朱红为现有默认；其余为可选色系（同一明度/饱和度区间，保证纸墨风可读性）。 */
export const ACCENT_THEMES: AccentTheme[] = [
  {
    id: "cinnabar",
    label: "朱红",
    accent: "6 70% 37%",
    coverGradient: { from: "6 62% 34%", via: "5 69% 30%", to: "6 64% 16%" },
  },
  {
    id: "sky",
    label: "天蓝",
    accent: "205 78% 42%",
    coverGradient: { from: "205 70% 40%", via: "207 72% 33%", to: "209 65% 18%" },
  },
  {
    id: "cyan",
    label: "青",
    accent: "186 74% 34%",
    coverGradient: { from: "186 68% 32%", via: "188 72% 26%", to: "190 60% 14%" },
  },
  {
    id: "orange",
    label: "橙",
    accent: "28 88% 46%",
    coverGradient: { from: "28 78% 44%", via: "26 82% 37%", to: "24 70% 20%" },
  },
  {
    id: "violet",
    label: "紫",
    accent: "265 55% 46%",
    coverGradient: { from: "265 50% 44%", via: "267 52% 36%", to: "269 45% 21%" },
  },
];

export const DEFAULT_ACCENT_THEME: AccentThemeId = "cinnabar";
export const DEFAULT_COVER_THEME: AccentThemeId = "cinnabar";

const THEME_BY_ID = new Map<AccentThemeId, AccentTheme>(ACCENT_THEMES.map((theme) => [theme.id, theme]));

export function isAccentThemeId(value: unknown): value is AccentThemeId {
  return typeof value === "string" && THEME_BY_ID.has(value as AccentThemeId);
}

export function accentThemeOf(id: AccentThemeId | undefined | null): AccentTheme {
  return THEME_BY_ID.get(id ?? DEFAULT_ACCENT_THEME) ?? ACCENT_THEMES[0];
}

export interface ThemeSelection {
  accentColor: AccentThemeId;
  coverColor: AccentThemeId;
}

/**
 * 应用主题到当前文档：只写 CSS 变量，幂等、可在设置变更时反复调用。
 * 非浏览器环境（单测）静默跳过。
 */
export function applyTheme(selection: ThemeSelection): void {
  if (typeof document === "undefined") return;
  const accent = accentThemeOf(selection.accentColor);
  const cover = accentThemeOf(selection.coverColor);
  const root = document.documentElement;
  root.style.setProperty("--cinnabar", accent.accent);
  root.style.setProperty("--cover-from", cover.coverGradient.from);
  root.style.setProperty("--cover-via", cover.coverGradient.via);
  root.style.setProperty("--cover-to", cover.coverGradient.to);
}
