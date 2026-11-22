import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  ReactNode,
  TouchEvent as ReactTouchEvent,
} from "react";

import { ReaderSwipeProgress } from "./ReaderEdgeNav";

/**
 * 阅读器手势与返回拦截。
 *
 * 本文件提供三个对外 API（lead 在 `ReaderPage.tsx` 里接线）：
 *
 * 1. `useReaderGestures`：中间正文面板的移动端左右滑动翻章。
 *    - 返回 `{ active, progress, direction, bind, overlay }`；
 *    - `bind` 展开到正文面板容器：`<div {...gestures.bind} className="relative …">`；
 *    - `overlay` 放进同一个相对定位容器（渲染滑动进度环）。
 * 2. `ReaderSwipeProgress`：进度环（SVG 环 + 方向箭头），从 `./ReaderEdgeNav` 导出。
 * 3. `useReaderBackGuard`：Android 返回键/手势返回 → 首页；桌面拦截鼠标侧键与 Alt+←/→。
 *
 * 约束：不阻断正文纵向滚动、文本选择与面板手势（不调用 `preventDefault`，
 * 仅通过 `touch-action: pan-y pinch-zoom` 声明横向手势归我们处理）。
 */

/** 判定为翻章手势的最小水平位移（px）。 */
const MIN_SWIPE_DISTANCE = 8;
/** 未达阈值松手时的回弹动画时长（ms）。 */
const SETTLE_DURATION_MS = 140;
/** 阈值夹取范围（与 `src/lib/settings.tsx` 的 normalizeSwipeThreshold 保持一致）。 */
const SWIPE_THRESHOLD_MIN = 0.1;
const SWIPE_THRESHOLD_MAX = 0.4;
const SWIPE_THRESHOLD_FALLBACK = 0.22;

/** 滑动方向：`prev` = 上一章（右滑），`next` = 下一章（左滑）。 */
export type ReaderSwipeDirection = "prev" | "next";

/** 手势进行中的可观察状态。 */
export interface ReaderSwipeState {
  /** 是否已判定为水平翻章手势（未达到 8px / 垂直优先时不激活）。 */
  active: boolean;
  /** 0–1：`|dx| / 面板宽度 / 阈值`；达到 1 即松手会翻章。 */
  progress: number;
  /** 当前方向；null 表示尚未判定、或该方向没有可翻的章节。 */
  direction: ReaderSwipeDirection | null;
}

/** 挂到正文面板容器上的事件与样式。 */
export interface ReaderGestureBind {
  ref: (node: HTMLElement | null) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchMove: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => void;
  onTouchCancel: (event: ReactTouchEvent<HTMLElement>) => void;
  /** `touch-action`：纵向滚动/双指缩放留给浏览器，横向滑动由本 hook 读取。 */
  style: CSSProperties;
}

export interface ReaderGestureOptions {
  /** 翻章阈值：滑动距离 / 面板宽度（来自 `settings.readerSwipeThreshold`，0.1–0.4）。 */
  threshold: number;
  /** 达到阈值松手时回调（右滑上一章）。 */
  onPrev: () => void;
  /** 达到阈值松手时回调（左滑下一章）。 */
  onNext: () => void;
  /** 是否有上一章；无时不触发回调（默认 true）。 */
  canPrev?: boolean;
  /** 是否有下一章；无时不触发回调（默认 true）。 */
  canNext?: boolean;
  /**
   * 是否启用滑动翻章。缺省按 `(pointer: coarse)` 自动判断：
   * 触屏设备启用、桌面鼠标设备不启用（契约要求桌面不启用滑动）。
   */
  enabled?: boolean;
}

export interface ReaderGesturesResult extends ReaderSwipeState {
  /** 挂到中间正文面板容器：`<div {...gestures.bind} …>`。 */
  bind: ReaderGestureBind;
  /** 滑动进度环（直接渲染到正文面板容器内即可；无手势时为 null）。 */
  overlay: ReactNode;
}

interface SwipeTracker {
  /** 已判定为水平滑动。 */
  horizontal: boolean;
  /** 已放弃（垂直滚动优先 / 多指 / 出现选区等）。 */
  cancelled: boolean;
  startX: number;
  startY: number;
  width: number;
  touchId: number;
  direction: ReaderSwipeDirection | null;
  progress: number;
  /** 当前方向是否有章节可翻。 */
  available: boolean;
}

function clampSwipeThreshold(value: number): number {
  if (!Number.isFinite(value)) return SWIPE_THRESHOLD_FALLBACK;
  return Math.min(SWIPE_THRESHOLD_MAX, Math.max(SWIPE_THRESHOLD_MIN, value));
}

function readCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

/** 主指针是否为触屏（桌面鼠标设备为 false）。 */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(readCoarsePointer);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return coarse;
}

function findTouch(
  touches: ReactTouchEvent<HTMLElement>["touches"],
  identifier: number,
): ReactTouchEvent<HTMLElement>["touches"][number] | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch.identifier === identifier) return touch;
  }
  return null;
}

/** 触摸目标是否落在不应触发翻章手势的交互元素内。 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "input, textarea, select, [contenteditable='true'], [data-reader-gesture-ignore]",
    ),
  );
}

/**
 * 中间正文面板的移动端左右滑动翻章。
 *
 * 判定规则（契约 3.2）：
 * - 水平位移 > 垂直位移且 > 8px 才判定为翻页手势；一旦垂直分量更大即放弃，把滚动留给浏览器；
 * - 进度 = `|dx| / 面板宽度 / threshold`（0–1），达到 1 即高亮进度环；
 * - 松手达到阈值 → `onNext`（左滑）/ `onPrev`（右滑），否则回弹；
 * - 不阻断纵向滚动/文本选择：不使用 `preventDefault`、不在选区存在时启动手势。
 *
 * @example
 * const gestures = useReaderGestures({
 *   threshold: settings.readerSwipeThreshold,
 *   canPrev: Boolean(prevChapter),
 *   canNext: Boolean(nextChapter),
 *   onPrev: () => prevChapter && selectChapter(prevChapter.chapterId),
 *   onNext: () => nextChapter && selectChapter(nextChapter.chapterId),
 * });
 * <div {...gestures.bind} className="relative min-h-0 min-w-0 flex-1">
 *   …正文…
 *   {gestures.overlay}
 * </div>
 */
export function useReaderGestures({
  threshold,
  onPrev,
  onNext,
  canPrev = true,
  canNext = true,
  enabled,
}: ReaderGestureOptions): ReaderGesturesResult {
  const containerRef = useRef<HTMLElement | null>(null);
  const trackerRef = useRef<SwipeTracker | null>(null);
  const settleFrameRef = useRef<number | null>(null);
  const [state, setState] = useState<ReaderSwipeState>({
    active: false,
    progress: 0,
    direction: null,
  });

  const coarsePointer = useCoarsePointer();
  const swipeEnabled = enabled ?? coarsePointer;

  // 最新回调/阈值放进 ref：手势进行中重渲染不会重新绑定事件，也不会读到旧闭包。
  const latestRef = useRef({ threshold, onPrev, onNext, canPrev, canNext, swipeEnabled });
  latestRef.current = { threshold, onPrev, onNext, canPrev, canNext, swipeEnabled };

  const clearSettleFrame = useCallback(() => {
    if (settleFrameRef.current !== null) {
      cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = null;
    }
  }, []);

  /** 未达阈值松手：把进度环在 ~140ms 内收到 0（回弹），避免瞬间消失。 */
  const settleBack = useCallback(
    (from: number) => {
      clearSettleFrame();
      const start = performance.now();
      const step = (now: number) => {
        const ratio = Math.min(1, (now - start) / SETTLE_DURATION_MS);
        if (ratio >= 1) {
          settleFrameRef.current = null;
          setState({ active: false, progress: 0, direction: null });
          return;
        }
        setState((previous) => ({
          active: false,
          progress: from * (1 - ratio),
          direction: previous.direction,
        }));
        settleFrameRef.current = requestAnimationFrame(step);
      };
      settleFrameRef.current = requestAnimationFrame(step);
    },
    [clearSettleFrame],
  );

  const handleTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLElement>) => {
      if (!latestRef.current.swipeEnabled) return;
      clearSettleFrame();
      trackerRef.current = null;
      // 取消上一次回弹动画后把残留进度归零，避免进度环停在半透明状态。
      setState((previous) =>
        previous.active || previous.progress > 0 || previous.direction !== null
          ? { active: false, progress: 0, direction: null }
          : previous,
      );

      // 多指（缩放/双指操作）不参与翻章手势。
      if (event.touches.length !== 1) return;
      // 已有文字选区：优先保留用户的选择操作（长按选择后拖动等）。
      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (selection && !selection.isCollapsed) return;
      if (isInteractiveTarget(event.target)) return;

      const touch = event.touches[0];
      const width =
        containerRef.current?.clientWidth ||
        (typeof window !== "undefined" ? window.innerWidth : 0);
      trackerRef.current = {
        horizontal: false,
        cancelled: false,
        startX: touch.clientX,
        startY: touch.clientY,
        width: Math.max(1, width),
        touchId: touch.identifier,
        direction: null,
        progress: 0,
        available: false,
      };
      setState({ active: false, progress: 0, direction: null });
    },
    [clearSettleFrame],
  );

  const handleTouchMove = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const tracker = trackerRef.current;
    if (!tracker || tracker.cancelled || !latestRef.current.swipeEnabled) return;

    // 触摸过程中出现选区（长按选择）：让位给选择，不显示翻章进度。
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) {
      tracker.cancelled = true;
      trackerRef.current = null;
      setState({ active: false, progress: 0, direction: null });
      return;
    }

    const touch = findTouch(event.touches, tracker.touchId);
    if (!touch) return;

    const dx = touch.clientX - tracker.startX;
    const dy = touch.clientY - tracker.startY;

    if (!tracker.horizontal) {
      const absX = Math.abs(dx);
      if (absX <= MIN_SWIPE_DISTANCE) return;
      // 垂直位移更大：这是纵向滚动，放弃本次手势。
      if (absX <= Math.abs(dy)) {
        tracker.cancelled = true;
        return;
      }
      tracker.horizontal = true;
    }

    const { threshold, canPrev, canNext } = latestRef.current;
    const safeThreshold = clampSwipeThreshold(threshold);
    const progress = Math.min(1, Math.abs(dx) / tracker.width / safeThreshold);
    const rawDirection: ReaderSwipeDirection = dx < 0 ? "next" : "prev";
    const available = rawDirection === "next" ? canNext : canPrev;

    tracker.direction = rawDirection;
    tracker.progress = progress;
    tracker.available = available;

    setState({
      active: true,
      progress,
      // 该方向没有可翻章节时不显示方向箭头（进度环仍随位移增长，松手只回弹）。
      direction: available ? rawDirection : null,
    });
  }, []);

  const handleTouchEnd = useCallback(
    (_event: ReactTouchEvent<HTMLElement>) => {
      const tracker = trackerRef.current;
      trackerRef.current = null;
      if (!tracker || !tracker.horizontal) {
        setState({ active: false, progress: 0, direction: null });
        return;
      }

      if (tracker.progress >= 1 && tracker.available && tracker.direction) {
        // 达到阈值：立即清空进度环并翻章（章节切换后正文区域会重渲染）。
        setState({ active: false, progress: 0, direction: null });
        if (tracker.direction === "next") latestRef.current.onNext();
        else latestRef.current.onPrev();
        return;
      }

      if (tracker.progress > 0) settleBack(tracker.progress);
      else setState({ active: false, progress: 0, direction: null });
    },
    [settleBack],
  );

  const handleTouchCancel = useCallback(
    (_event: ReactTouchEvent<HTMLElement>) => {
      const tracker = trackerRef.current;
      trackerRef.current = null;
      if (tracker && tracker.progress > 0) settleBack(tracker.progress);
      else setState({ active: false, progress: 0, direction: null });
    },
    [settleBack],
  );

  // 卸载时清掉回弹动画帧，避免对已卸载组件 setState。
  useEffect(() => {
    return () => {
      if (settleFrameRef.current !== null) {
        cancelAnimationFrame(settleFrameRef.current);
        settleFrameRef.current = null;
      }
      trackerRef.current = null;
    };
  }, []);

  const bind = useMemo<ReaderGestureBind>(
    () => ({
      ref: (node: HTMLElement | null) => {
        containerRef.current = node;
      },
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchCancel,
      style: { touchAction: "pan-y pinch-zoom" },
    }),
    [handleTouchCancel, handleTouchEnd, handleTouchMove, handleTouchStart],
  );

  const overlay = useMemo<ReactNode>(
    () =>
      createElement(ReaderSwipeProgress, {
        active: state.active,
        progress: state.progress,
        direction: state.direction,
      }),
    [state.active, state.direction, state.progress],
  );

  return { ...state, bind, overlay };
}

/* -------------------------------------------------------------------------- */
/* 返回拦截                                                                     */
/* -------------------------------------------------------------------------- */

/** 当前运行环境是否 Android（Tauri Android / Android WebView）。 */
export function isAndroidReader(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

/** 阅读器路由的 hash 前缀（HashRouter）：`#/read/<bookId>/<chapterId>`。 */
const READER_HASH_PREFIX = "#/read/";
/** 打在压入历史记录上的标记，用于避免 StrictMode 下重复压入哨兵。 */
const BACK_GUARD_STATE_KEY = "__readerBackGuard";

function currentHistoryState(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const state = window.history.state;
  return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

function pushBackGuardSentinel(): void {
  if (typeof window === "undefined") return;
  // 同 URL 压入一条历史记录：返回键先触发 popstate，由本 hook 决定是关闭浮层还是回首页。
  // 注意不修改 URL/hash，因此 React Router 在 popstate 后看到的 location 不变，正文不会重挂载。
  window.history.pushState({ ...currentHistoryState(), [BACK_GUARD_STATE_KEY]: true }, "");
}

export interface ReaderBackGuardOptions {
  /** 返回首页（lead 用 `navigate("/", { replace: true })` 实现，见接线说明）。 */
  onBackHome: () => void;
  /**
   * 返回前的优先动作：关闭阅读器内的覆盖层/抽屉。
   * 返回 true 表示本次返回已被消费（不离开阅读器）。
   */
  onBeforeBack?: () => boolean;
  /** 是否启用，默认 true（仅在阅读器页面调用本 hook）。 */
  enabled?: boolean;
}

/**
 * 阅读器返回拦截（契约 3.2）。
 *
 * - Android（UA 含 Android）：WebView 的硬件返回/手势返回会先触发 `popstate`；
 *   本 hook 在挂载时压入一条同 URL 的哨兵历史记录，保证返回时总有 `popstate` 可拦。
 *   `onBeforeBack` 返回 true 时只关闭覆盖层/抽屉，否则调用 `onBackHome` 回首页。
 * - 桌面：拦截鼠标侧键（pointerdown/mousedown button 3/4）与 `Alt + ←/→`，
 *   `preventDefault` 掉浏览器的历史后退，改为与 Android 一致地走 `onBeforeBack` / `onBackHome`。
 *   不拦截刷新/关闭窗口，也不拦截输入框内的 Alt+方向键（编辑语义）。
 *
 * 不引入新依赖；Android 判定见 `isAndroidReader()`。
 */
export function useReaderBackGuard({
  onBackHome,
  onBeforeBack,
  enabled = true,
}: ReaderBackGuardOptions): void {
  const onBackHomeRef = useRef(onBackHome);
  onBackHomeRef.current = onBackHome;
  const onBeforeBackRef = useRef(onBeforeBack);
  onBeforeBackRef.current = onBeforeBack;

  const android = useMemo(() => isAndroidReader(), []);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    if (android) {
      // StrictMode 会双跑 effect：当前记录已带标记时不再重复压入。
      if (currentHistoryState()[BACK_GUARD_STATE_KEY] !== true) pushBackGuardSentinel();
    }

    /** 本次返回：先尝试关闭覆盖层/抽屉；返回 true 表示已消费。 */
    const consumeBeforeBack = (): boolean => {
      return onBeforeBackRef.current?.() === true;
    };

    const handlePopState = () => {
      // 路由已经离开阅读器（例如从首页返回）：交给路由处理，不重复导航。
      if (!window.location.hash.startsWith(READER_HASH_PREFIX)) return;
      if (consumeBeforeBack()) {
        // 覆盖层/抽屉已关闭，仍在阅读器：补一条哨兵，下一次返回继续由本 hook 拦截。
        pushBackGuardSentinel();
        return;
      }
      onBackHomeRef.current();
    };

    const handlePointerDown = (event: PointerEvent) => {
      // 鼠标侧键（后退/前进）默认会触发 WebView 历史导航，这里统一改走阅读器返回逻辑。
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (consumeBeforeBack()) return;
      onBackHomeRef.current();
    };

    // 兼容个别不派发 pointerdown 的辅助键场景：只阻止默认历史导航，动作由 pointerdown 处理。
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      // 输入框/可编辑区域里 Alt+方向键有编辑语义（按词移动），不拦截。
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      if (consumeBeforeBack()) return;
      onBackHomeRef.current();
    };

    if (android) {
      window.addEventListener("popstate", handlePopState);
    } else {
      window.addEventListener("pointerdown", handlePointerDown);
      window.addEventListener("mousedown", handleMouseDown);
      window.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [android, enabled]);
}
