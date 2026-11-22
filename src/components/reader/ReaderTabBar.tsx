import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import "./reader-panels.css";

export interface ReaderTabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
}

/** 标签栏两侧为悬浮滚动箭头预留的宽度（px，与箭头宽度一致）。 */
const TAB_SCROLL_GUTTER = 24;

/** 滚轮换算：deltaMode 为「行/页」时转成像素，鼠标滚轮才能平滑横向移动。 */
function wheelPixelDelta(event: WheelEvent, node: HTMLElement): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * node.clientHeight;
  return event.deltaY;
}

interface ReaderTabBarProps<T extends string> {
  /** 面板名（栏头 aria），如「知识面板」「探索面板」。 */
  ariaLabel: string;
  tabs: ReadonlyArray<ReaderTabItem<T>>;
  active: T;
  onChange: (id: T) => void;
  /** 每个标签的最小宽度（px，来自设置 readerLeftTabMinWidth / readerRightTabMinWidth）。 */
  minTabWidth: number;
  /** 与旧实现一致的 data-reader-toolbar 标记（left / right），供布局测量与调试。 */
  toolbarSide: "left" | "right";
  className?: string;
}

interface OverflowState {
  left: boolean;
  right: boolean;
}

const NO_OVERFLOW: OverflowState = { left: false, right: false };

/**
 * 阅读器面板顶部标签栏。
 *
 * - 容器横向滚动 + 隐藏滚动条：标签最小宽度变大或面板变窄时，超出的标签可以左右滑动；
 * - 溢出时在左右两侧显示可点击的 ‹ / › 悬浮箭头（不占布局、无按钮框；渐变遮罩保证可读），
 *   点击滚动约 3/4 屏；内容容器两侧常驻预留箭头宽度，箭头出现/消失不会让标签跳动；
 * - 电脑端鼠标滚轮在标签栏上时转成横向滚动（触控板 deltaX 保留原生手势；
 *   到两端后不再拦截，页面滚动不受影响）；
 * - 键盘：标签本身可 Tab 到达，方向键 / Home / End 在标签间切换选中并自动滚入视野；
 * - 选中态与旧实现一致（朱红底），不改变面板宽度计算。
 */
export function ReaderTabBar<T extends string>({
  ariaLabel,
  tabs,
  active,
  onChange,
  minTabWidth,
  toolbarSide,
  className,
}: ReaderTabBarProps<T>) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<T, HTMLButtonElement>());
  const [overflow, setOverflow] = useState<OverflowState>(NO_OVERFLOW);

  const syncOverflow = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const maxScroll = node.scrollWidth - node.clientWidth;
    setOverflow((previous) => {
      const next: OverflowState = {
        left: node.scrollLeft > 1,
        right: maxScroll > 1 && node.scrollLeft < maxScroll - 1,
      };
      return previous.left === next.left && previous.right === next.right ? previous : next;
    });
  }, []);

  // 监听滚动与尺寸变化（面板宽度拖拽、窗口缩放、标签数量/最小宽度变化）。
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    syncOverflow();
    node.addEventListener("scroll", syncOverflow, { passive: true });

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncOverflow);
    observer?.observe(node);

    return () => {
      node.removeEventListener("scroll", syncOverflow);
      observer?.disconnect();
    };
  }, [syncOverflow, tabs.length, minTabWidth]);

  // 电脑端鼠标滚轮 → 标签栏横向滚动。
  // - 触控板横向手势（deltaX 为主）保留原生滚动，不拦截；
  // - 只在标签确实可滚、且滚轮方向还有余量时 preventDefault，到两端恢复页面滚动；
  // - 用原生监听（passive: false）才能可靠 preventDefault；React 的 onWheel 在根节点上是 passive 的。
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      // Ctrl/⌘ + 滚轮是缩放：交给浏览器。
      if (event.ctrlKey || event.metaKey) return;
      // 横向手势（触控板左右滑 / Shift+滚轮）：保留原生横向滚动。
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const delta = wheelPixelDelta(event, node);
      if (Math.abs(delta) < 0.5) return;
      const maxScroll = node.scrollWidth - node.clientWidth;
      if (maxScroll <= 1) return;
      // 已经到对应方向的端点：不拦截，让页面/外层继续滚动。
      if (delta < 0 && node.scrollLeft <= 1) return;
      if (delta > 0 && node.scrollLeft >= maxScroll - 1) return;
      event.preventDefault();
      // 标签栏 CSS 带 scroll-behavior: smooth（点击箭头用）；滚轮要即时跟手，临时切成 auto。
      const previousBehavior = node.style.scrollBehavior;
      node.style.scrollBehavior = "auto";
      node.scrollLeft += delta;
      node.style.scrollBehavior = previousBehavior;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  // 选中项变化时滚进视野（程序化切换：注释标号 → 注释、划词引用 → AGENT）。
  // 这里直接写 scrollLeft（即时滚动）：smooth 动画会被随后聚焦标签的默认滚动行为打断。
  useEffect(() => {
    const node = scrollerRef.current;
    const activeNode = tabRefs.current.get(active);
    if (!node || !activeNode) return;
    // 用 rect 差值而不是 offsetLeft：offsetParent 可能是外层的标签栏容器而不是滚动容器。
    const scrollerRect = node.getBoundingClientRect();
    const activeRect = activeNode.getBoundingClientRect();
    const left = activeRect.left - scrollerRect.left + node.scrollLeft;
    const right = left + activeRect.width;
    const viewLeft = node.scrollLeft;
    const viewRight = viewLeft + node.clientWidth - 2;
    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth);
    if (left < viewLeft) {
      node.scrollLeft = Math.max(0, left);
    } else if (right > viewRight) {
      node.scrollLeft = Math.min(maxScroll, right - node.clientWidth + 2);
    }
    const frame = requestAnimationFrame(syncOverflow);
    return () => cancelAnimationFrame(frame);
  }, [active, syncOverflow]);

  const scrollStep = useCallback((direction: -1 | 1) => {
    const node = scrollerRef.current;
    if (!node) return;
    const step = Math.max(80, Math.round(node.clientWidth * 0.75));
    node.scrollBy({ left: direction * step, behavior: "smooth" });
    requestAnimationFrame(syncOverflow);
  }, [syncOverflow]);

  const focusTab = useCallback((id: T) => {
    // preventScroll：避免聚焦把滚动位置重置，滚动位置由上面的选中项 effect 统一负责。
    tabRefs.current.get(id)?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const index = tabs.findIndex((tab) => tab.id === active);
      let nextIndex = index;
      if (event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
      else if (event.key === "ArrowRight") nextIndex = Math.min(tabs.length - 1, index + 1);
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      if (!nextTab) return;
      onChange(nextTab.id);
      requestAnimationFrame(() => focusTab(nextTab.id));
    },
    [active, focusTab, onChange, tabs],
  );

  return (
    <div
      data-reader-toolbar={toolbarSide}
      data-reader-tabbar={toolbarSide}
      className={cn(
        "relative flex h-14 shrink-0 items-center border-b border-border/70",
        className,
      )}
    >
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        // 两侧常驻预留箭头宽度：无论箭头是否出现，标签起点/终点都不变（避免出现时内容跳动）。
        style={{ paddingLeft: TAB_SCROLL_GUTTER, paddingRight: TAB_SCROLL_GUTTER }}
        className="reader-tab-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1"
      >
        {tabs.map(({ id, label, icon: Icon }) => {
          const selected = active === id;
          return (
            <button
              key={id}
              ref={(node) => {
                if (node) tabRefs.current.set(id, node);
                else tabRefs.current.delete(id);
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              data-reader-tab={id}
              onClick={() => onChange(id)}
              style={{ minWidth: minTabWidth }}
              className={cn(
                "inline-flex flex-1 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-[10.5px] transition-colors",
                selected
                  ? "bg-cinnabar text-paper-soft shadow-sm"
                  : "text-ink-soft hover:bg-muted/70 hover:text-ink",
              )}
            >
              {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden="true" /> : null}
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>

      {overflow.left ? (
        <button
          type="button"
          aria-label={`向左滚动${ariaLabel}标签`}
          title="向左查看更多标签"
          onClick={() => scrollStep(-1)}
          data-reader-tab-scroll="left"
          // 悬浮箭头：无边框/背景/圆角盒子感，只有左侧渐变遮罩让滑过的标签渐隐，保证箭头可读。
          className="absolute inset-y-0 left-0 z-10 flex w-6 items-center justify-start bg-gradient-to-r from-paper-soft via-paper-soft/85 to-transparent pl-1 text-ink-soft transition-colors hover:text-cinnabar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cinnabar/40"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}

      {overflow.right ? (
        <button
          type="button"
          aria-label={`向右滚动${ariaLabel}标签`}
          title="向右查看更多标签"
          onClick={() => scrollStep(1)}
          data-reader-tab-scroll="right"
          className="absolute inset-y-0 right-0 z-10 flex w-6 items-center justify-end bg-gradient-to-l from-paper-soft via-paper-soft/85 to-transparent pr-1 text-ink-soft transition-colors hover:text-cinnabar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cinnabar/40"
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
