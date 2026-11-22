import { ChevronRight } from "lucide-react";

import { HOME_PARENTS, type HomeParentId } from "../../lib/home-nav";
import { cn } from "../../lib/utils";

export interface HomeEntryPanelProps {
  activeParent: HomeParentId;
  onSelectParent: (parent: HomeParentId) => void;
}

const ITEM_BASE =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30";

/**
 * 左面板「入口」内容：主分组（首页 / 涌现 / 导入 / 导出 / 指引）+ 置底分组（关于 / 设置）。
 *
 * 分割线只出现在两处：面板栏头下方（由 HomePage 的栏头提供）与置底分组上方；
 * 主分组各入口之间不画线，保持纸面干净。
 */
export function HomeEntryPanel({ activeParent, onSelectParent }: HomeEntryPanelProps) {
  const mainParents = HOME_PARENTS.filter((parent) => parent.group === "main");
  const bottomParents = HOME_PARENTS.filter((parent) => parent.group === "bottom");

  const renderItem = (parentId: HomeParentId) => {
    const parent = HOME_PARENTS.find((item) => item.id === parentId);
    if (!parent) return null;
    const Icon = parent.icon;
    const active = parent.id === activeParent;
    const hasChildren = parent.children.length > 0;
    return (
      <button
        key={parent.id}
        type="button"
        onClick={() => onSelectParent(parent.id)}
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
        <span className="min-w-0 flex-1 truncate">{parent.label}</span>
        {hasChildren ? (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              active ? "text-paper-soft/60" : "text-ink-soft/40",
            )}
            aria-hidden="true"
          />
        ) : null}
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="首页入口" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {mainParents.map((parent) => renderItem(parent.id))}
      </nav>
      <div className="space-y-0.5 border-t border-border/60 p-2">{bottomParents.map((parent) => renderItem(parent.id))}</div>
    </div>
  );
}
