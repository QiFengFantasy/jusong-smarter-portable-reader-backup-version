import { MoreHorizontal } from "lucide-react";
import { Link } from "react-router-dom";

import { BrandMark } from "../brand/BrandMark";
import { Button } from "../ui/button";

export interface HomeTopBarProps {
  /** 入口面板是否处于收起状态（收起时在中间顶栏显示 ⋯ 展开按钮）。 */
  leftCollapsed: boolean;
  /** 导览面板是否处于收起状态（收起时在中间顶栏显示 ⋯ 展开按钮）。 */
  rightCollapsed: boolean;
  onExpandLeft: () => void;
  onExpandRight: () => void;
}

/**
 * 首页中间列顶栏（56px）：只在中间列顶部，左右面板各自从窗口顶部开始。
 *
 * 面板展开时，收起操作在各自的面板栏头（关闭图标）；这里只负责在面板收起时
 * 提供「⋯」展开按钮，避免顶栏出现两组并排的关闭/展开图标。
 */
export function HomeTopBar({ leftCollapsed, rightCollapsed, onExpandLeft, onExpandRight }: HomeTopBarProps) {
  return (
    <header
      data-home-toolbar="top"
      className="relative flex h-14 shrink-0 items-center justify-center border-b border-border/80 bg-paper/90 px-2 backdrop-blur supports-[backdrop-filter]:bg-paper/75"
    >
      {leftCollapsed ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onExpandLeft}
          aria-label="展开入口面板"
          title="展开入口面板"
          className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-soft hover:text-ink"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      ) : null}

      <Link
        to="/"
        aria-label="沮诵 · 首页"
        className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40"
      >
        <BrandMark size="sm" showSubtitle={false} />
      </Link>

      {rightCollapsed ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onExpandRight}
          aria-label="展开导览面板"
          title="展开导览面板"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-soft hover:text-ink"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      ) : null}
    </header>
  );
}
