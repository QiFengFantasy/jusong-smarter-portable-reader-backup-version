import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import {
  availablePaneWidth,
  clampPaneWidth,
  PANE_KEY_STEP,
  PANE_KEY_STEP_LARGE,
  readStoredPaneWidth,
  storePaneWidth,
  type PaneWidthConfig,
} from "./paneResize";

export type PaneSide = "left" | "right";

export interface UsePaneWidthOptions extends PaneWidthConfig {
  side: PaneSide;
  /** 拖动/夹取时另一侧栏已占用的宽度（用于给正文留住最小宽度）。 */
  reservedWidth?: () => number;
  minContentWidth?: number;
  /**
   * 该侧栏在当前视口是否真正可见（窄屏会被 CSS 隐藏）。
   * 不可见时不做视口夹取，避免用户把窗口缩小后再放大时丢失已设定的宽度。
   */
  isVisible?: (viewportWidth: number) => boolean;
  /**
   * 受控渲染宽度（可选）：由调用方按更复杂的布局规则算出「这一侧现在实际显示多宽」，
   * 例如阅读器要同时保证「正文 ≥ 460」并按 settings.paneShrinkPriority 分配收缩。
   *
   * 提供后：
   * - 返回的 `width` 用该值（仍夹取到 [minWidth, maxWidth]），`preferredWidth` 保留用户偏好；
   * - 不再自动把宽度状态收回到视口可用范围（窗口变窄只影响渲染，窗口恢复后回到偏好宽度）；
   * - 拖动/键盘以当前渲染宽度为起点，上限仍按「另一侧已占 + 正文最小宽度」计算，正文不会被压穿。
   *
   * 缺省时不改变原有行为（首页等调用方不受影响）。
   */
  effectiveWidth?: () => number;
}

/** 直接展开到分隔条元素上的事件属性。 */
export interface PaneWidthHandleProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
}

export interface PaneWidthControls {
  /** 当前实际渲染宽度（受控模式下由 effectiveWidth 决定；否则等于偏好宽度）。 */
  width: number;
  /** 用户偏好宽度（拖动/键盘调整后写入 localStorage 的值）。 */
  preferredWidth: number;
  minWidth: number;
  maxWidth: number;
  /** 实际可拖到的上限（视口与另一侧栏决定）。 */
  limit: number;
  dragging: boolean;
  reset: () => void;
  handleProps: PaneWidthHandleProps;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  lastWidth: number;
}

/**
 * 可拖拽侧栏宽度：状态、拖动、键盘与持久化。
 *
 * - 鼠标/触屏：pointer 事件 + setPointerCapture，拖到视口任何位置都跟手；
 * - 键盘：左右方向键微调（Shift 加大步长），Home/End 到极限，Enter 恢复默认；
 * - 双击恢复默认；宽度写入 localStorage，跨刷新保留；
 * - 窗口变小或另一侧变宽时自动收回可用范围，正文永远留出 MIN_READER_CONTENT_WIDTH。
 */
export function usePaneWidth(options: UsePaneWidthOptions): PaneWidthControls {
  const { storageKey, defaultWidth, minWidth, maxWidth, side } = options;

  const [width, setWidth] = useState(() =>
    readStoredPaneWidth(storageKey, defaultWidth, minWidth, maxWidth),
  );
  const [dragging, setDragging] = useState(false);

  // 事件回调里读最新值，避免把 options 塞进依赖导致处理器反复重建。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** 受控模式下以「当前实际渲染宽度」为拖动/键盘起点；非受控模式就是偏好宽度。 */
  const effectiveWidth = options.effectiveWidth
    ? clampPaneWidth(options.effectiveWidth(), options.minWidth, options.maxWidth)
    : width;

  const widthRef = useRef(effectiveWidth);
  widthRef.current = effectiveWidth;

  const resolveCurrentWidth = useCallback((): number => {
    const current = optionsRef.current;
    if (current.effectiveWidth) {
      return clampPaneWidth(current.effectiveWidth(), current.minWidth, current.maxWidth);
    }
    return widthRef.current;
  }, []);

  const dragRef = useRef<DragState | null>(null);

  const computeLimit = useCallback((): number => {
    const current = optionsRef.current;
    const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
    // 被断点隐藏时不参与视口夹取：保留用户设定，等重新可见再按视口收。
    if (current.isVisible && !current.isVisible(viewportWidth)) return current.maxWidth;
    return availablePaneWidth({
      viewportWidth,
      reservedWidth: current.reservedWidth?.() ?? 0,
      minWidth: current.minWidth,
      maxWidth: current.maxWidth,
      minContentWidth: current.minContentWidth,
    });
  }, []);

  const applyLimit = useCallback((next: number): number => {
    return clampPaneWidth(next, optionsRef.current.minWidth, computeLimit());
  }, [computeLimit]);

  // 每轮渲染后把宽度收回可用范围：另一侧变宽、开关侧栏、窗口变化都会触发。
  // 值没变时返回同一个数字，React 会跳过更新，不会形成循环。
  // 受控宽度模式（effectiveWidth）下跳过：渲染宽度已由调用方算好，偏好值不应被写回。
  useEffect(() => {
    if (optionsRef.current.effectiveWidth) return;
    setWidth(current => {
      const next = applyLimit(current);
      return next === current ? current : next;
    });
  });

  useEffect(() => {
    const onResize = () => {
      if (optionsRef.current.effectiveWidth) return;
      setWidth(current => {
        const next = applyLimit(current);
        return next === current ? current : next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyLimit]);

  // 拖动时统一鼠标样式并禁止选中文字（地图/正文也不会抢走指针）。
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("pane-resizing");
    return () => document.body.classList.remove("pane-resizing");
  }, [dragging]);

  const commit = useCallback((next: number) => {
    widthRef.current = next;
    setWidth(next);
    storePaneWidth(storageKey, next);
  }, [storageKey]);

  const reset = useCallback(() => {
    commit(applyLimit(defaultWidth));
  }, [applyLimit, commit, defaultWidth]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const element = event.currentTarget;
    const startWidth = resolveCurrentWidth();
    element.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      lastWidth: startWidth,
    };
    setDragging(true);
    event.preventDefault();
  }, [resolveCurrentWidth]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = event.clientX - drag.startX;
    const next = applyLimit(drag.startWidth + (side === "left" ? delta : -delta));
    drag.lastWidth = next;
    if (next !== widthRef.current) {
      widthRef.current = next;
      setWidth(next);
    }
  }, [applyLimit, side]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    const element = event.currentTarget;
    if (element.hasPointerCapture?.(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    storePaneWidth(storageKey, drag.lastWidth);
  }, [storageKey]);

  // 触屏被系统手势打断、或指针捕获丢失时也要收尾并把最后宽度存下来。
  const cancelDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    storePaneWidth(storageKey, drag.lastWidth);
  }, [storageKey]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? PANE_KEY_STEP_LARGE : PANE_KEY_STEP;
    const base = resolveCurrentWidth();
    const stepFor = (direction: "left" | "right"): number =>
      (side === "left" ? 1 : -1) * (direction === "right" ? step : -step);

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        commit(applyLimit(base + stepFor(event.key === "ArrowRight" ? "right" : "left")));
        break;
      }
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        commit(applyLimit(base + (event.key === "ArrowDown" ? step : -step)));
        break;
      }
      case "Home": {
        event.preventDefault();
        commit(applyLimit(optionsRef.current.minWidth));
        break;
      }
      case "End": {
        event.preventDefault();
        commit(applyLimit(optionsRef.current.maxWidth));
        break;
      }
      case "Enter":
      case " ": {
        event.preventDefault();
        reset();
        break;
      }
      default:
        break;
    }
  }, [applyLimit, commit, reset, resolveCurrentWidth, side]);

  return {
    width: effectiveWidth,
    preferredWidth: width,
    minWidth,
    maxWidth,
    limit: computeLimit(),
    dragging,
    reset,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishDrag,
      onPointerCancel: cancelDrag,
      onLostPointerCapture: cancelDrag,
      onKeyDown,
      onDoubleClick: reset,
    },
  };
}
