import { useCallback, useLayoutEffect, useState } from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { MoreVertical, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/** 顶栏 icon 按钮边长：Button size="icon" = h-9 w-9 = 36px。 */
export const TOOLBAR_ICON_BUTTON_SIZE = 36;
/** 一组按钮内相邻按钮间距：gap-0.5 = 2px。 */
export const TOOLBAR_ITEM_GAP = 2;
/**
 * 按钮组与居中标题之间的安全余量（左右两侧合计，px）。
 * 实际每侧至少留出该值的一半空隙，避免组边缘紧贴标题。
 */
export const TOOLBAR_TITLE_SAFETY_MARGIN = 16;

/**
 * 按「固定项数 × 36px + 间距」估算一组按钮全量展开时的自然宽度。
 * 不测量折叠后的 DOM：折叠状态因此不会反过来影响宽度估算，不会抖动。
 */
export function toolbarGroupWidth(itemCount: number): number {
  if (itemCount <= 0) return 0;
  return itemCount * TOOLBAR_ICON_BUTTON_SIZE + (itemCount - 1) * TOOLBAR_ITEM_GAP;
}

/** 顶栏按钮描述：全量按钮与 ⋮ 菜单项共用同一份定义，避免两处行为分叉。 */
export interface ToolbarOverflowItem {
  /** 稳定 key。 */
  key: string;
  /** 菜单里的中文标签。 */
  label: string;
  /** 图标组件。 */
  icon: LucideIcon;
  /** 全量按钮的 aria-label；缺省用 label。 */
  ariaLabel?: string;
  /** 全量按钮的 title；缺省不加 title。 */
  title?: string;
  /** 不可用状态（如没有上一章）。 */
  disabled?: boolean;
  /** 普通按钮的点击动作；与 to 二选一。 */
  onSelect?: () => void;
  /** 路由链接（书架 / 设置）；与 onSelect 二选一。 */
  to?: string;
}

export interface ToolbarOverflowState {
  left: boolean;
  right: boolean;
}

export interface ToolbarOverflowController extends ToolbarOverflowState {
  /** 挂到顶栏容器上；元素真正挂载后开始测量。 */
  toolbarRef: (node: HTMLDivElement | null) => void;
  /** 挂到居中标题上；标题宽度变化时重算。 */
  titleRef: (node: HTMLElement | null) => void;
}

/**
 * 监听顶栏与标题尺寸，分别判断左右按钮组是否该折叠成 ⋮。
 *
 * 判定：顶栏内容宽 W = clientWidth - 左右内边距，标题宽 T；
 * 每组可用半宽 = (W - T - 安全余量) / 2。
 * 某组全量自然宽度 > 半宽 → 该组折叠；两组各自独立判定。
 *
 * 用 callback ref 持有节点：阅读器初始化 / 错误 / 找不到书时顶栏还没挂载，
 * 等它真正出现在 DOM 里后再开始观察，避免错过首帧测量。
 */
export function useToolbarOverflow(
  leftItemCount: number,
  rightItemCount: number,
): ToolbarOverflowController {
  const [state, setState] = useState<ToolbarOverflowState>({ left: false, right: false });
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [title, setTitle] = useState<HTMLElement | null>(null);
  const toolbarRef = useCallback((node: HTMLDivElement | null) => setToolbar(node), []);
  const titleRef = useCallback((node: HTMLElement | null) => setTitle(node), []);

  const measure = useCallback(() => {
    if (!toolbar || !title) return;
    if (toolbar.clientWidth <= 0) return;

    const style = window.getComputedStyle(toolbar);
    const horizontalPadding =
      (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const innerWidth = toolbar.clientWidth - horizontalPadding;
    const titleWidth = title.getBoundingClientRect().width;

    // 标题绝对居中：左右两侧各能用到 (innerWidth - titleWidth) / 2。
    const halfWidth = (innerWidth - titleWidth - TOOLBAR_TITLE_SAFETY_MARGIN) / 2;
    const next: ToolbarOverflowState = {
      left: toolbarGroupWidth(leftItemCount) > halfWidth,
      right: toolbarGroupWidth(rightItemCount) > halfWidth,
    };

    setState((previous) =>
      previous.left === next.left && previous.right === next.right ? previous : next,
    );
  }, [leftItemCount, rightItemCount, title, toolbar]);

  useLayoutEffect(() => {
    if (!toolbar || !title) return;
    measure();

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    observer?.observe(toolbar);
    observer?.observe(title);

    // 字体异步加载会改变标题宽度，ResizeObserver 之外的兜底重算。
    const fonts = typeof document === "undefined" ? null : document.fonts;
    if (fonts) {
      void fonts.ready.then(() => measure()).catch(() => undefined);
      fonts.addEventListener("loadingdone", measure);
    }

    return () => {
      observer?.disconnect();
      fonts?.removeEventListener("loadingdone", measure);
    };
  }, [measure, title, toolbar]);

  return { ...state, toolbarRef, titleRef };
}

function ToolbarItemButton({ item }: { item: ToolbarOverflowItem }) {
  const Icon = item.icon;
  if (item.to) {
    return (
      <Button asChild variant="ghost" size="icon">
        <Link to={item.to} aria-label={item.ariaLabel ?? item.label} title={item.title}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </Link>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={item.disabled}
      onClick={item.onSelect}
      aria-label={item.ariaLabel ?? item.label}
      title={item.title}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </Button>
  );
}

const menuItemClassName =
  "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-ink outline-none transition-colors focus:bg-muted/70 data-[highlighted]:bg-muted/70 data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

function ToolbarMenuItemContent({ item }: { item: ToolbarOverflowItem }) {
  const Icon = item.icon;
  return (
    <>
      <Icon className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </>
  );
}

/** 折叠后的 ⋮ 按钮：竖排菜单，项目与该组全量按钮一致。 */
function ToolbarOverflowMenu({
  side,
  items,
}: {
  side: "left" | "right";
  items: ToolbarOverflowItem[];
}) {
  const triggerLabel = side === "left" ? "更多左侧操作" : "更多右侧操作";
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={triggerLabel} title={triggerLabel}>
          <MoreVertical className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          data-toolbar-overflow-menu={side}
          side="bottom"
          align={side === "left" ? "start" : "end"}
          sideOffset={6}
          aria-label={side === "left" ? "左侧操作菜单" : "右侧操作菜单"}
          className="z-50 min-w-[10rem] overflow-hidden rounded-md border border-border bg-paper p-1 text-ink shadow-paper"
        >
          {items.map((item) =>
            item.to ? (
              <DropdownMenuPrimitive.Item key={item.key} asChild className={menuItemClassName}>
                <Link to={item.to}>
                  <ToolbarMenuItemContent item={item} />
                </Link>
              </DropdownMenuPrimitive.Item>
            ) : (
              <DropdownMenuPrimitive.Item
                key={item.key}
                className={menuItemClassName}
                disabled={item.disabled}
                onSelect={() => item.onSelect?.()}
              >
                <ToolbarMenuItemContent item={item} />
              </DropdownMenuPrimitive.Item>
            ),
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export interface ToolbarOverflowProps {
  side: "left" | "right";
  /** 该组是否折叠为 ⋮ 按钮（由 useToolbarOverflow 判定）。 */
  collapsed: boolean;
  items: ToolbarOverflowItem[];
  className?: string;
}

/**
 * 顶栏一侧的按钮组：空间足够时全量显示，否则折叠成一个等宽的 ⋮ 按钮。
 * 两种形态下按钮组本身始终占 36px 或自然宽度，不压居中标题。
 */
export function ToolbarOverflow({ side, collapsed, items, className }: ToolbarOverflowProps) {
  return (
    <div
      data-toolbar-group={side}
      data-toolbar-collapsed={collapsed ? "true" : "false"}
      className={cn("flex shrink-0 items-center gap-0.5", className)}
    >
      {collapsed ? (
        <ToolbarOverflowMenu side={side} items={items} />
      ) : (
        items.map((item) => <ToolbarItemButton key={item.key} item={item} />)
      )}
    </div>
  );
}
