/**
 * 首页布局常量与入口层级的兼容辅助。
 *
 * 第二批起首页中间内容由「入口（左）+ 子项 / 常驻项（右）」决定（见 `home-nav.ts`），
 * 旧的单一 `HomeView`（shelf/knowledge/search/ai/settings/about）只保留为
 * 导航 state `{ openView }` 的一次性兼容字段（如 AGENT「前往设置配置」），
 * 启动行为由设置 `navMemory` 控制；旧的 `startupView` 字段已清理。
 */
import type { PaneWidthConfig } from "./paneResize";
import type { HomeSelection } from "./home-nav";
import { firstNavChild } from "./home-nav";

/** 旧版首页中间视图（仅用于兼容导航 state 的 openView）。 */
export type LegacyHomeView = "shelf" | "knowledge" | "search" | "ai" | "settings" | "about";

export const LEGACY_HOME_VIEWS: readonly LegacyHomeView[] = [
  "shelf",
  "knowledge",
  "search",
  "ai",
  "settings",
  "about",
];

/** 导航 state / 旧存档里的未知值 → 合法 LegacyHomeView 守卫。 */
export function isLegacyHomeView(value: unknown): value is LegacyHomeView {
  return typeof value === "string" && (LEGACY_HOME_VIEWS as readonly string[]).includes(value);
}

/**
 * 旧 `openView` → 新的「入口 + 子项 / 常驻项」选择。
 *
 * - `settings` 目前只由 AGENT「前往设置配置」使用，因此直接定位到「设置 · AGENT」分类；
 * - `search` / `ai` 打开右面板常驻项（不改变左入口，入口取「首页」）；
 * - 其余映射到对应入口的默认子项。
 */
export function selectionForLegacyOpenView(view: LegacyHomeView): HomeSelection {
  switch (view) {
    case "knowledge":
      return { parent: "home", child: "home.knowledge", fixed: null };
    case "search":
      return { parent: "home", child: firstNavChild("home")?.id ?? null, fixed: "search" };
    case "ai":
      return { parent: "home", child: firstNavChild("home")?.id ?? null, fixed: "agent" };
    case "settings":
      return { parent: "settings", child: "settings.agent", fixed: null };
    case "about":
      return { parent: "about", child: "about.detail", fixed: null };
    case "shelf":
    default:
      return { parent: "home", child: firstNavChild("home")?.id ?? null, fixed: null };
  }
}

/** 首页左栏（入口面板，比阅读器侧栏窄）。 */
export const HOME_LEFT_PANE: PaneWidthConfig = {
  storageKey: "jusong.home.leftPaneWidth",
  defaultWidth: 208,
  minWidth: 176,
  maxWidth: 300,
};

/** 首页右栏（导览面板）。 */
export const HOME_RIGHT_PANE: PaneWidthConfig = {
  storageKey: "jusong.home.rightPaneWidth",
  defaultWidth: 216,
  minWidth: 180,
  maxWidth: 320,
};

/**
 * 首页面板是否内联显示。
 * 横屏（窗口宽>高）时放宽阈值，避免移动端横屏把侧栏强制隐藏；
 * 竖屏且不够宽时改用抽屉。
 */
export function homePaneVisibility(width: number, height: number): {
  landscape: boolean;
  canShowLeft: boolean;
  canShowRight: boolean;
} {
  const landscape = width > height;
  const canShowLeft = width >= 1024 || (landscape && width >= 760);
  const canShowRight = width >= 1280 || (landscape && width >= 1000);
  return { landscape, canShowLeft, canShowRight };
}
