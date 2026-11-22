import type { LucideIcon } from "lucide-react";

import {
  HOME_FIXED_GUIDES,
  type HomeFixedGuide,
  type HomeFixedGuideId,
  type HomeNavChild,
  type HomeNavParent,
  type HomeSelection,
} from "../../lib/home-nav";
import { cn } from "../../lib/utils";

export interface HomeGuidePanelProps {
  /** 当前左入口（决定子项列表）。 */
  parent: HomeNavParent;
  selection: HomeSelection;
  onSelectChild: (child: HomeNavChild) => void;
  onOpenFixed: (fixed: HomeFixedGuideId) => void;
}

const ITEM_BASE =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30";

function GuideItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon?: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        ITEM_BASE,
        active
          ? "bg-cinnabar text-paper-soft shadow-sm"
          : "text-ink-soft hover:bg-muted/70 hover:text-ink",
      )}
    >
      {Icon ? (
        <Icon
          className={cn("h-4 w-4 shrink-0", active ? "text-paper-soft/90" : "text-ink-soft/80")}
          aria-hidden="true"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function fixedGuide(id: HomeFixedGuideId): HomeFixedGuide {
  const guide = HOME_FIXED_GUIDES.find((item) => item.id === id);
  if (!guide) throw new Error(`未知的首页常驻项：${id}`);
  return guide;
}

/**
 * 右面板「导览」内容：当前入口的子项 + 两个常驻项。
 *
 * - 顶部常驻「检索」，与子项列表之间有一条分割线；
 * - 底部常驻「AGENT」，上方有一条分割线；
 * - 切换左入口时这两个常驻项始终可见；打开它们不改变左入口选中。
 *
 * 入口没有子项（涌现 / 指引）时，中间在子项区域显示一句说明。
 */
export function HomeGuidePanel({ parent, selection, onSelectChild, onOpenFixed }: HomeGuidePanelProps) {
  const topFixed = fixedGuide("search");
  const bottomFixed = fixedGuide("agent");
  const fixedActive = selection.fixed;
  const childActive = (childId: string) => fixedActive === null && selection.child === childId;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 p-2">
        <GuideItem
          icon={topFixed.icon}
          label={topFixed.label}
          active={fixedActive === topFixed.id}
          onClick={() => onOpenFixed(topFixed.id)}
        />
        <div className="mx-2 mt-2 border-t border-border/60" role="presentation" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {parent.children.length > 0 ? (
          <div className="space-y-0.5">
            {parent.children.map((child) => (
              <GuideItem
                key={child.id}
                icon={child.icon}
                label={child.label}
                active={childActive(child.id)}
                onClick={() => onSelectChild(child)}
              />
            ))}
          </div>
        ) : (
          <p className="mx-1 rounded-md border border-dashed border-border/70 bg-paper/50 px-2.5 py-2 text-[11px] leading-5 text-ink-soft/80">
            「{parent.label}」没有子项，内容直接显示在中间。
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-border/60 p-2">
        <GuideItem
          icon={bottomFixed.icon}
          label={bottomFixed.label}
          active={fixedActive === bottomFixed.id}
          onClick={() => onOpenFixed(bottomFixed.id)}
        />
      </div>
    </div>
  );
}
