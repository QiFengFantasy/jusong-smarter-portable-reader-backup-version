/**
 * 首页「入口（左）- 导览（右）」层级导航的共享类型与数据。
 *
 * - 左面板 = 入口：home / emergence / import / export / guide（主分组）+ about / settings（置底分组）；
 * - 右面板 = 导览：由当前入口的子项组成；检索与 AGENT 为常驻项（不属于任何入口子项）。
 *
 * 子项 id 统一采用 `${parent}.${key}` 约定（如 `home.shelf`、`settings.appearance`），
 * 这样导览检索（`src/lib/home-guide.ts`）、设置分类（SettingsContent）与首页记忆存档
 * 都能用同一个字符串定位；新增子项时不要破坏该约定。
 */
import {
  BookMarked,
  BookOpen,
  BookPlus,
  Bot,
  Compass,
  Download,
  FileCog,
  FileText,
  Home,
  Info,
  LibraryBig,
  Palette,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Upload,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type HomeParentId =
  | "home"
  | "emergence"
  | "import"
  | "export"
  | "guide"
  | "about"
  | "settings";

/** 右面板子项 id（全局唯一，形如 "home.shelf" / "settings.appearance"）。 */
export type HomeChildId = string;

export interface HomeNavChild {
  id: HomeChildId;
  label: string;
  description?: string;
  icon?: LucideIcon;
}

export interface HomeNavParent {
  id: HomeParentId;
  label: string;
  /** 左面板分组位置：main（首页/涌现/导入/导出/指引）或 bottom（关于/设置）。 */
  group: "main" | "bottom";
  icon?: LucideIcon;
  children: HomeNavChild[];
  /** 该入口在中间面板的空态/说明（无子项时使用）。 */
  placeholder?: {
    title: string;
    description: string;
  };
}

/** 右面板常驻项（不属于任何入口子项）：检索始终在顶部、AGENT 固定在底部。 */
export type HomeFixedGuideId = "search" | "agent";

export interface HomeFixedGuide {
  id: HomeFixedGuideId;
  label: string;
  description: string;
  icon: LucideIcon;
  /** 常驻项在右面板的位置：检索置顶、AGENT 置底。 */
  position: "top" | "bottom";
}

export interface HomeSelection {
  parent: HomeParentId;
  /** 当前入口的子项；该入口无子项时为 null（中间显示占位）。 */
  child: HomeChildId | null;
  /** 常驻项打开时覆盖子项（检索/AGENT）；null 表示当前显示入口子项内容。 */
  fixed: HomeFixedGuideId | null;
}

/** 左入口数据。顺序即左面板顺序（主分组在前，关于/设置置底）。 */
export const HOME_PARENTS: readonly HomeNavParent[] = [
  {
    id: "home",
    label: "首页",
    group: "main",
    icon: Home,
    children: [
      {
        id: "home.shelf",
        label: "书架",
        icon: BookOpen,
        description: "本地书库：继续阅读、筛选书目与查看藏书统计。",
      },
      {
        id: "home.knowledge",
        label: "知识",
        icon: LibraryBig,
        description: "按书查看人工档案、自动摘要与书签统计，可跳转到章节摘要。",
      },
    ],
  },
  {
    id: "emergence",
    label: "涌现",
    group: "main",
    icon: Sparkles,
    children: [],
    placeholder: {
      title: "涌现",
      description:
        "后续通过 AGENT 生成、安装的功能入口会出现在这里；当前为空态，本批仅提供入口与占位说明。",
    },
  },
  {
    id: "import",
    label: "导入",
    group: "main",
    icon: Download,
    children: [
      {
        id: "import.books",
        label: "导入书籍",
        icon: BookPlus,
        description: "从本地 EPUB、解析包或原始文件（MOBI/PDF/TXT）导入书籍。",
      },
      {
        id: "import.knowledge",
        label: "导入知识库",
        icon: FileText,
        description: "导入已有的档案与摘要（本批为入口占位）。",
      },
      {
        id: "import.config",
        label: "导入配置",
        icon: FileCog,
        description: "导入书斋与 AGENT 配置（本批为入口占位）。",
      },
    ],
  },
  {
    id: "export",
    label: "导出",
    group: "main",
    icon: Upload,
    children: [
      {
        id: "export.books",
        label: "导出书籍",
        icon: BookMarked,
        description: "把本地书籍导出为原文件或解析包；也可从书架右键单本导出。",
      },
      {
        id: "export.knowledge",
        label: "导出知识库",
        icon: FileText,
        description: "导出档案与摘要（本批为入口占位）。",
      },
      {
        id: "export.config",
        label: "导出配置",
        icon: FileCog,
        description: "导出书斋与 AGENT 配置（本批为入口占位）。",
      },
    ],
  },
  {
    id: "guide",
    label: "指引",
    group: "main",
    icon: Compass,
    children: [],
    placeholder: {
      title: "指引",
      description: "入口导览、阅读与知识库说明、AGENT 使用指南会在后续逐步补齐；本批仅提供入口与占位说明。",
    },
  },
  {
    id: "about",
    label: "关于",
    group: "bottom",
    icon: Info,
    children: [
      {
        id: "about.detail",
        label: "详细",
        icon: Info,
        description: "产品介绍、版本与本地优先说明。",
      },
      {
        id: "about.changelog",
        label: "本次打包更新",
        icon: FileText,
        description: "本批与上一批的改动清单。",
      },
      {
        id: "about.roadmap",
        label: "未来预计更新",
        icon: Compass,
        description: "后续计划：真实导入导出、深色模式、更多 AGENT 能力等。",
      },
    ],
  },
  {
    id: "settings",
    label: "设置",
    group: "bottom",
    icon: Settings2,
    children: [
      {
        id: "settings.account",
        label: "账号",
        icon: User,
        description: "书斋概览与本地优先说明。",
      },
      {
        id: "settings.behavior",
        label: "行为",
        icon: SlidersHorizontal,
        description: "阅读与注释、界面记忆、导航记忆与检索范围。",
      },
      {
        id: "settings.appearance",
        label: "外观",
        icon: Palette,
        description: "强调色、封面占位色与阅读器面板形态。",
      },
      {
        id: "settings.agent",
        label: "AGENT",
        icon: Bot,
        description: "接口地址、模型与 API Key。",
      },
    ],
  },
];

/** 右面板常驻项：检索（顶部）与 AGENT（底部）。 */
export const HOME_FIXED_GUIDES: readonly HomeFixedGuide[] = [
  {
    id: "search",
    label: "检索",
    description: "在各入口、子项与设置项之间快速查找并跳转。",
    icon: Search,
    position: "top",
  },
  {
    id: "agent",
    label: "AGENT",
    description: "与 AGENT 对话，让它帮你打开、定位首页功能与设置项。",
    icon: Bot,
    position: "bottom",
  },
];

export const HOME_PARENTS_BY_ID: Readonly<Record<HomeParentId, HomeNavParent>> = HOME_PARENTS.reduce(
  (map, parent) => {
    map[parent.id] = parent;
    return map;
  },
  {} as Record<HomeParentId, HomeNavParent>,
);

const FIXED_GUIDES_BY_ID: Readonly<Record<HomeFixedGuideId, HomeFixedGuide>> = HOME_FIXED_GUIDES.reduce(
  (map, guide) => {
    map[guide.id] = guide;
    return map;
  },
  {} as Record<HomeFixedGuideId, HomeFixedGuide>,
);

export function isHomeParentId(value: unknown): value is HomeParentId {
  return typeof value === "string" && value in HOME_PARENTS_BY_ID;
}

export function isHomeFixedGuideId(value: unknown): value is HomeFixedGuideId {
  return typeof value === "string" && value in FIXED_GUIDES_BY_ID;
}

/** 某入口的默认子项（首项）；无子项返回 null。 */
export function firstNavChild(parentId: HomeParentId): HomeNavChild | null {
  return HOME_PARENTS_BY_ID[parentId]?.children[0] ?? null;
}

/** childId 是否属于 parentId（记忆存档校验用）。 */
export function isChildOfParent(parentId: HomeParentId, childId: HomeChildId): boolean {
  return HOME_PARENTS_BY_ID[parentId]?.children.some((child) => child.id === childId) ?? false;
}

/** 规范化一段选择：入口合法则用其子项/首项，否则回落到首页入口。 */
export function normalizeHomeSelection(selection: HomeSelection): HomeSelection {
  const parent = isHomeParentId(selection.parent) ? selection.parent : "home";
  const fixed = isHomeFixedGuideId(selection.fixed) ? selection.fixed : null;
  const child = isChildOfParent(parent, selection.child ?? "") ? selection.child : (firstNavChild(parent)?.id ?? null);
  return { parent, child, fixed };
}

export function defaultHomeSelection(): HomeSelection {
  return { parent: "home", child: firstNavChild("home")?.id ?? "home.shelf", fixed: null };
}

/**
 * 中间内容区/滚动记忆的键：常驻项 > 子项 > 无子项入口（用入口 id 本身）。
 * 同一键视为同一「中间页面」，滚动位置按它记忆。
 */
export function centerKeyForSelection(selection: HomeSelection): string {
  if (selection.fixed) return selection.fixed;
  if (selection.child) return selection.child;
  return selection.parent;
}

/** 所有可能的中间内容键（记忆存档校验用）。 */
export const HOME_CENTER_KEYS: ReadonlySet<string> = new Set<string>([
  ...HOME_PARENTS.map((parent) => parent.id),
  ...HOME_PARENTS.flatMap((parent) => parent.children.map((child) => child.id)),
  ...HOME_FIXED_GUIDES.map((guide) => guide.id),
]);
