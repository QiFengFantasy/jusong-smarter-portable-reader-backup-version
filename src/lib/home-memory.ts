/**
 * 首页界面状态记忆：层级选择（入口 + 子项 + 常驻项）、桌面左右侧栏开合、
 * 各中间页面的滚动位置。
 *
 * 分工：
 * - 层级选择（parent / child）由设置 `navMemory` 决定读写策略（见 `resolveHomeSelection`）；
 * - 常驻项（检索 / AGENT）与滚动位置、侧栏开合由设置 `rememberUiState` 控制；
 * - 存储统一放 localStorage `jusong.home.memory.v2`，`clearHomeMemory()` 一并清空。
 *
 * 滚动位置按「从首页中间栏 <main> 根节点出发的子元素索引路径」记录：中间页面切换会
 * 卸载/重建中间栏，但同一页面的 DOM 结构稳定，路径可复现；不依赖各视图的 id/class，
 * 因此不需要改动 ShelfView / KnowledgeLibraryView / GuideSearchView 等组件。
 */
import type { NavMemoryMode } from "./settings";
import {
  HOME_CENTER_KEYS,
  firstNavChild,
  isChildOfParent,
  isHomeFixedGuideId,
  isHomeParentId,
  normalizeHomeSelection,
  type HomeChildId,
  type HomeFixedGuideId,
  type HomeParentId,
  type HomeSelection,
} from "./home-nav";

export const HOME_MEMORY_STORAGE_KEY = "jusong.home.memory.v2";
export const HOME_MEMORY_VERSION = 2;

/** 单个滚动容器的记忆：path 为从 <main> 根出发的子元素索引链，top 为 scrollTop。 */
export interface HomeScrollMemory {
  path: number[];
  top: number;
}

/** 层级导航记忆：入口 → 子项（按入口分别记忆），以及上次停留的常驻项。 */
export interface HomeNavMemory {
  /** 上次停留的入口；`navMemory=both` 时恢复它，其余策略强制回「首页」。 */
  lastParent: HomeParentId | null;
  /** 入口 → 上次子项（各策略共用；入口无子项时不记录）。 */
  children: Partial<Record<HomeParentId, HomeChildId>>;
  /** 上次停留的常驻项（检索 / AGENT）；受 `rememberUiState` 控制。 */
  lastFixed: HomeFixedGuideId | null;
}

export interface HomeUiMemory {
  version: number;
  nav: HomeNavMemory;
  /** 桌面端左侧栏是否展开（移动端抽屉不记忆）。 */
  leftOpen: boolean;
  /** 桌面端右侧栏是否展开（移动端抽屉不记忆）。 */
  rightOpen: boolean;
  /** 每个中间页面（`centerKeyForSelection` 键）的滚动容器位置。 */
  scroll: Partial<Record<string, HomeScrollMemory[]>>;
}

/** 每个中间页面最多保留的滚动容器数量，避免存档无限增长。 */
const MAX_SCROLL_ENTRIES = 8;

/** 滚动位置与目标相差多少像素内视为已还原。 */
const SCROLL_RESTORE_TOLERANCE = 1;

function createEmptyNavMemory(): HomeNavMemory {
  return { lastParent: null, children: {}, lastFixed: null };
}

export function createEmptyHomeMemory(): HomeUiMemory {
  return {
    version: HOME_MEMORY_VERSION,
    nav: createEmptyNavMemory(),
    leftOpen: true,
    rightOpen: true,
    scroll: {},
  };
}

function sanitizeNavMemory(value: unknown): HomeNavMemory {
  const nav = createEmptyNavMemory();
  if (!value || typeof value !== "object") return nav;
  const record = value as Record<string, unknown>;
  if (isHomeParentId(record.lastParent)) nav.lastParent = record.lastParent;
  if (record.children && typeof record.children === "object") {
    for (const [parentId, childId] of Object.entries(record.children as Record<string, unknown>)) {
      if (typeof childId !== "string" || !isHomeParentId(parentId)) continue;
      if (!isChildOfParent(parentId, childId)) continue;
      nav.children[parentId] = childId;
    }
  }
  if (isHomeFixedGuideId(record.lastFixed)) nav.lastFixed = record.lastFixed;
  return nav;
}

function sanitizeScrollMemory(value: unknown): Partial<Record<string, HomeScrollMemory[]>> {
  const result: Partial<Record<string, HomeScrollMemory[]>> = {};
  if (!value || typeof value !== "object") return result;
  const record = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(record)) {
    if (!HOME_CENTER_KEYS.has(key) || !Array.isArray(raw)) continue;
    const entries: HomeScrollMemory[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (!Array.isArray(entry.path)) continue;
      const path: number[] = [];
      let validPath = true;
      for (const part of entry.path) {
        if (typeof part !== "number" || !Number.isInteger(part) || part < 0) {
          validPath = false;
          break;
        }
        path.push(part);
      }
      if (!validPath) continue;
      if (typeof entry.top !== "number" || !Number.isFinite(entry.top)) continue;
      entries.push({ path, top: Math.max(0, Math.round(entry.top)) });
      if (entries.length >= MAX_SCROLL_ENTRIES) break;
    }
    if (entries.length > 0) result[key] = entries;
  }
  return result;
}

/** 校验并规范化本地存档；版本不匹配/结构损坏返回 null（调用方用空记忆兜底）。 */
export function sanitizeHomeMemory(value: unknown): HomeUiMemory | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== HOME_MEMORY_VERSION) return null;
  return {
    version: HOME_MEMORY_VERSION,
    nav: sanitizeNavMemory(record.nav),
    leftOpen: record.leftOpen !== false,
    rightOpen: record.rightOpen !== false,
    scroll: sanitizeScrollMemory(record.scroll),
  };
}

function trimScrollMemory(
  scroll: Partial<Record<string, HomeScrollMemory[]>>,
): Partial<Record<string, HomeScrollMemory[]>> {
  const result: Partial<Record<string, HomeScrollMemory[]>> = {};
  for (const [key, entries] of Object.entries(scroll)) {
    if (!HOME_CENTER_KEYS.has(key) || !entries || entries.length === 0) continue;
    result[key] = entries.slice(-MAX_SCROLL_ENTRIES);
  }
  return result;
}

export function readHomeMemory(): HomeUiMemory | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(HOME_MEMORY_STORAGE_KEY);
    if (!raw) return null;
    return sanitizeHomeMemory(JSON.parse(raw) as unknown);
  } catch {
    // 隐私模式/存档损坏：当作没有记忆，不影响首页使用。
    return null;
  }
}

export function storeHomeMemory(memory: HomeUiMemory): void {
  if (typeof window === "undefined") return;
  try {
    const nav = sanitizeNavMemory(memory.nav);
    const payload: HomeUiMemory = {
      version: HOME_MEMORY_VERSION,
      nav,
      leftOpen: memory.leftOpen,
      rightOpen: memory.rightOpen,
      scroll: trimScrollMemory(memory.scroll),
    };
    window.localStorage.setItem(HOME_MEMORY_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 写入失败只影响记忆，不影响当前界面。
  }
}

export function clearHomeMemory(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(HOME_MEMORY_STORAGE_KEY);
    // 顺带清掉第一批的旧存档（结构已变化，不再读取）。
    window.localStorage.removeItem("jusong.home.memory.v1");
  } catch {
    // 忽略。
  }
}

export interface HomeSelectionResolutionInput {
  /** 设置里的「导航记忆」策略。 */
  navMemory: NavMemoryMode;
  /** 本地记忆存档（没有则为 null）。 */
  memory: HomeUiMemory | null;
  /** 是否恢复常驻项（检索/AGENT）——由 `rememberUiState` 控制。 */
  restoreFixed: boolean;
  /** 导航 state 带来的一次性显式选择（优先级最高）。 */
  explicit: HomeSelection | null;
}

/**
 * 决定进入首页时打开哪个「入口 + 子项 + 常驻项」：
 * - 显式 openView 优先；
 * - `both`：恢复上次入口与其子项；
 * - `rightOnly` / `alwaysHome`：入口强制「首页」，子项仍按记忆/首项；
 * - 常驻项只在 `rememberUiState` 打开时恢复。
 */
export function resolveHomeSelection(input: HomeSelectionResolutionInput): HomeSelection {
  if (input.explicit) return normalizeHomeSelection(input.explicit);
  const nav = input.memory?.nav ?? null;
  const rememberedParent =
    input.navMemory === "both" ? (nav?.lastParent ?? null) : ("home" as HomeParentId);
  const parent: HomeParentId =
    rememberedParent && isHomeParentId(rememberedParent) ? rememberedParent : "home";
  const rememberedChild = nav?.children[parent] ?? null;
  const child =
    rememberedChild && isChildOfParent(parent, rememberedChild)
      ? rememberedChild
      : (firstNavChild(parent)?.id ?? null);
  const fixed =
    input.restoreFixed && nav?.lastFixed && isHomeFixedGuideId(nav.lastFixed)
      ? nav.lastFixed
      : null;
  return { parent, child, fixed };
}

export interface RecordNavSelectionOptions {
  /** 设置里的「导航记忆」策略（当前实现里各策略共用同一份子项记忆）。 */
  navMode: NavMemoryMode;
  /** 设置里的「记忆界面状态」——关闭时不写常驻项。 */
  rememberUiState: boolean;
}

/**
 * 把当前选择写进记忆存档（就地修改）。
 * 返回 true 表示记忆有变化（调用方可延迟写盘）。
 *
 * 说明：`lastParent` 总是记录真实入口，但 `resolveHomeSelection` 只在 `both`
 * 策略下使用它；这样用户切换策略后仍能恢复合理的入口。
 */
export function recordNavSelection(
  memory: HomeUiMemory,
  selection: HomeSelection,
  options: RecordNavSelectionOptions,
): boolean {
  const nav = memory.nav;
  let changed = false;
  const normalized = normalizeHomeSelection(selection);

  if (nav.lastParent !== normalized.parent) {
    nav.lastParent = normalized.parent;
    changed = true;
  }

  if (normalized.child && isChildOfParent(normalized.parent, normalized.child)) {
    if (nav.children[normalized.parent] !== normalized.child) {
      nav.children[normalized.parent] = normalized.child;
      changed = true;
    }
  }

  if (options.rememberUiState) {
    const nextFixed = normalized.fixed;
    if (nav.lastFixed !== nextFixed) {
      nav.lastFixed = nextFixed;
      changed = true;
    }
  }
  return changed;
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** 元素相对 root 的子元素索引路径（root 自身为 []，不在 root 内返回 null）。 */
export function elementPathFromRoot(root: Element, element: Element): number[] | null {
  if (element === root) return [];
  if (!root.contains(element)) return null;
  const path: number[] = [];
  let current: Element = element;
  while (current !== root) {
    const parent: Element | null = current.parentElement;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.children, current) as number;
    if (index < 0) return null;
    path.unshift(index);
    current = parent;
  }
  return path;
}

/** 按索引路径找回元素；视图内 DOM 结构变化（例如知识库总览/详情切换）时返回 null。 */
export function resolveElementPath(root: Element, path: readonly number[]): HTMLElement | null {
  let current: Element = root;
  for (const index of path) {
    const next: Element | undefined = current.children[index];
    if (!next) return null;
    current = next;
  }
  return current instanceof HTMLElement ? current : null;
}

/**
 * 记录某个滚动容器的最新位置：`top <= 0` 表示回到顶部，删除该条记录，
 * 避免下次进入页面时把「已回顶」误还原成旧位置。
 * 返回 true 表示记忆有变化（调用方可延迟写盘）。
 */
export function recordScrollMemory(
  memory: HomeUiMemory,
  centerKey: string,
  path: readonly number[],
  top: number,
): boolean {
  if (!HOME_CENTER_KEYS.has(centerKey)) return false;
  if (!Array.isArray(path) || path.length === 0) return false;
  const nextTop = Math.max(0, Math.round(top));
  const list = memory.scroll[centerKey];
  if (nextTop <= SCROLL_RESTORE_TOLERANCE) {
    if (!list) return false;
    const next = list.filter((entry) => !samePath(entry.path, path));
    if (next.length === list.length) return false;
    if (next.length > 0) memory.scroll[centerKey] = next;
    else delete memory.scroll[centerKey];
    return true;
  }
  if (!list) {
    memory.scroll[centerKey] = [{ path: [...path], top: nextTop }];
    return true;
  }
  const existing = list.find((entry) => samePath(entry.path, path));
  if (existing) {
    if (existing.top === nextTop) return false;
    existing.top = nextTop;
    return true;
  }
  list.push({ path: [...path], top: nextTop });
  if (list.length > MAX_SCROLL_ENTRIES) list.splice(0, list.length - MAX_SCROLL_ENTRIES);
  return true;
}

/** 取出某中间页面的滚动记忆（副本，调用方修改不会影响存档对象）。 */
export function readScrollMemory(memory: HomeUiMemory, centerKey: string): HomeScrollMemory[] {
  const entries = memory.scroll[centerKey];
  if (!entries) return [];
  return entries.map((entry) => ({ path: [...entry.path], top: entry.top }));
}
