import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  DEFAULT_ACCENT_THEME,
  DEFAULT_COVER_THEME,
  isAccentThemeId,
  type AccentThemeId,
} from "./theme";

/** 文内注释展示方式（仅在注释栏开关打开时生效）。 */
export type NoteDisplayMode = "inline" | "both" | "panel";

/** 首页左右层级导航的记忆策略（设置-行为）。 */
export type NavMemoryMode = "both" | "rightOnly" | "alwaysHome";

export const NAV_MEMORY_OPTIONS: Array<{ value: NavMemoryMode; label: string; description: string }> = [
  {
    value: "both",
    label: "左右都记忆",
    description: "记住上次离开时的入口（左）与导览子项（右）；没有记录时用首项。",
  },
  {
    value: "rightOnly",
    label: "仅记忆右侧",
    description: "入口始终从「首页」开始，只记住上次的导览子项。",
  },
  {
    value: "alwaysHome",
    label: "始终首页",
    description: "每次进入首页都从「首页」入口开始；导览子项仍按上次记忆/首项。",
  },
];

/** 阅读器窄屏（不足以并列三栏时）的左右面板呈现方式（外观设置，左右共用）。 */
export type ReaderPanelMode = "drawer" | "dialog" | "inline";

export const READER_PANEL_MODE_OPTIONS: Array<{ value: ReaderPanelMode; label: string; description: string }> = [
  { value: "drawer", label: "覆盖式浮层（默认）", description: "从侧边滑出覆盖正文，不改变正文宽度。" },
  { value: "dialog", label: "居中对话框", description: "居中的浮动窗口，带标题与遮罩。" },
  { value: "inline", label: "内联推挤", description: "面板占据布局宽度、把正文挤窄（窄屏可能较挤）。" },
];

/** 空间不足/拖拽侧栏时的收缩优先级（外观设置）。 */
export type PaneShrinkPriority = "left" | "right" | "middle";

export const PANE_SHRINK_PRIORITY_OPTIONS: Array<{
  value: PaneShrinkPriority;
  label: string;
  description: string;
}> = [
  { value: "left", label: "先收左面板（默认）", description: "空间不足时先收缩/隐藏知识面板，正文与探索面板优先保留。" },
  { value: "right", label: "先收右面板", description: "空间不足时先收缩/隐藏探索面板。" },
  { value: "middle", label: "先收中间面板", description: "中间正文先收缩，但不会低于 460px 可读宽度；随后才收缩侧栏。" },
];

/** 阅读器中间面板底部快捷按钮（创建书签 / 引用到 AGENT）的显示与行为策略。 */
export type ReaderActionMode = "always" | "selection" | "hidden";

export const READER_ACTION_MODE_OPTIONS: Array<{
  value: ReaderActionMode;
  label: string;
  description: string;
}> = [
  {
    value: "always",
    label: "始终存在",
    description: "始终显示按钮；没有选中文字时执行粗颗粒度操作（创建页面位置书签 / 引用整章）。",
  },
  {
    value: "selection",
    label: "仅选中文字时出现（默认）",
    description: "选中正文文字后才出现按钮，操作精确到选中文字（记段落/引用原文）。",
  },
  {
    value: "hidden",
    label: "始终隐藏",
    description: "不显示按钮，也不提供该功能入口。",
  },
];

/** 检索范围默认配置：首轮最近阅读本数@查找更多档位（-1 = 全部）。 */
export const DEFAULT_SEARCH_SCOPE_SPEC = "5@10@20@-1";

/** 阅读器面板顶部栏每一项的最小宽度（px）范围。 */
export const READER_TAB_MIN_WIDTH = {
  min: 48,
  max: 160,
  step: 4,
  defaultLeft: 64,
  defaultRight: 72,
} as const;

export interface ReaderSettings {
  /** 左栏是否显示「注释」标签。 */
  notesPanelEnabled: boolean;
  /** 文内注释展示方式。 */
  noteDisplayMode: NoteDisplayMode;
  /** 是否记忆首页/阅读器的界面状态（视图、侧栏开合、滚动位置）。 */
  rememberUiState: boolean;
  /** 首页层级导航记忆策略。 */
  navMemory: NavMemoryMode;
  /** 检索范围配置文本，格式如 "5@10@20@-1"。 */
  searchScope: string;
  /** UI 强调色。 */
  accentColor: AccentThemeId;
  /** 封面占位色（与强调色独立）。 */
  coverColor: AccentThemeId;
  /** 阅读器窄屏面板呈现方式（左右共用）。 */
  readerPanelMode: ReaderPanelMode;
  /** 空间不足时的收缩优先级。 */
  paneShrinkPriority: PaneShrinkPriority;
  /** 阅读器知识面板顶部项最小宽度（px）。 */
  readerLeftTabMinWidth: number;
  /** 阅读器探索面板顶部项最小宽度（px）。 */
  readerRightTabMinWidth: number;
  /** 中间面板底部「创建书签」按钮策略。 */
  middleBookmarkMode: ReaderActionMode;
  /** 中间面板底部「引用到 AGENT」按钮策略。 */
  middleQuoteMode: ReaderActionMode;
  /** 移动端左右滑动翻章阈值：滑动距离 / 面板宽度（0.1–0.4，默认 0.22）。 */
  readerSwipeThreshold: number;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  notesPanelEnabled: false,
  noteDisplayMode: "inline",
  rememberUiState: true,
  navMemory: "both",
  searchScope: DEFAULT_SEARCH_SCOPE_SPEC,
  accentColor: DEFAULT_ACCENT_THEME,
  coverColor: DEFAULT_COVER_THEME,
  readerPanelMode: "drawer",
  paneShrinkPriority: "left",
  readerLeftTabMinWidth: READER_TAB_MIN_WIDTH.defaultLeft,
  readerRightTabMinWidth: READER_TAB_MIN_WIDTH.defaultRight,
  middleBookmarkMode: "selection",
  middleQuoteMode: "selection",
  readerSwipeThreshold: 0.22,
};

export const NOTE_DISPLAY_MODES: Array<{ value: NoteDisplayMode; label: string; description: string }> = [
  { value: "inline", label: "仅文内展示", description: "注释正文只出现在文章末尾。" },
  { value: "both", label: "文内与注释栏同步展示", description: "文末与左栏注释各一份。" },
  { value: "panel", label: "仅注释栏展示", description: "文章里不再显示注释正文，只在左栏注释栏查看。" },
];

/** 旧版本存 localStorage 的键；仅用于一次性迁移到用户库 settings.json。 */
const LEGACY_STORAGE_KEY = "jusong.settings.v1";

function isDisplayMode(value: unknown): value is NoteDisplayMode {
  return value === "inline" || value === "both" || value === "panel";
}

function isNavMemoryMode(value: unknown): value is NavMemoryMode {
  return value === "both" || value === "rightOnly" || value === "alwaysHome";
}

function isReaderPanelMode(value: unknown): value is ReaderPanelMode {
  return value === "drawer" || value === "dialog" || value === "inline";
}

function isPaneShrinkPriority(value: unknown): value is PaneShrinkPriority {
  return value === "left" || value === "right" || value === "middle";
}

function isReaderActionMode(value: unknown): value is ReaderActionMode {
  return value === "always" || value === "selection" || value === "hidden";
}

function normalizeTabMinWidth(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(READER_TAB_MIN_WIDTH.max, Math.max(READER_TAB_MIN_WIDTH.min, Math.round(parsed)));
}

/** 滑动翻章阈值：夹在 0.1–0.4，保留两位小数。 */
function normalizeSwipeThreshold(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(0.4, Math.max(0.1, Math.round(parsed * 100) / 100));
}

function normalizeSettings(value: unknown): ReaderSettings | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    notesPanelEnabled: record.notesPanelEnabled === true,
    noteDisplayMode: isDisplayMode(record.noteDisplayMode)
      ? record.noteDisplayMode
      : DEFAULT_READER_SETTINGS.noteDisplayMode,
    rememberUiState:
      typeof record.rememberUiState === "boolean"
        ? record.rememberUiState
        : DEFAULT_READER_SETTINGS.rememberUiState,
    navMemory: isNavMemoryMode(record.navMemory)
      ? record.navMemory
      : DEFAULT_READER_SETTINGS.navMemory,
    searchScope:
      typeof record.searchScope === "string" && record.searchScope.trim()
        ? record.searchScope.trim()
        : DEFAULT_READER_SETTINGS.searchScope,
    accentColor: isAccentThemeId(record.accentColor)
      ? record.accentColor
      : DEFAULT_READER_SETTINGS.accentColor,
    coverColor: isAccentThemeId(record.coverColor)
      ? record.coverColor
      : DEFAULT_READER_SETTINGS.coverColor,
    readerPanelMode: isReaderPanelMode(record.readerPanelMode)
      ? record.readerPanelMode
      : DEFAULT_READER_SETTINGS.readerPanelMode,
    paneShrinkPriority: isPaneShrinkPriority(record.paneShrinkPriority)
      ? record.paneShrinkPriority
      : DEFAULT_READER_SETTINGS.paneShrinkPriority,
    readerLeftTabMinWidth: normalizeTabMinWidth(
      record.readerLeftTabMinWidth,
      DEFAULT_READER_SETTINGS.readerLeftTabMinWidth,
    ),
    readerRightTabMinWidth: normalizeTabMinWidth(
      record.readerRightTabMinWidth,
      DEFAULT_READER_SETTINGS.readerRightTabMinWidth,
    ),
    middleBookmarkMode: isReaderActionMode(record.middleBookmarkMode)
      ? record.middleBookmarkMode
      : DEFAULT_READER_SETTINGS.middleBookmarkMode,
    middleQuoteMode: isReaderActionMode(record.middleQuoteMode)
      ? record.middleQuoteMode
      : DEFAULT_READER_SETTINGS.middleQuoteMode,
    readerSwipeThreshold: normalizeSwipeThreshold(
      record.readerSwipeThreshold,
      DEFAULT_READER_SETTINGS.readerSwipeThreshold,
    ),
  };
}

function readLegacySettings(): ReaderSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function persistSettings(settings: ReaderSettings): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("library_save_settings", { settings });
  } catch (error) {
    // 持久化失败只影响记忆，不影响当前会话。
    console.warn("[jusong] 保存设置失败：", error);
  }
}

/** 读取用户设置：Rust 用户库 settings.json；首次运行从旧 localStorage 迁移。 */
async function loadSettings(): Promise<ReaderSettings> {
  if (!isTauri()) return DEFAULT_READER_SETTINGS;
  try {
    const stored = await invoke<unknown>("library_get_settings");
    const normalized = normalizeSettings(stored);
    if (normalized) return normalized;

    const legacy = readLegacySettings();
    if (legacy) {
      await persistSettings(legacy);
      try {
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        // 忽略隐私模式下的失败。
      }
      return legacy;
    }
  } catch (error) {
    console.warn("[jusong] 读取设置失败，使用默认值：", error);
  }
  return DEFAULT_READER_SETTINGS;
}

/** 开关关闭时，文内注释固定按「仅文内展示」处理。 */
export function effectiveNoteDisplayMode(settings: ReaderSettings): NoteDisplayMode {
  return settings.notesPanelEnabled ? settings.noteDisplayMode : "inline";
}

interface SettingsContextValue {
  settings: ReaderSettings;
  /** 用户库设置是否已异步加载完成（首页启动视图等逻辑需等它）。 */
  loaded: boolean;
  updateSettings: (patch: Partial<ReaderSettings>) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_READER_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const touchedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    loadSettings().then((next) => {
      // 用户在异步加载完成前已改过设置时不覆盖。
      if (alive && !touchedRef.current) setSettings(next);
      if (alive) setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    touchedRef.current = true;
    setSettings((current) => {
      const next: ReaderSettings = {
        notesPanelEnabled:
          patch.notesPanelEnabled === undefined ? current.notesPanelEnabled : patch.notesPanelEnabled,
        noteDisplayMode: isDisplayMode(patch.noteDisplayMode)
          ? patch.noteDisplayMode
          : current.noteDisplayMode,
        rememberUiState:
          patch.rememberUiState === undefined ? current.rememberUiState : patch.rememberUiState,
        navMemory: isNavMemoryMode(patch.navMemory) ? patch.navMemory : current.navMemory,
        searchScope:
          typeof patch.searchScope === "string" && patch.searchScope.trim()
            ? patch.searchScope.trim()
            : current.searchScope,
        accentColor: isAccentThemeId(patch.accentColor) ? patch.accentColor : current.accentColor,
        coverColor: isAccentThemeId(patch.coverColor) ? patch.coverColor : current.coverColor,
        readerPanelMode: isReaderPanelMode(patch.readerPanelMode)
          ? patch.readerPanelMode
          : current.readerPanelMode,
        paneShrinkPriority: isPaneShrinkPriority(patch.paneShrinkPriority)
          ? patch.paneShrinkPriority
          : current.paneShrinkPriority,
        readerLeftTabMinWidth:
          patch.readerLeftTabMinWidth === undefined
            ? current.readerLeftTabMinWidth
            : normalizeTabMinWidth(patch.readerLeftTabMinWidth, current.readerLeftTabMinWidth),
        readerRightTabMinWidth:
          patch.readerRightTabMinWidth === undefined
            ? current.readerRightTabMinWidth
            : normalizeTabMinWidth(patch.readerRightTabMinWidth, current.readerRightTabMinWidth),
        middleBookmarkMode: isReaderActionMode(patch.middleBookmarkMode)
          ? patch.middleBookmarkMode
          : current.middleBookmarkMode,
        middleQuoteMode: isReaderActionMode(patch.middleQuoteMode)
          ? patch.middleQuoteMode
          : current.middleQuoteMode,
        readerSwipeThreshold:
          patch.readerSwipeThreshold === undefined
            ? current.readerSwipeThreshold
            : normalizeSwipeThreshold(
                patch.readerSwipeThreshold,
                current.readerSwipeThreshold,
              ),
      };
      void persistSettings(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    touchedRef.current = true;
    setSettings(DEFAULT_READER_SETTINGS);
    void persistSettings(DEFAULT_READER_SETTINGS);
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loaded, updateSettings, resetSettings }),
    [settings, loaded, updateSettings, resetSettings],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettings 必须在 <SettingsProvider> 内部使用");
  }
  return context;
}
