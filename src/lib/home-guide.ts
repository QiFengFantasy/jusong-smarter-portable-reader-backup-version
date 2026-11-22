/**
 * 首页「导览检索」索引。
 *
 * 首页左侧是入口（父级），右侧是当前入口的子项（导览），另有常驻的「检索」「AGENT」。
 * 本文件把这些可跳转目标（入口 / 子项 / 设置分类与设置项 / 常驻项）整理成一份**纯本地**
 * 索引，供 `GuideSearchView` 与 `GuideAgentView` 的「直达入口」搜索使用：
 * 只做界面导航检索（中文 / 大小写不敏感子串），**不调用** `library_search` 之类的书内检索。
 *
 * 数据来源：`src/lib/home-nav.ts` 的 `HOME_PARENTS` / `HOME_FIXED_GUIDES`（由首页 Shell 维护）。
 * 若该数据意外为空（并行开发早期 / 数据尚未落地），回退本文件内置的兜底数据，
 * 保证索引条目与 UI 标签始终可用。
 *
 * 契约（HomePage / H 消费）：
 * - `HomeGuideTarget`：点击结果后交给 HomePage 的跳转目标；
 * - `HomeGuideEntry`：索引条目（含 UI 展示用的 label/description/parentLabel 等）；
 * - `searchHomeGuide(query)`：查询 → 排序后的条目列表；空查询返回空数组；
 * - `HOME_GUIDE_ENTRIES` / `HOME_GUIDE_STATS`：全量条目与统计（空态展示「可搜索范围」）。
 */
import type { LucideIcon } from "lucide-react";

import { HOME_FIXED_GUIDES, HOME_PARENTS } from "./home-nav";
import type {
  HomeChildId,
  HomeFixedGuide,
  HomeFixedGuideId,
  HomeNavChild,
  HomeNavParent,
  HomeParentId,
} from "./home-nav";

/** 设置分类（与设置页 `SettingsContent` 的分类一致：账号 / 行为 / 外观 / AGENT）。 */
export type HomeGuideSettingsCategory = "account" | "behavior" | "appearance" | "agent";

export const HOME_GUIDE_SETTINGS_CATEGORIES: readonly HomeGuideSettingsCategory[] = [
  "account",
  "behavior",
  "appearance",
  "agent",
];

const SETTINGS_CATEGORY_LABEL: Record<HomeGuideSettingsCategory, string> = {
  account: "账号",
  behavior: "行为",
  appearance: "外观",
  agent: "AGENT",
};

/** 条目类别：入口 / 子项 / 设置项 / 常驻项。 */
export type HomeGuideEntryKind = "parent" | "child" | "setting" | "fixed";

/** 点击检索结果后交给 HomePage 的跳转目标（HomePage 据此更新入口/子项/常驻项/设置分类）。 */
export interface HomeGuideTarget {
  /** 目标左入口。 */
  parent: HomeParentId;
  /** 目标右子项；入口本身（无子项 / 打开默认子项）时为 null。 */
  child: HomeChildId | null;
  /** 常驻项："search" | "agent"；非常驻项为 null。 */
  fixed: HomeFixedGuideId | null;
  /** 设置项直达时的设置分类（与设置页分类对齐；设置分类子项也会带上）。 */
  settingsCategory?: HomeGuideSettingsCategory;
}

/** 一条可检索、可跳转的首页导览条目。 */
export interface HomeGuideEntry {
  /** 索引内唯一 id（如 "parent.home" / "child.home.shelf" / "setting.appearance.accent"）。 */
  id: string;
  /** 显示名称，也是搜索的主字段（label 前缀命中优先）。 */
  label: string;
  /** 一句话说明，用于结果列表副文案与次级匹配。 */
  description?: string;
  /** 所属左入口。 */
  parent: HomeParentId;
  /** 目标子项 id；入口/常驻项为 null。 */
  child: HomeChildId | null;
  /** 常驻项 id；非常驻项不出现该字段或为 undefined。 */
  fixed?: HomeFixedGuideId;
  /** 设置分类：设置分类子项与设置项会带上。 */
  settingsCategory?: HomeGuideSettingsCategory;
  /** 条目类别（UI 用于角标/图标）。 */
  kind: HomeGuideEntryKind;
  /** 所属入口名称（如「设置」），UI 显示「设置 · 外观」。 */
  parentLabel: string;
  /** 所属子项/分类名称（设置项为分类名，如「外观」；常驻项为位置说明）。 */
  childLabel?: string;
  /** 额外搜索词（如 baseUrl / 密钥），仅参与匹配、不显示。 */
  keywords?: string[];
  /** 优先使用 home-nav 提供的图标；未就绪时由 UI 按类别兜底。 */
  icon?: LucideIcon;
}

/* -------------------------------------------------------------------------- */
/* 兜底数据：HOME_PARENTS 尚未就绪时使用                                       */
/* -------------------------------------------------------------------------- */

function fallbackChild(
  id: string,
  label: string,
  description: string,
): HomeNavChild {
  return { id, label, description };
}

const FALLBACK_PARENTS: HomeNavParent[] = [
  {
    id: "home",
    label: "首页",
    group: "main",
    children: [
      fallbackChild("home.shelf", "书架", "浏览本地书库中的全部书籍，点开即进入阅读器。"),
      fallbackChild("home.knowledge", "知识", "按书查看知识档案与自动摘要，可跳转到对应章节。"),
    ],
  },
  {
    id: "emergence",
    label: "涌现",
    group: "main",
    children: [],
    placeholder: {
      title: "涌现",
      description: "后续用 AGENT 自行开发/生成的功能会出现在这里。",
    },
  },
  {
    id: "import",
    label: "导入",
    group: "main",
    children: [
      fallbackChild("import.books", "导入书籍", "从 EPUB 导入书籍到本地书库（真实导入业务列入未来更新）。"),
      fallbackChild("import.knowledge", "导入知识库", "导入知识档案（占位入口，业务列入未来更新）。"),
      fallbackChild("import.config", "导入配置", "导入应用配置（占位入口，业务列入未来更新）。"),
    ],
  },
  {
    id: "export",
    label: "导出",
    group: "main",
    children: [
      fallbackChild("export.books", "导出书籍", "导出书籍数据（占位入口，业务列入未来更新）。"),
      fallbackChild("export.knowledge", "导出知识库", "导出知识档案（占位入口，业务列入未来更新）。"),
      fallbackChild("export.config", "导出配置", "导出应用配置（占位入口，业务列入未来更新）。"),
    ],
  },
  {
    id: "guide",
    label: "指引",
    group: "main",
    children: [],
    placeholder: {
      title: "指引",
      description: "功能指引与使用帮助的规划中入口。",
    },
  },
  {
    id: "about",
    label: "关于",
    group: "bottom",
    children: [
      fallbackChild("about.detail", "详细", "产品信息、版本号、本地存储与多端说明。"),
      fallbackChild("about.changelog", "本次打包更新", "查看本次打包包含的功能更新清单。"),
      fallbackChild("about.roadmap", "未来预计更新", "查看后续计划中的功能。"),
    ],
  },
  {
    id: "settings",
    label: "设置",
    group: "bottom",
    children: [
      fallbackChild("settings.account", "账号", "书库统计与本地优先说明。"),
      fallbackChild("settings.behavior", "行为", "阅读与注释、界面、检索与导航记忆。"),
      fallbackChild("settings.appearance", "外观", "强调色、封面占位色与阅读器面板配置。"),
      fallbackChild("settings.agent", "AGENT", "模型服务地址、模型与 API Key。"),
    ],
  },
];

/** 设置分类下的设置项名称（用户可检索的设置项）。账号分类暂无设置项。 */
interface SettingsItemSeed {
  key: string;
  label: string;
  description: string;
  keywords: string[];
}

const SETTINGS_ITEMS: Record<HomeGuideSettingsCategory, SettingsItemSeed[]> = {
  account: [],
  behavior: [
    {
      key: "reading",
      label: "阅读与注释",
      description: "注释栏开关与文内注释展示方式（仅文内 / 文内与注释栏 / 仅注释栏）。",
      keywords: ["注释", "注释栏", "notesPanelEnabled", "noteDisplayMode"],
    },
    {
      key: "interface",
      label: "界面",
      description: "是否记忆界面状态：首页视图、侧栏开合与滚动位置。",
      keywords: ["记忆界面状态", "rememberUiState", "界面记忆"],
    },
    {
      key: "search",
      label: "检索",
      description: "检索范围：首轮最近阅读本数与「查找更多」档位。",
      keywords: ["检索范围", "searchScope", "查找更多"],
    },
    {
      key: "navMemory",
      label: "导航记忆",
      description: "首页左右层级导航的记忆策略：左右都记忆 / 仅记忆右侧 / 始终首页。",
      keywords: ["navMemory", "记忆", "导航"],
    },
  ],
  appearance: [
    {
      key: "accent",
      label: "强调色",
      description: "界面按钮、选中态与 Hero 图形的强调色（朱红 / 天蓝 / 青 / 橙 / 紫）。",
      keywords: ["主题", "主题色", "accentColor", "颜色"],
    },
    {
      key: "cover",
      label: "封面占位色",
      description: "没有真实封面的书籍卡片使用的占位渐变颜色（与强调色独立）。",
      keywords: ["封面", "占位色", "coverColor"],
    },
    {
      key: "readerTabWidth",
      label: "阅读器面板最小宽度",
      description: "阅读器知识面板与探索面板顶部项的最小宽度（48–160px，左右分开设置）。",
      keywords: ["最小宽度", "面板宽度", "readerLeftTabMinWidth", "readerRightTabMinWidth"],
    },
    {
      key: "readerPanelMode",
      label: "面板形态",
      description: "阅读器窄屏时左右面板的呈现方式：覆盖式浮层 / 居中对话框 / 内联推挤。",
      keywords: ["readerPanelMode", "浮层", "对话框", "内联", "面板形态"],
    },
    {
      key: "shrinkPriority",
      label: "收缩优先级",
      description: "空间不足时先收缩哪个面板：左面板 / 右面板 / 中间面板。",
      keywords: ["paneShrinkPriority", "收缩", "优先级"],
    },
  ],
  agent: [
    {
      key: "baseUrl",
      label: "接口地址",
      description: "兼容 OpenAI 接口的模型服务地址，默认 https://api.deepseek.com。",
      keywords: ["baseUrl", "地址", "接口", "服务地址"],
    },
    {
      key: "model",
      label: "模型",
      description: "对话使用的模型名称，默认 deepseek-chat。",
      keywords: ["model", "模型名", "deepseek"],
    },
    {
      key: "apiKey",
      label: "API Key",
      description: "模型服务密钥；只保存在本机用户库，界面上永不回显明文。",
      keywords: ["密钥", "key", "apikey", "deepseek"],
    },
  ],
};

/** 右导览常驻项的兜底数据（home-nav 的 HOME_FIXED_GUIDES 为空时使用）。 */
const FALLBACK_FIXED_ENTRIES: HomeGuideEntry[] = [
  {
    id: "fixed.search",
    label: "检索",
    description: "右导览顶部常驻：按入口、子项与设置项快速搜索并跳转（当前视图）。",
    parent: "home",
    child: null,
    fixed: "search",
    kind: "fixed",
    parentLabel: "常驻入口",
    childLabel: "导览顶部",
    keywords: ["搜索", "查找", "导航检索", "界面检索"],
  },
  {
    id: "fixed.agent",
    label: "AGENT",
    description: "右导览底部常驻：与 AGENT 对话，并通过「直达入口」打开任意入口/子项/设置项。",
    parent: "home",
    child: null,
    fixed: "agent",
    kind: "fixed",
    parentLabel: "常驻入口",
    childLabel: "导览底部",
    keywords: ["对话", "助手", "agent", "ai"],
  },
];

/* -------------------------------------------------------------------------- */
/* 数据解析：优先 home-nav.HOME_PARENTS / HOME_FIXED_GUIDES，缺省时回退兜底     */
/* -------------------------------------------------------------------------- */

/**
 * 合并 home-nav 与兜底数据：
 * - 已存在的数据以 HOME_PARENTS 为准（label/description/icon/child id/顺序）；
 * - 某个入口的子项数组意外为空时用兜底补齐，保证索引里能看到全部可跳转项；
 * - 兜底里有、HOME_PARENTS 里没有的入口追加在末尾（防御未来漏配）。
 */
function mergeWithFallback(fromNav: readonly HomeNavParent[]): HomeNavParent[] {
  if (fromNav.length === 0) return FALLBACK_PARENTS;
  const seen = new Set<string>();
  const merged: HomeNavParent[] = [];
  for (const parent of fromNav) {
    seen.add(parent.id);
    const fallback = FALLBACK_PARENTS.find((item) => item.id === parent.id);
    if (!fallback) {
      merged.push(parent);
      continue;
    }
    merged.push({
      ...fallback,
      ...parent,
      children:
        parent.children && parent.children.length > 0
          ? parent.children
          : fallback.children,
    });
  }
  for (const fallback of FALLBACK_PARENTS) {
    if (!seen.has(fallback.id)) merged.push(fallback);
  }
  return merged;
}

/** 常驻项（检索 / AGENT）：以 home-nav 的 HOME_FIXED_GUIDES 为准，补充检索关键词。 */
function buildFixedEntries(guides: readonly HomeFixedGuide[]): HomeGuideEntry[] {
  if (guides.length === 0) return FALLBACK_FIXED_ENTRIES;
  return guides.map((guide) => ({
    id: `fixed.${guide.id}`,
    label: guide.label,
    description: guide.description,
    parent: "home",
    child: null,
    fixed: guide.id,
    kind: "fixed",
    parentLabel: "常驻入口",
    childLabel: guide.position === "top" ? "导览顶部" : "导览底部",
    icon: guide.icon,
    keywords:
      guide.id === "search"
        ? ["搜索", "查找", "导航检索", "界面检索"]
        : ["对话", "助手", "agent", "ai"],
  }));
}

/** 从设置子项（如 "settings.appearance" / label "外观"）识别设置分类。 */
function settingsCategoryOfChild(child: HomeNavChild): HomeGuideSettingsCategory | undefined {
  const id = child.id.toLowerCase();
  const label = child.label.toUpperCase();
  for (const category of HOME_GUIDE_SETTINGS_CATEGORIES) {
    if (
      id === category ||
      id.endsWith(`.${category}`) ||
      id.split(".").includes(category) ||
      label === SETTINGS_CATEGORY_LABEL[category].toUpperCase()
    ) {
      return category;
    }
  }
  return undefined;
}

function findSettingsCategoryChild(
  parents: readonly HomeNavParent[],
  category: HomeGuideSettingsCategory,
): HomeNavChild | undefined {
  const settings = parents.find((parent) => parent.id === "settings");
  return settings?.children.find((child) => settingsCategoryOfChild(child) === category);
}

function buildEntries(parents: readonly HomeNavParent[]): HomeGuideEntry[] {
  const entries: HomeGuideEntry[] = [];

  // 入口（父级）与子项（导览）按左面板顺序排列：入口后面紧跟它的子项。
  for (const parent of parents) {
    entries.push({
      id: `parent.${parent.id}`,
      label: parent.label,
      description: parent.placeholder?.description,
      parent: parent.id,
      child: null,
      kind: "parent",
      parentLabel: parent.label,
      icon: parent.icon,
    });

    for (const child of parent.children) {
      const settingsCategory =
        parent.id === "settings" ? settingsCategoryOfChild(child) : undefined;
      entries.push({
        id: `child.${child.id}`,
        label: child.label,
        description: child.description,
        parent: parent.id,
        child: child.id,
        ...(settingsCategory ? { settingsCategory } : {}),
        kind: "child",
        parentLabel: parent.label,
        icon: child.icon,
      });
    }
  }

  // 常驻项（检索 / AGENT）。
  entries.push(...buildFixedEntries(HOME_FIXED_GUIDES));

  // 设置分类下的设置项名称。
  for (const category of HOME_GUIDE_SETTINGS_CATEGORIES) {
    const categoryChild = findSettingsCategoryChild(parents, category);
    for (const item of SETTINGS_ITEMS[category]) {
      entries.push({
        id: `setting.${category}.${item.key}`,
        label: item.label,
        description: item.description,
        parent: "settings",
        child: categoryChild?.id ?? `settings.${category}`,
        settingsCategory: category,
        kind: "setting",
        parentLabel: "设置",
        childLabel: SETTINGS_CATEGORY_LABEL[category],
        keywords: item.keywords,
      });
    }
  }

  return entries;
}

/** 解析后的入口数据（供需要展示「可搜索范围」的 UI 使用）。 */
export const HOME_GUIDE_PARENTS: readonly HomeNavParent[] = mergeWithFallback(HOME_PARENTS);

/** 首页全部可检索条目（入口 7 + 子项 15 + 设置项 12 + 常驻项 2 = 36）。 */
export const HOME_GUIDE_ENTRIES: HomeGuideEntry[] = buildEntries(HOME_GUIDE_PARENTS);

export interface HomeGuideStats {
  parents: number;
  children: number;
  settings: number;
  fixed: number;
  total: number;
}

/** 索引统计（空态「可搜索范围」展示）。 */
export const HOME_GUIDE_STATS: HomeGuideStats = HOME_GUIDE_ENTRIES.reduce<HomeGuideStats>(
  (stats, entry) => {
    stats.total += 1;
    switch (entry.kind) {
      case "parent":
        stats.parents += 1;
        break;
      case "child":
        stats.children += 1;
        break;
      case "setting":
        stats.settings += 1;
        break;
      case "fixed":
        stats.fixed += 1;
        break;
    }
    return stats;
  },
  { parents: 0, children: 0, settings: 0, fixed: 0, total: 0 },
);

/* -------------------------------------------------------------------------- */
/* 搜索                                                                       */
/* -------------------------------------------------------------------------- */

function searchableText(entry: HomeGuideEntry): string {
  return [
    entry.label,
    entry.description ?? "",
    entry.parentLabel,
    entry.childLabel ?? "",
    ...(entry.keywords ?? []),
  ]
    .join("\n")
    .toLowerCase();
}

/**
 * 匹配等级（越小越靠前）：
 * 0 label 完全相同；1 label 前缀；2 label 子串；
 * 3 说明/所属入口/关键词里包含完整查询；4 多个词都命中（说明/关键词等）。
 * 不匹配返回 null。
 */
function matchRank(entry: HomeGuideEntry, query: string): number | null {
  const label = entry.label.toLowerCase();
  const haystack = searchableText(entry);
  const terms = query.split(/\s+/).filter(Boolean);

  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  if (terms.length > 1 && terms.every((term) => label.includes(term))) return 2;
  if (haystack.includes(query)) return 3;
  if (terms.length > 1 && terms.every((term) => haystack.includes(term))) return 4;
  return null;
}

/**
 * 检索首页可跳转条目。
 *
 * - 中文 / 英文均按子串匹配，ASCII 大小写不敏感（如 "agent" 可命中 "AGENT"）；
 * - 排序：label 前缀命中 > label 子串命中 > 说明/关键词命中；同级维持索引顺序；
 * - 空查询（或纯空白）返回空数组（由 UI 展示「可搜索范围」空态）；
 * - 不检索书内正文——书内检索请使用书架/知识库的高级检索。
 */
export function searchHomeGuide(query: string): HomeGuideEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];

  const scored: Array<{ entry: HomeGuideEntry; rank: number }> = [];
  for (const entry of HOME_GUIDE_ENTRIES) {
    const rank = matchRank(entry, normalized);
    if (rank !== null) scored.push({ entry, rank });
  }
  // 现代 JS 的 Array#sort 是稳定排序：同等级条目保持索引顺序。
  scored.sort((left, right) => left.rank - right.rank);
  return scored.map((item) => item.entry);
}

/** 条目 → 跳转目标（GuideSearchView / GuideAgentView 点击结果时使用）。 */
export function homeGuideTarget(entry: HomeGuideEntry): HomeGuideTarget {
  return {
    parent: entry.parent,
    child: entry.child,
    fixed: entry.fixed ?? null,
    ...(entry.settingsCategory ? { settingsCategory: entry.settingsCategory } : {}),
  };
}

/** 条目在首页中的位置描述，用于结果列表的「所属入口 · 子项」副标题。 */
export function homeGuideEntryLocation(entry: HomeGuideEntry): string {
  switch (entry.kind) {
    case "parent":
      return "入口";
    case "child":
      return entry.parentLabel;
    case "setting":
      return [entry.parentLabel, entry.childLabel].filter(Boolean).join(" · ");
    case "fixed":
      return [entry.parentLabel, entry.childLabel].filter(Boolean).join(" · ");
    default:
      return entry.parentLabel;
  }
}
