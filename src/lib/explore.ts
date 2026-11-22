import { useEffect, useState } from "react";
import type { ChapterExplore, Library } from "@jusong/core";

/**
 * 单章探索数据（`chapters/<chapterId>/explore.json`）的读取与判定。
 *
 * 数据契约见 `@jusong/core` 的 `ChapterExplore`：地图/时间线是整书 `shared/topics`
 * 事实源在章节维度的投影，缺失（导入书、未迁移书、文件损坏）一律返回 `null`，
 * **不视为错误**；只有 IPC 失败才通过 `error` 暴露。
 *
 * 面板 tab 的可用性判定（与 CONTRACTS §2.2 一致）：
 * - 有地图：`map` 存在且 placeIds / routeIds / focus 任一非空；
 * - 有时间线：`timeline.eventIds.length > 0`。
 */

export interface ChapterExploreState {
  /** 本章 explore 投影；缺失为 `null`。 */
  explore: ChapterExplore | null;
  /** 正在读取（缓存命中时为 false）。 */
  loading: boolean;
  /** 仅 IPC/解析异常时给出；文件缺失不算错误。 */
  error: string | null;
  /** 有地图数据（地点/路线/焦点任一）。 */
  hasMap: boolean;
  /** 有时间线数据（eventIds 非空）。 */
  hasTimeline: boolean;
}

const EMPTY_STATE: ChapterExploreState = {
  explore: null,
  loading: false,
  error: null,
  hasMap: false,
  hasTimeline: false,
};

/** explore.json 是静态章节数据：按 chapterId 缓存，避免切章/重挂载重复 IPC。 */
const EXPLORE_CACHE_MAX = 160;
const exploreCache = new Map<string, ChapterExplore | null>();
const inflight = new Map<string, Promise<ChapterExplore | null>>();

function cacheKey(bookId: string, chapterId: string): string {
  return `${bookId}/${chapterId}`;
}

/** 地图可用性：有地点、路线或焦点任一即视为有地图数据。 */
export function chapterExploreHasMap(explore: ChapterExplore | null | undefined): boolean {
  const map = explore?.map;
  if (!map) return false;
  return map.placeIds.length > 0 || map.routeIds.length > 0 || Boolean(map.focus);
}

/** 时间线可用性：eventIds 非空即视为有时间线数据。 */
export function chapterExploreHasTimeline(explore: ChapterExplore | null | undefined): boolean {
  return (explore?.timeline?.eventIds?.length ?? 0) > 0;
}

/** 同步读缓存：`undefined` 表示未缓存，`null` 表示已确认本章没有 explore。 */
export function getCachedChapterExplore(
  bookId: string,
  chapterId: string,
): ChapterExplore | null | undefined {
  return exploreCache.get(cacheKey(bookId, chapterId));
}

function rememberExplore(key: string, explore: ChapterExplore | null): void {
  exploreCache.set(key, explore);
  while (exploreCache.size > EXPLORE_CACHE_MAX) {
    const oldest = exploreCache.keys().next().value;
    if (oldest === undefined) break;
    exploreCache.delete(oldest);
  }
}

/** 失效缓存：导入/迁移/AGENT 写入探索数据后调用（不传参清空全部）。 */
export function invalidateChapterExplore(bookId?: string, chapterId?: string): void {
  if (bookId && chapterId) {
    exploreCache.delete(cacheKey(bookId, chapterId));
    return;
  }
  if (bookId) {
    for (const key of [...exploreCache.keys()]) {
      if (key.startsWith(`${bookId}/`)) exploreCache.delete(key);
    }
    return;
  }
  exploreCache.clear();
}

/**
 * 读取一章的 explore 数据（带并发去重与缓存）。
 * 缺失返回 `null`（Rust 侧对缺失/损坏同样返回 null），失败抛错由调用方决定是否降级。
 */
export function loadChapterExplore(
  library: Library,
  bookId: string,
  chapterId: string,
): Promise<ChapterExplore | null> {
  const key = cacheKey(bookId, chapterId);
  if (exploreCache.has(key)) return Promise.resolve(exploreCache.get(key) ?? null);
  const running = inflight.get(key);
  if (running) return running;

  const promise = library
    .getChapterExplore(bookId, chapterId)
    .then((explore) => {
      const normalized = explore ?? null;
      rememberExplore(key, normalized);
      return normalized;
    })
    .catch((error: unknown) => {
      // 失败不缓存，允许下次重试。
      exploreCache.delete(key);
      throw error;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

function stateFromExplore(explore: ChapterExplore | null, error: string | null = null): ChapterExploreState {
  return {
    explore,
    loading: false,
    error,
    hasMap: chapterExploreHasMap(explore),
    hasTimeline: chapterExploreHasTimeline(explore),
  };
}

/**
 * 当前章节的 explore 数据。
 *
 * - 缓存命中：同步返回，不闪载入态；
 * - 章节切换：先清空（避免上一章数据冒充本章），读完再写入；
 * - 读取失败：`explore` 为 null、`error` 为消息；面板据此显示「其他」兜底，不阻塞阅读。
 */
export function useChapterExplore(
  library: Library | null,
  bookId: string | null | undefined,
  chapterId: string | null | undefined,
): ChapterExploreState {
  const [state, setState] = useState<ChapterExploreState>(() => {
    if (!bookId || !chapterId) return EMPTY_STATE;
    const cached = getCachedChapterExplore(bookId, chapterId);
    return cached === undefined ? { ...EMPTY_STATE, loading: true } : stateFromExplore(cached);
  });

  useEffect(() => {
    if (!library || !bookId || !chapterId) {
      setState(EMPTY_STATE);
      return;
    }
    const cached = getCachedChapterExplore(bookId, chapterId);
    if (cached !== undefined) {
      setState(stateFromExplore(cached));
      return;
    }

    let alive = true;
    setState({ ...EMPTY_STATE, loading: true });
    loadChapterExplore(library, bookId, chapterId)
      .then((explore) => {
        if (alive) setState(stateFromExplore(explore));
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setState(stateFromExplore(null, message || "本章探索数据读取失败。"));
      });

    return () => {
      alive = false;
    };
  }, [library, bookId, chapterId]);

  return state;
}

// ---------------------------------------------------------------------------
// 「其他」卡片 → AGENT 提示词
// ---------------------------------------------------------------------------

/** 缺失的探索项。 */
export type ExploreMissingKind = "map" | "timeline";
/** 「更新」= 补齐/修正已有；「添加」= 从零补充。 */
export type ExplorePromptAction = "update" | "add";

export interface ExplorePromptInput {
  kind: ExploreMissingKind;
  action: ExplorePromptAction;
  bookTitle?: string;
  chapterTitle?: string;
  chapterId?: string;
}

/** 缺失探索项的展示文案：标题与说明词（面板卡片使用）。 */
export function exploreMissingCopy(kind: ExploreMissingKind): { title: string; description: string } {
  return kind === "map"
    ? { title: "地图", description: "本章暂无地图地点数据" }
    : { title: "时间线", description: "本章暂无时间线数据" };
}

/**
 * 生成交给 AGENT 的提示词（只预填，不自动发送）。
 * 提示词明确本章/书籍与目标数据结构，避免 AGENT 伪造数据时缺少约束。
 */
export function buildExploreAgentPrompt(input: ExplorePromptInput): string {
  const { kind, action, bookTitle, chapterTitle, chapterId } = input;
  const bookPart = bookTitle ? `《${bookTitle}》` : "";
  const chapterPart = chapterTitle ? `「${chapterTitle}」` : "";
  let target = bookPart + chapterPart;
  if (!target) target = "当前书籍的当前章节";
  else if (!chapterPart) target = `${target}当前章节`;
  else if (!bookPart) target = `当前书籍${target}`;
  if (chapterId) target = `${target}（章节 id：${chapterId}）`;

  const verb = action === "update" ? "更新" : "添加";
  if (kind === "map") {
    return `请${verb}${target}的地图地点数据：整理本章出现的写作地点、地名与行动路线，给出每条路线经过的地点与地图焦点（经度/纬度/缩放）。请只依据书中可靠内容，不要编造；完成后说明需要写入哪些数据。`;
  }
  return `请${verb}${target}的时间线数据：整理与本章相关的写成前后事件（日期、标题、摘要、涉及地点），并说明每个事件与本章的关联。请只依据书中可靠内容，不要编造；完成后说明需要写入哪些数据。`;
}
