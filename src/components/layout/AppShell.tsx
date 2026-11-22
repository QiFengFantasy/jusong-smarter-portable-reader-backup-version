import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { BookOpen, LibraryBig } from "lucide-react";

import { cn } from "../../lib/utils";

export interface CurrentBook {
  id: string;
  title: string;
}

interface AppShellProps {
  children: ReactNode;
  /** 阅读器传入当前书，导航里出现「当前书」入口。 */
  currentBook?: CurrentBook | null;
  /** 阅读器需要占满视口、内部独立滚动。 */
  fullHeight?: boolean;
  /** 阅读器隐藏全站顶栏，交互按钮由阅读器自己的次顶部栏承担。 */
  hideHeader?: boolean;
}

const navBase =
  "flex items-center gap-1.5 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/70 hover:text-ink";

export function AppShell({
  children,
  currentBook = null,
  fullHeight = false,
  hideHeader = false,
}: AppShellProps) {
  return (
    <div className={cn("flex flex-col bg-paper text-ink", fullHeight ? "h-screen overflow-hidden" : "min-h-screen")}>
      {hideHeader ? null : (
      <header className="z-40 shrink-0 border-b border-border/80 bg-paper/90 backdrop-blur supports-[backdrop-filter]:bg-paper/75">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-3 sm:gap-3 sm:px-6">
          <Link
            to="/"
            className="group flex shrink-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40"
            aria-label="沮诵 · 书架"
          >
            <img
              src="/app-icon.png"
              alt=""
              draggable={false}
              className="h-9 w-9 shrink-0 select-none transition-transform group-hover:-rotate-3"
            />
            <span className="flex flex-col leading-none">
              <span className="font-serif text-lg font-semibold tracking-[0.22em]">沮诵</span>
              <span className="mt-1 hidden text-[9px] uppercase tracking-[0.38em] text-ink-soft/60 sm:block">
                JUSONG
              </span>
            </span>
          </Link>

          <nav className="ml-auto flex min-w-0 items-center gap-0.5 text-ink-soft sm:gap-1">
            <NavLink
              to="/"
              end
              aria-label="书架"
              className={({ isActive }) => cn(navBase, isActive && "bg-muted/80 text-ink")}
            >
              <LibraryBig className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">书架</span>
            </NavLink>
            {currentBook ? (
              <NavLink
                to={`/read/${currentBook.id}`}
                title={currentBook.title}
                aria-label={`当前书：${currentBook.title}`}
                className={({ isActive }) =>
                  cn(navBase, "min-w-0", isActive && "bg-muted/80 text-ink")
                }
              >
                <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="hidden max-w-[6rem] truncate sm:inline md:max-w-[12rem]">
                  {currentBook.title}
                </span>
              </NavLink>
            ) : null}
          </nav>
        </div>
      </header>
      )}

      <main className={cn("flex-1", fullHeight && "flex min-h-0 flex-col")}>{children}</main>

      {!fullHeight ? (
        <footer className="border-t border-border/60 px-4 py-6 text-center text-xs leading-6 text-ink-soft/70">
          沮诵 · 本地优先。书与笔记留在你的设备上。
        </footer>
      ) : null}
    </div>
  );
}
