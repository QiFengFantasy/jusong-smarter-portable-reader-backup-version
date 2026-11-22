import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "../../lib/utils";
import "./reader-panels.css";

export interface PanelDrawerProps {
  side: "left" | "right";
  /** 面板名，如「知识面板」「探索面板」。 */
  title: string;
  /** 副标题（书名/章节名）。 */
  subtitle?: string;
  /** 面板宽度（px）。 */
  width: number;
  /** 关闭按钮的 aria-label。 */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 窄屏「覆盖式浮层」面板（阅读器设置 readerPanelMode = "drawer"，默认）。
 *
 * - 从对应侧边滑出，覆盖正文上方，不改变正文宽度；
 * - 半透明遮罩：点击关闭；Esc 关闭；关闭后焦点回到打开前的元素；
 * - 面板本身是 modal dialog（aria-modal），内部复用知识/探索面板的标签栏与内容。
 */
export function PanelDrawer({
  side,
  title,
  subtitle,
  width,
  closeLabel,
  onClose,
  children,
}: PanelDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // 面板里的下拉菜单/弹层先自己处理 Esc，不要连抽屉一起关掉。
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[role=menu],[data-radix-popper-content-wrapper]")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      data-reader-drawer={side}
      className={cn("fixed inset-0 z-50 flex", side === "left" ? "justify-start" : "justify-end")}
    >
      <div
        className="reader-drawer-mask absolute inset-0 bg-ink/35 backdrop-blur-[2px]"
        aria-hidden="true"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-side={side}
        style={{ width }}
        className={cn(
          "reader-drawer-panel relative flex h-full max-h-full min-h-0 flex-col bg-paper shadow-paper",
          side === "left" ? "border-r border-border/70" : "border-l border-border/70",
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          <div className="min-w-0 flex-1">
            <p className="font-serif text-sm font-semibold tracking-[0.28em] text-ink-soft">{title}</p>
            {subtitle ? (
              <p className="mt-0.5 truncate text-[11px] text-ink-soft/70">{subtitle}</p>
            ) : null}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-muted/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </aside>
    </div>
  );
}
