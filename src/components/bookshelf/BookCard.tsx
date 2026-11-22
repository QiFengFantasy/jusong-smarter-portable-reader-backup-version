import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import type { BookMeta } from "@jusong/core";
import { Download } from "lucide-react";

import { cn, formatDate } from "../../lib/utils";
import { BookCover } from "./BookCover";

/** 移动端长按触发菜单的时长（契约：500ms）。 */
const LONG_PRESS_MS = 500;
/** 长按判定后，移动超过该距离视为滚动，取消长按。 */
const LONG_PRESS_MOVE_TOLERANCE = 10;
const MENU_WIDTH = 176;
const MENU_HEIGHT = 76;

interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * 书架书卡。
 *
 * - 点击卡片 → 继续阅读（Link）。
 * - 桌面右键 / 键盘 Shift+F10 → 卡片菜单；移动端长按 500ms → 同一菜单。
 * - 菜单目前只有「导出书籍」，导航到 `/export/:bookId`（路由由 lead 接入）。
 *
 * 菜单用 Portal 渲染到 `document.body`，避免按钮嵌套在 `<a>` 里触发导航。
 */
export function BookCard({ book }: { book: BookMeta }) {
  const isSeed = book.format === "seed" || book.id === "maoxuan";
  const navigate = useNavigate();

  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  /** 长按已触发菜单：随后的 click 要吞掉，避免同时跳去阅读器。 */
  const longPressTriggeredRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    pressOriginRef.current = null;
  }, []);

  const openMenuAt = useCallback((x: number, y: number) => {
    const maxX = Math.max(8, window.innerWidth - MENU_WIDTH - 8);
    const maxY = Math.max(8, window.innerHeight - MENU_HEIGHT - 8);
    setMenu({
      x: Math.min(Math.max(8, x), maxX),
      y: Math.min(Math.max(8, y), maxY),
    });
  }, []);

  // 菜单打开后：点击外部 / Escape / 滚动 / 窗口尺寸变化都关闭。
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      linkRef.current?.focus();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // 组件卸载时清掉未触发的长按计时器。
  useEffect(() => clearLongPress, [clearLongPress]);

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    clearLongPress();
    openMenuAt(event.clientX, event.clientY);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 任何一次新按下都重置「长按已触发」，避免混合设备上吞掉下一次正常点击。
    longPressTriggeredRef.current = false;
    // 桌面右键交给 contextmenu；鼠标左键按住不开菜单。
    if (event.pointerType === "mouse") return;
    if (menu) return;
    const { clientX, clientY } = event;
    pressOriginRef.current = { x: clientX, y: clientY };
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      longPressTriggeredRef.current = true;
      openMenuAt(clientX, clientY);
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = pressOriginRef.current;
    if (!origin) return;
    const distance = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
    if (distance > LONG_PRESS_MOVE_TOLERANCE) clearLongPress();
  };

  /** 长按/右键打开菜单后，吞掉随后的 click，避免误跳阅读器。 */
  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!longPressTriggeredRef.current) return;
    longPressTriggeredRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenuAt(rect.left + Math.min(rect.width / 2, 120), rect.top + 40);
  };

  const openExportPage = () => {
    setMenu(null);
    navigate(`/export/${book.id}`);
  };

  return (
    <>
      <div
        ref={wrapperRef}
        className="relative h-full select-none"
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onPointerLeave={clearLongPress}
        onClickCapture={handleClickCapture}
      >
        <Link
          ref={linkRef}
          to={`/read/${book.id}`}
          onKeyDown={handleKeyDown}
          className="group flex h-full gap-4 rounded-lg border border-border bg-paper-soft/70 p-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-cinnabar/40 hover:shadow-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper sm:p-4"
        >
          <BookCover book={book} />

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "rounded-sm border px-1.5 py-0.5 text-[10px] tracking-wider",
                  isSeed
                    ? "border-cinnabar/30 bg-cinnabar/10 text-cinnabar"
                    : "border-border bg-muted/60 text-ink-soft",
                )}
              >
                {isSeed ? "种子书" : book.format.toUpperCase()}
              </span>
              {book.author ? (
                <span className="truncate text-[11px] text-ink-soft/80">{book.author}</span>
              ) : null}
              {book.publisher ? (
                <span className="truncate text-[11px] text-ink-soft/60">{book.publisher}</span>
              ) : null}
            </div>

            <h3 className="mt-1.5 line-clamp-2 font-serif text-[17px] font-semibold leading-snug tracking-wide transition-colors group-hover:text-cinnabar">
              {book.title}
            </h3>

            {book.description ? (
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-soft">{book.description}</p>
            ) : null}

            <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-[11px] text-ink-soft/80">
              {book.volumeCount > 0 ? (
                <>
                  <span>{book.volumeCount} 卷</span>
                  <span className="h-3 w-px bg-border" aria-hidden="true" />
                </>
              ) : null}
              <span>{book.chapterCount} 篇</span>
              {book.importedAt ? (
                <>
                  <span className="h-3 w-px bg-border" aria-hidden="true" />
                  <span>{formatDate(book.importedAt)}</span>
                </>
              ) : null}
            </div>
          </div>
        </Link>
      </div>

      {menu
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={`《${book.title}》操作`}
              style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 120 }}
              className="w-44 overflow-hidden rounded-lg border border-border bg-paper p-1 shadow-paper"
            >
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={openExportPage}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-ink transition-colors hover:bg-cinnabar/[0.08] hover:text-cinnabar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                导出书籍
              </button>
              <p className="px-3 pb-1.5 pt-1 text-[10px] leading-4 text-ink-soft/60">
                原文件与加密解析包
              </p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
