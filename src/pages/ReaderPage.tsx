import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  BookmarkPlus,
  LibraryBig,
  MessageSquareQuote,
  MoreHorizontal,
  Settings2,
  Sparkle,
  X,
} from "lucide-react";
import type {
  Bookmark,
  BookmarkInput,
  BookmarkOrder,
  BookmarkPanels,
  BookMeta,
  Chapter,
  TocNode,
} from "@jusong/core";

import { AppShell } from "../components/layout/AppShell";
import { BrandMark } from "../components/brand/BrandMark";
import { HeroArt } from "../components/brand/HeroArt";
import { PaneResizer } from "../components/layout/PaneResizer";
import {
  ToolbarOverflow,
  useToolbarOverflow,
  type ToolbarOverflowItem,
} from "../components/layout/ToolbarOverflow";
import { ChapterView } from "../components/reader/ChapterView";
import { PanelDrawer } from "../components/reader/PanelDrawer";
import { useBookmarks } from "../components/reader/useBookmarks";
import type { BookmarkNotice, BookmarkPanelBindings } from "../components/reader/BookmarkPanel";
import { useReaderViewportWidth } from "../components/reader/useReaderViewport";
import {
  isAndroidReader,
  useReaderBackGuard,
  useReaderGestures,
} from "../components/reader/useReaderGestures";
import { ReaderEdgeNav } from "../components/reader/ReaderEdgeNav";
import { ReaderFloatingActions } from "../components/reader/ReaderFloatingActions";
import { ExtensionPanel } from "../extensions/ExtensionPanel";
import type { AgentQuote, ExtensionTab, ExtensionTabRequest } from "../extensions/ExtensionPanel";
import { LeftRail, type LeftTab } from "../components/reader/LeftRail";
import { ReaderSettingsPanel } from "../components/reader/ReaderSettingsPanel";
import { ErrorPanel, LoadingPanel } from "../components/feedback";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { useLibrary } from "../lib/library";
import { warmKnowledgeBook } from "../lib/knowledge-cache";
import { readArticleSelection as readArticleSelectionFromDom } from "../lib/bookmark-highlight";
import type { BookmarkJumpHighlight } from "../lib/bookmark-highlight";
import { chapterNotes, findNoteMarkerBlock } from "../lib/notes";
import {
  defaultRightPaneWidth,
  isReaderPaneVisible,
  narrowDrawerWidth,
  narrowInlinePaneWidth,
  READER_INLINE_LAYOUT_BREAKPOINT,
  READER_LEFT_PANE,
  READER_PANE_BUTTON_LABELS,
  READER_PANE_TITLES,
  READER_RIGHT_PANE,
  resolveReaderPaneLayout,
} from "../lib/paneResize";
import { effectiveNoteDisplayMode, useSettings } from "../lib/settings";
import { findChapterTrail, flattenChapters } from "../lib/toc";
import { usePaneWidth } from "../lib/usePaneWidth";
import { cn, getErrorMessage } from "../lib/utils";
import type { ChapterNote } from "../lib/notes";

/** 窄屏（< 内联断点）时展开的是哪一侧的面板；drawer/dialog/inline 三种模式共用。 */
type NarrowPanel = "left" | "right" | null;

/** 等待恢复的阅读现场：章节内容渲染完成后再滚动，跨章/同章共用同一条恢复流程。 */
interface PendingBookmarkJump {
  /** 每次跳转递增：同一个书签重复点击也能重新触发恢复流程。 */
  token: number;
  chapterId: string;
  /** 章节内滚动位置（页面级书签的唯一位置依据；文字书签的兜底）。 */
  scrollTop: number;
  /** 文字书签的正文块 id：优先滚到该块并高亮。 */
  blockId?: string;
  /** 文字书签的选中文字/偏移：跳转时只高亮这段文字，不再整段高亮。 */
  quote?: string;
  quoteStart?: number;
  quoteEnd?: number;
}

/** 跳转书签时短暂高亮的精确文字范围（2.5s 后清除；旧书签无偏移时按 quote 首次出现）。 */
type PendingJumpHighlight = BookmarkJumpHighlight;

/** 滚动恢复：内容异步撑开高度时短暂重试（与首页滚动记忆同参数）。 */
const SCROLL_RESTORE_MAX_ATTEMPTS = 40;
const SCROLL_RESTORE_RETRY_MS = 100;
/** 轻提示 / 新增项高亮的持续时间。 */
const BOOKMARK_NOTICE_MS = 2600;

const LEFT_TABS: readonly LeftTab[] = ["toc", "summary", "notes", "knowledge", "bookmarks"];
const RIGHT_TABS: readonly ExtensionTab[] = ["map", "timeline", "other", "agent"];

/** 书签里记录的 leftTab（string）在恢复时收窄到当前阅读器支持的标签；未知值退回目录。 */
function normalizeLeftTab(value: unknown): LeftTab {
  return typeof value === "string" && (LEFT_TABS as readonly string[]).includes(value)
    ? (value as LeftTab)
    : "toc";
}

/** 书签里记录的 rightTab（string）在恢复时收窄到探索面板支持的标签；未知值退回地图。 */
function normalizeRightTab(value: unknown): ExtensionTab {
  return typeof value === "string" && (RIGHT_TABS as readonly string[]).includes(value)
    ? (value as ExtensionTab)
    : "map";
}

/** 页面级书签的自动标题：「章节名 · 页面位置（百分比）」。 */
function pagePositionLabel(scrollTop: number, viewport: HTMLElement | null): string {
  if (!viewport) return "页面位置";
  const maxScroll = viewport.scrollHeight - viewport.clientHeight;
  if (maxScroll <= 0 || scrollTop <= 4) return "页面顶部";
  const percent = Math.min(99, Math.max(1, Math.round((scrollTop / maxScroll) * 100)));
  return `页面位置 ${percent}%`;
}

/** 文字书签的自动标题：选中文字前约 20 字。 */
function quoteTitle(quote: string): string {
  const clean = quote.replace(/\s+/g, " ").trim();
  if (clean.length <= 20) return clean;
  return `${clean.slice(0, 20)}…`;
}

interface ReaderStatePageProps {
  /** 小号英文/风格化眉题（如 LOCAL LIBRARY）。 */
  eyebrow: string;
  title: string;
  description: ReactNode;
  /** 操作按钮（Link / Button）。 */
  actions?: ReactNode;
  /** 是否展示载入中指示（初始化状态）。 */
  busy?: boolean;
  tone?: "normal" | "error";
}

/**
 * 阅读器整页状态（初始化中 / 书库错误 / 找不到书）。
 *
 * 与第二批新首页同一套纸墨语汇：全高纸面 + 品牌标识 + 居中状态卡；
 * 不使用旧 AppShell 顶栏（书架/设置导航），只保留「返回主界面」入口；
 * 上下留出移动端安全区，窄屏可读。
 */
function ReaderStatePage({
  eyebrow,
  title,
  description,
  actions,
  busy = false,
  tone = "normal",
}: ReaderStatePageProps) {
  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-paper text-ink">
      <HeroArt variant="compact" />

      <div className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))] sm:px-8">
        <div className="mb-7 opacity-95" aria-hidden="true">
          <BrandMark size="md" showSubtitle />
        </div>

        <section
          role={busy ? "status" : tone === "error" ? "alert" : undefined}
          className="w-full max-w-md rounded-xl border border-border bg-paper-soft/80 px-5 py-7 text-center shadow-paper backdrop-blur-sm sm:px-7"
        >
          <p
            className={cn(
              "text-[10px] uppercase tracking-[0.4em]",
              tone === "error" ? "text-cinnabar/85" : "text-ink-soft/60",
            )}
          >
            {eyebrow}
          </p>
          <h1 className="mt-2.5 font-serif text-xl font-semibold tracking-[0.08em] text-ink sm:text-2xl">
            {title}
          </h1>
          <div className="mt-3 break-words text-sm leading-7 text-ink-soft">{description}</div>
          {busy ? <LoadingPanel compact label="正在打开本地书库…" className="pb-0 pt-4" /> : null}
          {actions ? (
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{actions}</div>
          ) : null}
        </section>

        <p className="mt-6 text-center text-[11px] leading-5 tracking-wide text-ink-soft/55">
          沮诵 · 书与笔记留在自己的设备上
        </p>
      </div>
    </div>
  );
}

export function ReaderPage() {
  const { bookId = "", chapterId } = useParams<{ bookId: string; chapterId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { library, status, error: libraryError, retry } = useLibrary();

  const [book, setBook] = useState<BookMeta | null>(null);
  const [toc, setToc] = useState<TocNode[]>([]);
  const [bookLoading, setBookLoading] = useState(true);
  const [bookError, setBookError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [bookAttempt, setBookAttempt] = useState(0);

  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [chapterLoading, setChapterLoading] = useState(true);
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [chapterAttempt, setChapterAttempt] = useState(0);

  // 宽屏：左右面板是否展开（内联三栏）；窄屏：哪一侧面板展开（呈现方式由设置决定）。
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [narrowPanel, setNarrowPanel] = useState<NarrowPanel>(null);
  /** 阅读器内全屏设置覆盖层：不卸载正文，关闭后回到原阅读位置。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 正文划词引用：选中文本 → 右下角悬浮按钮 → 右栏 AGENT。 */
  const [quoteSelection, setQuoteSelection] = useState<{ text: string } | null>(null);
  const [agentQuote, setAgentQuote] = useState<AgentQuote | null>(null);
  /** 程序化切换探索面板标签（划词引用 → AGENT；书签跳转 → 记录的 rightTab）。 */
  const [rightTabRequest, setRightTabRequest] = useState<ExtensionTabRequest | null>(null);
  /** 探索面板当前标签（右栏开关会影响挂载）：创建书签时记录，观察 tab 栏同步。 */
  const rightTabRef = useRef<ExtensionTab>("map");
  /** 书签轻提示 + 新增项高亮（创建、管理操作的结果反馈）。 */
  const [bookmarkNotice, setBookmarkNotice] = useState<BookmarkNotice | null>(null);
  const [bookmarkHighlightId, setBookmarkHighlightId] = useState<string | null>(null);
  const [creatingBookmark, setCreatingBookmark] = useState(false);
  /** 待恢复的书签阅读现场：等正文渲染后恢复滚动 + 块高亮。 */
  const [pendingBookmarkJump, setPendingBookmarkJump] = useState<PendingBookmarkJump | null>(null);
  /** 书签跳转时的精确文字高亮；null 时不高亮。 */
  const [bookmarkJumpHighlight, setBookmarkJumpHighlight] =
    useState<PendingJumpHighlight | null>(null);
  const bookmarkNoticeTimer = useRef<number | null>(null);
  const bookmarkHighlightTimer = useRef<number | null>(null);
  const bookmarkJumpHighlightTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { settings } = useSettings();
  const noteDisplayMode = effectiveNoteDisplayMode(settings);
  const notes = useMemo(() => chapterNotes(chapter), [chapter]);
  const [leftTab, setLeftTab] = useState<LeftTab>("toc");
  const summaryStateConsumed = useRef(false);
  const [activeNoteNumber, setActiveNoteNumber] = useState<number | null>(null);
  const [canJumpBack, setCanJumpBack] = useState(false);
  const jumpBackRef = useRef<{ scrollTop: number } | null>(null);

  const bookmarkStore = useBookmarks(library, bookId);

  // 视口宽度：≥1024 始终内联三栏；更窄时按 settings.readerPanelMode 决定面板呈现方式。
  const viewportWidth = useReaderViewportWidth();
  const isWide = viewportWidth >= READER_INLINE_LAYOUT_BREAKPOINT;
  const panelMode = settings.readerPanelMode;
  const isWideRef = useRef(isWide);
  isWideRef.current = isWide;

  // 左右栏宽度可拖拽：各自独立持久化。
  // 渲染宽度由 resolveReaderPaneLayout 统一分配（正文 ≥460 + 按 paneShrinkPriority 收缩），
  // 宽度状态本身仍保存用户偏好，窗口变窄不会把偏好写死；拖动/键盘微调仍按「另一侧已占 + 正文 460」夹取。
  const renderedWidthsRef = useRef({ left: 0, right: 0 });
  const paneLayoutRef = useRef({ left: 0, right: 0 });
  const leftPane = usePaneWidth({
    ...READER_LEFT_PANE,
    side: "left",
    isVisible: (width) => isReaderPaneVisible("left", width),
    reservedWidth: () => renderedWidthsRef.current.right,
    effectiveWidth: () => paneLayoutRef.current.left,
  });
  const rightPane = usePaneWidth({
    ...READER_RIGHT_PANE,
    side: "right",
    defaultWidth: defaultRightPaneWidth(viewportWidth),
    isVisible: (width) => isReaderPaneVisible("right", width),
    reservedWidth: () => renderedWidthsRef.current.left,
    effectiveWidth: () => paneLayoutRef.current.right,
  });

  // 内联三栏的宽度分配（正文 ≥460；1024/1180 平板两侧都能展开）。
  const paneLayout = resolveReaderPaneLayout({
    viewportWidth,
    left: {
      open: leftOpen,
      preferredWidth: leftPane.preferredWidth,
      minWidth: READER_LEFT_PANE.minWidth,
      maxWidth: READER_LEFT_PANE.maxWidth,
    },
    right: {
      open: rightOpen,
      preferredWidth: rightPane.preferredWidth,
      minWidth: READER_RIGHT_PANE.minWidth,
      maxWidth: READER_RIGHT_PANE.maxWidth,
    },
    shrinkPriority: settings.paneShrinkPriority,
  });
  const wideLeftWidth = isWide && leftOpen ? paneLayout.leftWidth : 0;
  const wideRightWidth = isWide && rightOpen ? paneLayout.rightWidth : 0;
  // 受控宽度回写给 usePaneWidth（拖动起点/键盘微调以实际渲染宽度为准）；
  // 保留一份「上一轮存储偏好」用于首次渲染时存下来的宽度不被覆盖。
  paneLayoutRef.current = { left: wideLeftWidth, right: wideRightWidth };
  renderedWidthsRef.current = { left: wideLeftWidth, right: wideRightWidth };

  const leftPanelVisible = isWide ? leftOpen : narrowPanel === "left";
  const rightPanelVisible = isWide ? rightOpen : narrowPanel === "right";

  const closeNarrowPanel = useCallback(() => setNarrowPanel(null), []);

  // 从窄屏放大回宽屏时收起抽屉/弹窗（避免状态残留导致缩回窄屏又自动展开）。
  useEffect(() => {
    if (isWide) setNarrowPanel(null);
  }, [isWide]);

  // 书签轻提示 / 新增项高亮的定时器：组件卸载时清理。
  useEffect(() => {
    return () => {
      if (bookmarkNoticeTimer.current !== null) window.clearTimeout(bookmarkNoticeTimer.current);
      if (bookmarkHighlightTimer.current !== null) window.clearTimeout(bookmarkHighlightTimer.current);
      if (bookmarkJumpHighlightTimer.current !== null) {
        window.clearTimeout(bookmarkJumpHighlightTimer.current);
      }
    };
  }, []);

  // 记录探索面板当前标签：右栏 tab 由 ExtensionPanel 内部管理（阅读器不改它），
  // 这里在右栏挂载时观察 tab 栏 aria-selected，供创建书签时写入 panels.rightTab。
  useEffect(() => {
    if (!rightPanelVisible) return;
    const tabbar = document.querySelector<HTMLElement>('[data-reader-tabbar="right"]');
    if (!tabbar) return;
    const sync = () => {
      const active = tabbar.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const id = active?.dataset.readerTab;
      if (id === "map" || id === "timeline" || id === "other" || id === "agent") {
        rightTabRef.current = id;
      }
    };
    sync();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(sync);
    observer.observe(tabbar, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
    return () => observer.disconnect();
  }, [rightPanelVisible]);

  useEffect(() => {
    if (!library) return;
    let cancelled = false;
    setBookLoading(true);
    setBookError(null);
    setNotFound(false);
    setBook(null);
    setToc([]);

    Promise.all([library.getBook(bookId), library.getToc(bookId)])
      .then(([meta, nodes]) => {
        if (cancelled) return;
        if (!meta) {
          setNotFound(true);
          return;
        }
        setBook(meta);
        setToc(nodes ?? []);
        // 记录最近阅读（供首页高级检索「最近阅读优先」使用）；失败不影响阅读。
        void library.recordRecentBook(bookId).catch(() => undefined);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setBookError(getErrorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setBookLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [library, bookId, bookAttempt]);

  // 书加载成功后预热该书的知识缓存（知识库/首页统计共用同一份会话缓存）：
  // 失败由缓存内部静默处理，不影响阅读。
  useEffect(() => {
    if (!book) return;
    void warmKnowledgeBook(book.id);
  }, [book?.id]);

  const flatChapters = useMemo(() => flattenChapters(toc), [toc]);

  /** chapterId → 目录顺序：书签「章节顺序」排序用。 */
  const bookmarkChapterOrder = useMemo(() => {
    const order = new Map<string, number>();
    flatChapters.forEach((item, index) => {
      if (item.chapterId) order.set(item.chapterId, index);
    });
    return order;
  }, [flatChapters]);

  // 首页知识库 / 检索结果带 state.openSummary 跳转到阅读器：自动打开左栏并切到「摘要」。
  // 先于下面的 deep link 重定向声明，避免它跳章后再用旧 pathname 清 state。
  // 消费后立刻 replace 清掉 state，刷新 / 回退不会重复触发。
  useEffect(() => {
    if (summaryStateConsumed.current) return;
    const state = location.state as { openSummary?: boolean } | null;
    if (state?.openSummary !== true) return;
    summaryStateConsumed.current = true;
    setLeftTab("summary");
    setLeftOpen(true);
    if (!isWideRef.current) setNarrowPanel("left");
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  // Deep link /read/:bookId 没有章节时，落到目录里的第一篇。
  useEffect(() => {
    if (bookLoading || !book || chapterId || flatChapters.length === 0) return;
    navigate(`/read/${bookId}/${flatChapters[0].chapterId}`, { replace: true });
  }, [bookLoading, book, chapterId, flatChapters, bookId, navigate]);

  useEffect(() => {
    if (!library || !chapterId) {
      setChapter(null);
      setChapterLoading(false);
      setChapterError(null);
      return;
    }

    let cancelled = false;
    setChapter(null);
    setChapterLoading(true);
    setChapterError(null);

    library
      .getChapter(bookId, chapterId)
      .then((value) => {
        if (cancelled) return;
        setChapter(value);
        if (!value) setChapterError("没有找到这一章，可能已被删除，或目录尚未生成。");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setChapterError(getErrorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setChapterLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [library, bookId, chapterId, chapterAttempt]);

  // 切章后回到正文顶部。
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    viewport?.scrollTo({ top: 0 });
  }, [chapterId]);

  // 切章后清除跳转回退、注释高亮、书签文字高亮。
  useEffect(() => {
    setActiveNoteNumber(null);
    setCanJumpBack(false);
    jumpBackRef.current = null;
    setBookmarkJumpHighlight(null);
    if (bookmarkJumpHighlightTimer.current !== null) {
      window.clearTimeout(bookmarkJumpHighlightTimer.current);
      bookmarkJumpHighlightTimer.current = null;
    }
  }, [chapterId]);

  const trail = useMemo(
    () => (chapterId ? findChapterTrail(toc, chapterId) ?? [] : []),
    [toc, chapterId],
  );

  /** 传给右栏 AGENT 的当前章正文摘要（前约 1200 字）；默认不自动附带，由用户点「插入当前章节」。 */
  const chapterExcerpt = useMemo(() => {
    if (!chapter) return undefined;
    const blocks =
      chapter.blocks.length > 1 &&
      chapter.blocks[0].kind === "heading" &&
      chapter.blocks[0].text.trim() === chapter.title.trim()
        ? chapter.blocks.slice(1)
        : chapter.blocks;
    const text = blocks
      .map((block) => block.text ?? "")
      .join("\n")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (!text) return undefined;
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  }, [chapter]);
  const eyebrow = trail
    .filter((node) => node.type !== "chapter")
    .map((node) => node.title)
    .join(" · ");
  const currentIndex = flatChapters.findIndex((item) => item.chapterId === chapterId);
  const prevChapter = currentIndex > 0 ? flatChapters[currentIndex - 1] : undefined;
  const nextChapter =
    currentIndex >= 0 && currentIndex < flatChapters.length - 1
      ? flatChapters[currentIndex + 1]
      : undefined;

  const selectChapter = useCallback(
    (nextId: string) => {
      setNarrowPanel(null);
      // 章内翻页（上一章/下一章、目录、知识库跳章、文末翻页）一律 replace：
      // 历史里阅读器只保留一条记录，返回时回首页而不是退回上一章。
      navigate(`/read/${bookId}/${nextId}`, { replace: true });
    },
    [bookId, navigate],
  );

  const selectPrevChapter = useCallback(() => {
    if (prevChapter) selectChapter(prevChapter.chapterId);
  }, [prevChapter, selectChapter]);
  const selectNextChapter = useCallback(() => {
    if (nextChapter) selectChapter(nextChapter.chapterId);
  }, [nextChapter, selectChapter]);

  // 移动端左右滑动翻章：阈值来自设置（滑动距离 / 面板宽度）；桌面鼠标设备自动禁用。
  const swipeGestures = useReaderGestures({
    threshold: settings.readerSwipeThreshold,
    canPrev: Boolean(prevChapter),
    canNext: Boolean(nextChapter),
    onPrev: selectPrevChapter,
    onNext: selectNextChapter,
  });

  // 返回：Android 硬件返回/手势一律回首页（先关闭阅读器内覆盖层/抽屉）；
  // 桌面只拦截鼠标侧键与 Alt+方向键，避免暴露 Web 历史，但不做任何导航。
  const androidReader = useMemo(isAndroidReader, []);
  useReaderBackGuard({
    onBackHome: () => {
      if (androidReader) navigate("/", { replace: true });
    },
    onBeforeBack: () => {
      if (!androidReader) return false;
      if (settingsOpen) {
        setSettingsOpen(false);
        return true;
      }
      if (narrowPanel !== null) {
        setNarrowPanel(null);
        return true;
      }
      return false;
    },
  });

  const getScrollViewport = useCallback((): HTMLElement | null => {
    return (
      scrollRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null
    );
  }, []);

  /** 命中目标的一次性高亮（.jump-target-flash 定义在全局样式，1.8s 后自动移除）。 */
  const flashTarget = useCallback((element: HTMLElement) => {
    element.classList.remove("jump-target-flash");
    void element.offsetWidth;
    element.classList.add("jump-target-flash");
    window.setTimeout(() => element.classList.remove("jump-target-flash"), 1800);
  }, []);

  /** 滚动到某个元素并记录返回位置；命中目标短暂高亮。 */
  const scrollToTarget = useCallback(
    (element: HTMLElement): boolean => {
      const viewport = getScrollViewport();
      if (!viewport) return false;
      jumpBackRef.current = { scrollTop: viewport.scrollTop };
      setCanJumpBack(true);
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      flashTarget(element);
      return true;
    },
    [flashTarget, getScrollViewport],
  );

  /** 跳到正文某个块；记住跳转前的滚动位置，供顶栏「回到刚刚阅读位置」使用。 */
  const jumpToBlock = useCallback(
    (blockId: string): boolean => {
      const viewport = getScrollViewport();
      let target = viewport?.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`) ?? null;

      // 「仅注释栏展示」时文末注释块被隐藏：若引用落到注释块，退回到引用它的正文标号处。
      if (!target && chapter) {
        const noteBlock = chapter.blocks.find(
          (block) => block.id === blockId && block.kind === "note",
        );
        if (noteBlock && typeof noteBlock.noteNumber === "number" && noteBlock.noteNumber > 0) {
          const markerBlock = findNoteMarkerBlock(chapter, noteBlock.noteNumber);
          if (markerBlock) {
            target =
              viewport?.querySelector<HTMLElement>(`[data-block-id="${markerBlock.id}"]`) ?? null;
          }
        }
      }

      if (!target) return false;
      return scrollToTarget(target);
    },
    [chapter, getScrollViewport, scrollToTarget],
  );

  const jumpBack = useCallback(() => {
    const viewport = getScrollViewport();
    const saved = jumpBackRef.current;
    if (viewport && saved) {
      viewport.scrollTo({ top: saved.scrollTop, behavior: "smooth" });
    }
    jumpBackRef.current = null;
    setCanJumpBack(false);
  }, [getScrollViewport]);

  /** 书签轻提示（创建 / 管理操作结果）：显示 2.6s 后自动消失。 */
  const showBookmarkNotice = useCallback((notice: BookmarkNotice) => {
    setBookmarkNotice(notice);
    if (bookmarkNoticeTimer.current !== null) window.clearTimeout(bookmarkNoticeTimer.current);
    bookmarkNoticeTimer.current = window.setTimeout(() => {
      bookmarkNoticeTimer.current = null;
      setBookmarkNotice(null);
    }, BOOKMARK_NOTICE_MS);
  }, []);

  /** 新增书签在列表里短暂高亮，帮助用户确认哪一条刚创建。 */
  const highlightBookmark = useCallback((id: string) => {
    setBookmarkHighlightId(id);
    if (bookmarkHighlightTimer.current !== null) window.clearTimeout(bookmarkHighlightTimer.current);
    bookmarkHighlightTimer.current = window.setTimeout(() => {
      bookmarkHighlightTimer.current = null;
      setBookmarkHighlightId(null);
    }, BOOKMARK_NOTICE_MS);
  }, []);

  /** 当前阅读现场的面板状态（写入书签 panels，跳转时还原）。 */
  const captureReaderPanels = useCallback(
    (): BookmarkPanels => ({
      leftOpen,
      rightOpen,
      leftTab,
      rightTab: rightTabRef.current,
    }),
    [leftOpen, rightOpen, leftTab],
  );

  /**
   * 创建书签：捕获正文滚动位置 + 左右面板现场 + 书籍/章节信息。
   * - 带 `quote` 时是文字书签（记录 blockId + 选中文字，标题取选中文字前 ~20 字）；
   * - 不带时是页面书签（标题「章节名 · 页面位置 x%」）。
   * 成功后切到知识面板「书签」并给轻提示；失败给出错误提示但不影响阅读。
   */
  const createBookmark = useCallback(
    async (options?: {
      quote?: string;
      blockId?: string;
      quoteStart?: number;
      quoteEnd?: number;
    }): Promise<Bookmark | null> => {
      if (!bookId || !chapterId) {
        showBookmarkNotice({ text: "章节载入后才能添加书签", tone: "error" });
        return null;
      }
      if (creatingBookmark) return null;
      const viewport = getScrollViewport();
      const scrollTop = viewport ? Math.max(0, Math.round(viewport.scrollTop)) : 0;
      const quote = options?.quote?.replace(/\s+/g, " ").trim().slice(0, 2000) || undefined;
      const blockId = quote ? options?.blockId : undefined;
      const quoteStart =
        quote && typeof options?.quoteStart === "number" && options.quoteStart >= 0
          ? options.quoteStart
          : undefined;
      const quoteEnd =
        quote &&
        typeof options?.quoteEnd === "number" &&
        typeof quoteStart === "number" &&
        options.quoteEnd >= quoteStart
          ? options.quoteEnd
          : undefined;
      const chapterTitle = chapter?.title;
      const input: BookmarkInput = {
        bookId,
        ...(book?.title ? { bookTitle: book.title } : {}),
        chapterId,
        ...(chapterTitle ? { chapterTitle } : {}),
        scrollTop,
        ...(blockId ? { blockId } : {}),
        ...(quote ? { quote } : {}),
        ...(typeof quoteStart === "number" ? { quoteStart } : {}),
        ...(typeof quoteEnd === "number" ? { quoteEnd } : {}),
        title: quote
          ? quoteTitle(quote)
          : `${chapterTitle ?? "本页"} · ${pagePositionLabel(scrollTop, viewport)}`,
        panels: captureReaderPanels(),
      };

      setCreatingBookmark(true);
      try {
        const created = await bookmarkStore.add(input);
        highlightBookmark(created.id);
        showBookmarkNotice({ text: quote ? "已创建文字书签" : "已添加书签", tone: "success" });
        // 切到知识面板「书签」并展开面板：新增项在列表顶部可见（轻提示也显示在面板底部）。
        setLeftTab("bookmarks");
        if (isWide) setLeftOpen(true);
        else setNarrowPanel("left");
        setQuoteSelection(null);
        window.getSelection()?.removeAllRanges();
        return created;
      } catch (reason: unknown) {
        showBookmarkNotice({
          text: `添加书签失败：${getErrorMessage(reason)}`,
          tone: "error",
        });
        return null;
      } finally {
        setCreatingBookmark(false);
      }
    },
    [
      bookId,
      chapterId,
      chapter?.title,
      book?.title,
      creatingBookmark,
      getScrollViewport,
      captureReaderPanels,
      bookmarkStore,
      highlightBookmark,
      showBookmarkNotice,
      isWide,
    ],
  );

  /** 读取正文内的当前选区：文字 trim ≤2000 + 所在正文块 + 相对原始 block.text 的偏移。 */
  const readArticleSelection = useCallback(():
    | { text: string; blockId?: string; quoteStart?: number; quoteEnd?: number }
    | undefined => {
    const viewport = getScrollViewport();
    const article = viewport?.querySelector<HTMLElement>(".prose-reading") ?? null;
    const selected = readArticleSelectionFromDom(article);
    if (!selected) return undefined;
    return {
      text: selected.text,
      ...(selected.blockId ? { blockId: selected.blockId } : {}),
      ...(typeof selected.start === "number" ? { quoteStart: selected.start } : {}),
      ...(typeof selected.end === "number" ? { quoteEnd: selected.end } : {}),
    };
  }, [getScrollViewport]);

  /**
   * 中间面板左下角「创建书签」：优先按当前选区创建文字书签（正文块 data-block-id +
   * 选中文字 trim ≤2000 + 精确偏移），没有选区时创建页面书签（当前滚动位置）。
   */
  const createBookmarkFromSelection = useCallback(() => {
    if (creatingBookmark) return;
    const selected = readArticleSelection();
    void createBookmark(
      selected
        ? {
            quote: selected.text,
            blockId: selected.blockId,
            quoteStart: selected.quoteStart,
            quoteEnd: selected.quoteEnd,
          }
        : undefined,
    );
  }, [creatingBookmark, readArticleSelection, createBookmark]);

  /** 「始终存在」模式下无选区时引用整章：章节标题 + 复用现有章节摘录（前 ~1200 字）。 */
  const chapterQuoteText = useMemo(() => {
    if (!chapter || !chapterExcerpt) return "";
    return `${chapter.title}（整章引用·节选）：${chapterExcerpt}`;
  }, [chapter, chapterExcerpt]);

  /**
   * 打开书签：恢复阅读现场。
   *
   * 时序：先恢复面板状态与 leftTab/rightTab（立即生效），跨章时 replace 导航到目标章节；
   * 滚动位置不在这里直接写，而是登记 `pendingBookmarkJump`，等章节正文渲染完成后由下面的
   * effect 用 rAF + 重试恢复（内容未撑开高度时会被夹取），用户一滚动/触摸就放弃恢复。
   */
  const openBookmark = useCallback(
    (bookmark: Bookmark) => {
      setBookmarkNotice(null);
      const panels = bookmark.panels;
      const recordedLeftTab = normalizeLeftTab(panels?.leftTab);
      setLeftOpen(panels?.leftOpen !== false);
      setRightOpen(panels?.rightOpen !== false);
      setLeftTab(
        recordedLeftTab === "notes" && !settings.notesPanelEnabled ? "toc" : recordedLeftTab,
      );
      setActiveNoteNumber(null);
      setNarrowPanel(null);
      // 右栏标签：请求切换（面板未挂载时，挂载后由 ExtensionPanel 的 tabRequest 生效）。
      setRightTabRequest({ tab: normalizeRightTab(panels?.rightTab), nonce: Date.now() });
      // 同章跳转：记住跳转前位置，顶栏显示「回到刚刚阅读位置」。
      if (bookmark.chapterId === chapterId) {
        const viewport = getScrollViewport();
        if (viewport) {
          jumpBackRef.current = { scrollTop: viewport.scrollTop };
          setCanJumpBack(true);
        }
      }
      setPendingBookmarkJump({
        token: Date.now(),
        chapterId: bookmark.chapterId,
        scrollTop: Math.max(0, Math.round(bookmark.scrollTop ?? 0)),
        ...(bookmark.blockId ? { blockId: bookmark.blockId } : {}),
        ...(bookmark.quote ? { quote: bookmark.quote } : {}),
        ...(typeof bookmark.quoteStart === "number" ? { quoteStart: bookmark.quoteStart } : {}),
        ...(typeof bookmark.quoteEnd === "number" ? { quoteEnd: bookmark.quoteEnd } : {}),
      });
      if (bookmark.chapterId !== chapterId) selectChapter(bookmark.chapterId);
    },
    [chapterId, getScrollViewport, selectChapter, settings.notesPanelEnabled],
  );

  /** 书签跳转时的精确文字高亮：只高亮记录的选中文字，2.5s 后清除。 */
  const showBookmarkJumpHighlight = useCallback((pending: PendingBookmarkJump) => {
    if (!pending.blockId || !pending.quote) return;
    setBookmarkJumpHighlight({
      blockId: pending.blockId,
      quote: pending.quote,
      ...(typeof pending.quoteStart === "number" ? { start: pending.quoteStart } : {}),
      ...(typeof pending.quoteEnd === "number" ? { end: pending.quoteEnd } : {}),
      nonce: Date.now(),
    });
    if (bookmarkJumpHighlightTimer.current !== null) {
      window.clearTimeout(bookmarkJumpHighlightTimer.current);
    }
    bookmarkJumpHighlightTimer.current = window.setTimeout(() => {
      bookmarkJumpHighlightTimer.current = null;
      setBookmarkJumpHighlight(null);
    }, BOOKMARK_NOTICE_MS);
  }, []);

  // 书签跳转后的滚动恢复：章节内容异步加载/撑开高度时重试；用户交互（滚轮/触摸/点击）取消。
  useEffect(() => {
    const pending = pendingBookmarkJump;
    if (!pending) return;
    // 跨章跳转在导航提交前会短暂出现章节不一致：延迟一拍再判断，避免误清待恢复现场。
    if (pending.chapterId !== chapterId) {
      const guard = window.setTimeout(() => {
        setPendingBookmarkJump((current) =>
          current && current.token === pending.token ? null : current,
        );
      }, 1000);
      return () => window.clearTimeout(guard);
    }
    if (chapterLoading) return;
    if (!chapter) {
      setPendingBookmarkJump(null);
      return;
    }
    // 跨章跳转时 route 的 chapterId 会先更新、章节数据仍是上一章：等新章节真正载入再恢复，
    // 否则会滚动/高亮旧章节的 DOM（随后被新内容替换，看起来像没生效）。
    if (chapter.id !== pending.chapterId) return;
    const viewport = getScrollViewport();
    if (!viewport) {
      setPendingBookmarkJump(null);
      return;
    }

    let cancelled = false;
    let frame = 0;
    let timer: number | null = null;
    let attempts = 0;

    const cleanup = () => {
      window.removeEventListener("wheel", onUserInput);
      window.removeEventListener("touchstart", onUserInput);
      window.removeEventListener("pointerdown", onUserInput);
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const onUserInput = () => {
      cancelled = true;
      cleanup();
      setPendingBookmarkJump(null);
    };
    const finish = () => {
      cancelled = true;
      cleanup();
      setPendingBookmarkJump(null);
    };

    window.addEventListener("wheel", onUserInput, { passive: true });
    window.addEventListener("touchstart", onUserInput, { passive: true });
    window.addEventListener("pointerdown", onUserInput, { passive: true });

    const attempt = () => {
      if (cancelled) return;
      const target = pending.blockId
        ? viewport.querySelector<HTMLElement>(`[data-block-id="${pending.blockId}"]`)
        : null;
      // 1) 恢复记录的滚动位置（页面级书签的最终位置；文字书签作为兜底）。
      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = Math.min(pending.scrollTop, maxScroll);
      // 2) 文字书签再滚到记录块，并只高亮选中的文字（不整段高亮）。
      if (target) {
        target.scrollIntoView({ block: "center" });
        showBookmarkJumpHighlight(pending);
        finish();
        return;
      }
      attempts += 1;
      // 内容还没撑开高度时 scrollTop 会被夹取，等 DOM 长高后重试。
      if (
        Math.abs(viewport.scrollTop - pending.scrollTop) <= 1 ||
        attempts >= SCROLL_RESTORE_MAX_ATTEMPTS
      ) {
        finish();
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        attempt();
      }, SCROLL_RESTORE_RETRY_MS);
    };

    frame = requestAnimationFrame(() => {
      frame = 0;
      attempt();
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [
    pendingBookmarkJump,
    chapterId,
    chapterLoading,
    chapter,
    getScrollViewport,
    flashTarget,
    showBookmarkJumpHighlight,
  ]);

  // 正文划词 → 右下角「引用到 AGENT」悬浮按钮。
  // - 只在选区落在正文（.prose-reading）内时出现；选在左右栏/输入框里不触发；
  // - 移动端长按选择同样走 selectionchange，加 250ms 防抖等系统选择手柄稳定；
  // - 选区清空、点击别处、正文滚动、切章、打开弹窗/覆盖层时隐藏。
  useEffect(() => {
    let timer = 0;
    const handleSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          setQuoteSelection(null);
          return;
        }
        const article = getScrollViewport()?.querySelector<HTMLElement>(".prose-reading");
        const anchor = selection.anchorNode;
        const element =
          anchor && anchor.nodeType === Node.ELEMENT_NODE
            ? (anchor as Element)
            : (anchor?.parentElement ?? null);
        if (!article || !element || !article.contains(element)) {
          setQuoteSelection(null);
          return;
        }
        const text = selection.toString().replace(/\s+/g, " ").trim().slice(0, 2000);
        setQuoteSelection(text ? { text } : null);
      }, 250);
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [getScrollViewport]);

  // 正文滚动/切章/打开其他浮层时隐藏引用按钮。
  useEffect(() => {
    const viewport = getScrollViewport();
    if (!viewport) return;
    const hide = () => setQuoteSelection(null);
    viewport.addEventListener("scroll", hide, { passive: true });
    return () => viewport.removeEventListener("scroll", hide);
  }, [getScrollViewport, chapterId, chapterLoading]);

  useEffect(() => {
    setQuoteSelection(null);
  }, [chapterId]);

  useEffect(() => {
    if (narrowPanel !== null || settingsOpen) setQuoteSelection(null);
  }, [narrowPanel, settingsOpen]);

  /** 窄屏内联模式的 Esc 关闭（dialog 由 Radix 负责，drawer 由 PanelDrawer 负责）。 */
  useEffect(() => {
    if (isWide || narrowPanel === null || panelMode !== "inline") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // 面板内可能有下拉菜单/弹层：先让它们自己处理 Esc，不要连面板一起关掉。
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[role=menu],[data-radix-popper-content-wrapper]")
      ) {
        return;
      }
      event.preventDefault();
      setNarrowPanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isWide, narrowPanel, panelMode]);

  /**
   * 把选中的正文引用到 AGENT：宽屏展开右栏，窄屏按设置打开右侧面板并定位到 AGENT。
   * 文本优先级：debounce 后的选区状态 → 当前 DOM 选区（设置「始终存在」时点了才选的情况）
   * → `fallbackText`（无选区时的整章引用节选）。
   */
  const quoteToAgent = useCallback(
    (fallbackText?: string) => {
      const text = (quoteSelection?.text ?? readArticleSelection()?.text ?? fallbackText ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      const nonce = Date.now();
      setAgentQuote({ text, chapterId, chapterTitle: chapter?.title, nonce });
      setRightTabRequest({ tab: "agent", nonce });
      setQuoteSelection(null);
      window.getSelection()?.removeAllRanges();
      if (isWide) setRightOpen(true);
      else setNarrowPanel("right");
    },
    [quoteSelection, readArticleSelection, chapterId, chapter?.title, isWide],
  );

  // 中间面板底部两个快捷按钮（创建书签 / 引用到 AGENT）的显示策略：
  // hidden 不渲染；selection 仅在正文有非空选中文字时出现；always 始终显示
  // （有选区仍按精确行为，无选区时书签=页面位置、引用=整章引用节选）。
  const middleActionsAvailable = Boolean(chapter && !chapterLoading && !chapterError);
  const showBookmarkAction =
    middleActionsAvailable &&
    settings.middleBookmarkMode !== "hidden" &&
    (settings.middleBookmarkMode === "always" || quoteSelection !== null);
  const showQuoteAction =
    middleActionsAvailable &&
    settings.middleQuoteMode !== "hidden" &&
    (settings.middleQuoteMode === "always" || quoteSelection !== null);

  /** 左面板开关：宽屏折叠/展开知识面板，窄屏按设置打开左侧面板。 */
  const toggleLeftPane = useCallback(() => {
    if (isWide) setLeftOpen((value) => !value);
    else setNarrowPanel((current) => (current === "left" ? null : "left"));
  }, [isWide]);

  /** 右面板开关：宽屏折叠/展开探索面板，窄屏按设置打开右侧面板。 */
  const toggleRightPane = useCallback(() => {
    if (isWide) setRightOpen((value) => !value);
    else setNarrowPanel((current) => (current === "right" ? null : "right"));
  }, [isWide]);

  // 顶栏按钮统一用描述定义：空间充足时渲染成一排 icon 按钮，
  // 空间不足时由 ToolbarOverflow 折叠成 ⋮ 菜单，两处共用同一份行为。
  // 面板开合按钮：左「知识」（三个点）、右「探索」（四角星）；展开时图标变 ×。
  const leftToolbarItems = useMemo<ToolbarOverflowItem[]>(() => {
    const label = READER_PANE_BUTTON_LABELS.left;
    return [
      {
        key: "left-pane",
        label,
        icon: leftPanelVisible ? X : MoreHorizontal,
        ariaLabel: label,
        title: label,
        onSelect: toggleLeftPane,
      },
      {
        key: "home",
        label: "返回主界面",
        icon: LibraryBig,
        ariaLabel: "返回主界面",
        title: "返回主界面",
        // replace：不把阅读器留在历史里，避免 Android 返回哨兵与首页返回互相顶。
        onSelect: () => navigate("/", { replace: true }),
      },
    ];
  }, [leftPanelVisible, navigate, toggleLeftPane]);

  const rightToolbarItems = useMemo<ToolbarOverflowItem[]>(() => {
    return [
      {
        key: "settings",
        label: "设置",
        icon: Settings2,
        ariaLabel: "设置",
        title: "设置",
        // 不再跳 /settings：在阅读器内打开全屏覆盖层，关闭后保留阅读位置。
        onSelect: () => setSettingsOpen(true),
      },
      {
        key: "right-pane",
        label: READER_PANE_BUTTON_LABELS.right,
        icon: rightPanelVisible ? X : Sparkle,
        ariaLabel: READER_PANE_BUTTON_LABELS.right,
        title: READER_PANE_BUTTON_LABELS.right,
        onSelect: toggleRightPane,
      },
    ];
  }, [rightPanelVisible, toggleRightPane]);

  // 左右两组各自独立判定是否折叠；判定只看顶栏/标题实测尺寸 + 固定项数估算。
  const toolbarOverflow = useToolbarOverflow(
    leftToolbarItems.length,
    rightToolbarItems.length,
  );

  /** 文内标号点击时打开注释栏（宽屏展开知识面板，窄屏按设置打开左侧面板）。 */
  const openNotesPanel = useCallback(() => {
    if (isWide) setLeftOpen(true);
    else setNarrowPanel("left");
    setLeftTab("notes");
  }, [isWide]);

  const handleTabChange = useCallback((nextTab: LeftTab) => {
    setLeftTab(nextTab);
    if (nextTab !== "notes") setActiveNoteNumber(null);
  }, []);

  /** 点击文内 [n]：注释栏开着就切过去高亮，否则滚到文末对应注释。 */
  const handleNoteMarkerClick = useCallback(
    (noteNumber: number) => {
      if (settings.notesPanelEnabled) {
        setActiveNoteNumber(noteNumber);
        openNotesPanel();
        return;
      }
      const note = chapter?.blocks.find(
        (block) => block.kind === "note" && block.noteNumber === noteNumber,
      );
      if (note) jumpToBlock(note.id);
    },
    [settings.notesPanelEnabled, chapter, openNotesPanel, jumpToBlock],
  );

  /** 点击注释栏卡片：跳到正文里该注释的标号位置（只高亮标号）。 */
  const handleOpenNote = useCallback(
    (note: ChapterNote) => {
      setNarrowPanel(null);
      const viewport = getScrollViewport();
      const marker = viewport?.querySelector<HTMLElement>(
        `[data-note-marker="${note.noteNumber}"]`,
      );
      if (marker && scrollToTarget(marker)) return;
      const markerBlock = findNoteMarkerBlock(chapter, note.noteNumber);
      jumpToBlock(markerBlock?.id ?? note.blockId);
    },
    [chapter, getScrollViewport, jumpToBlock, scrollToTarget],
  );

  const handleJumpToBlock = useCallback(
    (blockId: string) => {
      setNarrowPanel(null);
      if (jumpToBlock(blockId)) return;
      // 「仅注释栏展示」时文末注释块不可见：无标号的说明类注释转到注释栏查看。
      const note = chapter?.blocks.find(
        (block) => block.id === blockId && block.kind === "note",
      );
      if (note && settings.notesPanelEnabled) {
        setActiveNoteNumber(typeof note.noteNumber === "number" ? note.noteNumber : 0);
        openNotesPanel();
      }
    },
    [chapter, jumpToBlock, openNotesPanel, settings.notesPanelEnabled],
  );

  if (status === "initializing") {
    return (
      <ReaderStatePage
        eyebrow="LOCAL LIBRARY"
        title="正在打开本地书库"
        description="首次启动会把内置书籍与档案复制到用户库；之后打开应用只读取本机数据。"
        busy
      />
    );
  }

  if (status === "error") {
    return (
      <ReaderStatePage
        eyebrow="LIBRARY ERROR"
        title="书库打开失败"
        tone="error"
        description={
          <>
            <span className="block break-words text-ink">
              {libraryError ?? "未知错误"}
            </span>
            <span className="mt-2 block text-xs leading-6">
              可以重新初始化；若仍然失败，请确认应用有权访问本机用户数据目录。
            </span>
          </>
        }
        actions={
          <>
            <Button type="button" onClick={retry}>
              重新初始化
            </Button>
            <Button asChild variant="outline">
              <Link to="/">返回主界面</Link>
            </Button>
          </>
        }
      />
    );
  }

  if (notFound) {
    return (
      <ReaderStatePage
        eyebrow="BOOK NOT FOUND"
        title="没有找到这本书"
        description={
          <>
            这本书可能已被删除、还未安装，或本地书库数据被清理。
            <span className="mt-1 block text-xs leading-6">
              返回主界面可以重新选择书籍；若刚导入，可重新载入书库后再试。
            </span>
          </>
        }
        actions={
          <>
            <Button asChild>
              <Link to="/">返回主界面</Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setBookAttempt((value) => value + 1)}
            >
              重新载入
            </Button>
          </>
        }
      />
    );
  }

  // 书签面板的完整绑定：中间面板划词创建与左栏「添加书签」共用同一份列表/提示状态。
  // （放在早退分支之后，是普通对象，不违反 hooks 规则。）
  const bookmarkBindings: BookmarkPanelBindings = {
    items: bookmarkStore.bookmarks,
    loading: bookmarkStore.loading,
    error: bookmarkStore.error,
    notice: bookmarkNotice,
    highlightId: bookmarkHighlightId,
    chapterOrder: bookmarkChapterOrder,
    creating: creatingBookmark,
    canCreate: Boolean(chapterId && chapter && !chapterLoading),
    onReload: bookmarkStore.reload,
    onAdd: () => {
      void createBookmark();
    },
    onOpen: openBookmark,
    onUpdate: async (id, patch) => {
      await bookmarkStore.update(id, patch);
    },
    onDelete: async (id) => {
      await bookmarkStore.remove(id);
    },
    onDeleteMany: async (ids) => {
      await bookmarkStore.removeMany(ids);
    },
    onUpdateOrders: async (orders: BookmarkOrder[]) => {
      await bookmarkStore.updateOrders(orders);
    },
  };

  const leftPanel = (className?: string) => (
    <LeftRail
      book={book}
      toc={toc}
      currentChapterId={chapterId}
      loading={bookLoading}
      bookId={bookId}
      chapterId={chapterId}
      chapterTitle={chapter?.title}
      tab={leftTab}
      onTabChange={handleTabChange}
      onJumpToBlock={handleJumpToBlock}
      notes={notes}
      activeNoteNumber={activeNoteNumber}
      onOpenNote={handleOpenNote}
      onNavigate={() => setNarrowPanel(null)}
      onOpenChapter={selectChapter}
      bookmarks={bookmarkBindings}
      className={className}
    />
  );

  const rightPanel = (className?: string) => (
    <ExtensionPanel
      bookId={bookId}
      bookTitle={book?.title}
      chapterId={chapterId}
      chapterTitle={chapter?.title}
      book={book}
      excerpt={chapterExcerpt}
      tabRequest={rightTabRequest}
      quote={agentQuote}
      className={className}
    />
  );

  // 窄屏「内联推挤」：面板进入布局、把正文挤窄；正文至少保留 NARROW_INLINE_MIN_CONTENT。
  const narrowLeftWidth = narrowInlinePaneWidth(leftPane.preferredWidth, viewportWidth);
  const narrowRightWidth = narrowInlinePaneWidth(rightPane.preferredWidth, viewportWidth);
  const drawerLeftWidth = narrowDrawerWidth(leftPane.preferredWidth, viewportWidth);
  const drawerRightWidth = narrowDrawerWidth(rightPane.preferredWidth, viewportWidth);
  const isNarrowInline = !isWide && panelMode === "inline";
  const isNarrowDrawer = !isWide && panelMode === "drawer";
  const isNarrowDialog = !isWide && panelMode === "dialog";

  return (
    <AppShell fullHeight hideHeader>
      <div
        data-reader-layout={isWide ? "wide" : `narrow-${panelMode}`}
        className="flex min-h-0 flex-1"
      >
        {isWide && leftOpen ? (
          <>
            <aside
              id="reader-left-pane"
              data-pane="left"
              data-pane-mode="inline"
              style={{ width: wideLeftWidth }}
              className="flex min-h-0 shrink-0 flex-col border-r border-border/70 bg-paper-soft/50"
            >
              {leftPanel()}
            </aside>
            <PaneResizer
              side="left"
              controls={{ ...leftPane, width: wideLeftWidth }}
              label="调整知识面板宽度"
              controlsTargetId="reader-left-pane"
              className="block"
            />
          </>
        ) : null}

        {isNarrowInline && narrowPanel === "left" ? (
          <aside
            id="reader-left-pane"
            data-pane="left"
            data-pane-mode="inline-narrow"
            style={{ width: narrowLeftWidth }}
            className="flex min-h-0 shrink-0 flex-col border-r border-border/70 bg-paper-soft/50"
          >
            {leftPanel()}
          </aside>
        ) : null}

        <section
          data-reader-content="middle"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <div
            ref={toolbarOverflow.toolbarRef}
            data-reader-toolbar="top"
            className="relative z-40 flex h-14 shrink-0 items-center gap-1 border-b border-border/70 bg-paper/85 px-2 sm:gap-1.5 sm:px-4"
          >
            <ToolbarOverflow
              side="left"
              collapsed={toolbarOverflow.left}
              items={leftToolbarItems}
            />

            <button
              ref={toolbarOverflow.titleRef}
              type="button"
              onClick={() => navigate("/", { replace: true })}
              aria-label="沮诵 · 主界面"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md px-2 py-1 font-serif text-base font-semibold tracking-[0.22em] text-ink transition-colors hover:text-cinnabar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40 sm:text-lg"
            >
              沮诵
            </button>

            <ToolbarOverflow
              side="right"
              collapsed={toolbarOverflow.right}
              items={rightToolbarItems}
              className="ml-auto"
            />
          </div>

          <div
            {...swipeGestures.bind}
            className="relative min-h-0 min-w-0 flex-1"
          >
            {bookError ? (
              <div className="mx-auto max-w-2xl px-5 py-10">
                <ErrorPanel
                  title="书籍载入失败"
                  message={bookError}
                  onRetry={() => setBookAttempt((value) => value + 1)}
                />
              </div>
            ) : bookLoading ? (
              <LoadingPanel label="正在载入书籍…" className="py-24" />
            ) : !chapterId && flatChapters.length === 0 ? (
              <div className="mx-auto max-w-2xl px-5 py-20 text-center">
                <p className="font-serif text-lg font-semibold tracking-wide">这本书还没有可读章节</p>
                <p className="mt-2 text-sm leading-7 text-ink-soft">
                  目录尚未生成。若刚导入 EPUB，请稍后刷新；若为种子书，请确认
                  data/books/maoxuan/seed.json 已生成。
                </p>
                <Button variant="outline" className="mt-6" onClick={() => setBookAttempt((value) => value + 1)}>
                  重新载入
                </Button>
              </div>
            ) : (
              <ScrollArea ref={scrollRef} className="h-full w-full min-w-0 max-w-full">
                <ChapterView
                  chapter={chapter}
                  loading={chapterLoading || (!chapterId && flatChapters.length > 0)}
                  error={chapterError}
                  eyebrow={eyebrow}
                  prev={prevChapter}
                  next={nextChapter}
                  onRetry={() => setChapterAttempt((value) => value + 1)}
                  onSelectChapter={selectChapter}
                  noteDisplayMode={noteDisplayMode}
                  onNoteClick={handleNoteMarkerClick}
                  highlight={bookmarkJumpHighlight}
                />
              </ScrollArea>
            )}

            {/* 桌面端正文左右边缘翻章箭头；移动端不渲染。 */}
            <ReaderEdgeNav
              canPrev={Boolean(prevChapter)}
              canNext={Boolean(nextChapter)}
              onPrev={selectPrevChapter}
              onNext={selectNextChapter}
              hidden={settingsOpen || narrowPanel !== null}
            />

            {/* 移动端滑动翻章进度环（由 useReaderGestures 提供）。 */}
            {swipeGestures.overlay}

            {/* 正文左上角「回到刚刚阅读位置」：跳转书签/注释后出现。 */}
            <ReaderFloatingActions canJumpBack={canJumpBack} onJumpBack={jumpBack} />

            {/* 中间面板左下角「创建书签」：与右下角「引用到 AGENT」同一套圆形强调色悬浮按钮，
                对称悬浮在底部两侧。显示策略由设置 middleBookmarkMode / middleQuoteMode 决定：
                hidden 不渲染、selection 仅选区时出现、always 常显（无选区时创建页面级书签）。 */}
            {showBookmarkAction ? (
              <button
                type="button"
                data-create-bookmark="true"
                aria-label="创建书签"
                title="创建书签（选中文字时为文字书签）"
                disabled={creatingBookmark}
                // 与「引用到 AGENT」一致：pointerdown 触发，避免按下瞬间选区塌陷；
                // 键盘激活（detail=0）走 onClick。
                onPointerDown={(event) => {
                  event.preventDefault();
                  createBookmarkFromSelection();
                }}
                onClick={(event) => {
                  if (event.detail === 0) createBookmarkFromSelection();
                }}
                className="absolute bottom-4 left-4 z-30 inline-flex h-9 w-9 items-center justify-center rounded-full bg-cinnabar text-paper-soft shadow-paper transition-colors hover:bg-cinnabar/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40 disabled:pointer-events-none disabled:opacity-60"
              >
                <BookmarkPlus className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}

            {/* 「引用到 AGENT」：定位在中间面板右下角，不挡滚动条/文末翻页（文章底部有 pb-16）。
                「始终存在」且无选区时引用整章（标题 + 现有章节摘录节选）。 */}
            {showQuoteAction ? (
              <button
                type="button"
                data-quote-to-agent="true"
                aria-label="引用到 AGENT"
                title={
                  settings.middleQuoteMode === "always" && !quoteSelection
                    ? "引用整章到 AGENT"
                    : "引用到 AGENT"
                }
                // 触屏/鼠标在 pointerdown 就触发：移动端点按空白处会立刻让选区塌陷，
                // 若等 click，按钮可能先被卸载导致「第一下无反应」。键盘激活走 onClick（detail=0）。
                onPointerDown={(event) => {
                  event.preventDefault();
                  quoteToAgent(
                    settings.middleQuoteMode === "always" ? chapterQuoteText : undefined,
                  );
                }}
                onClick={(event) => {
                  if (event.detail === 0) {
                    quoteToAgent(
                      settings.middleQuoteMode === "always" ? chapterQuoteText : undefined,
                    );
                  }
                }}
                className="absolute bottom-4 right-4 z-30 inline-flex h-9 w-9 items-center justify-center rounded-full bg-cinnabar text-paper-soft shadow-paper transition-colors hover:bg-cinnabar/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40"
              >
                <MessageSquareQuote className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </section>

        {isNarrowInline && narrowPanel === "right" ? (
          <aside
            id="reader-right-pane"
            data-pane="right"
            data-pane-mode="inline-narrow"
            style={{ width: narrowRightWidth }}
            className="flex min-h-0 shrink-0 flex-col border-l border-border/70 bg-paper-soft/40"
          >
            {rightPanel()}
          </aside>
        ) : null}

        {isWide && rightOpen ? (
          <>
            <PaneResizer
              side="right"
              controls={{ ...rightPane, width: wideRightWidth }}
              label="调整探索面板宽度"
              controlsTargetId="reader-right-pane"
              className="block"
            />
            <aside
              id="reader-right-pane"
              data-pane="right"
              data-pane-mode="inline"
              style={{ width: wideRightWidth }}
              className="flex min-h-0 shrink-0 flex-col border-l border-border/70 bg-paper-soft/40"
            >
              {rightPanel()}
            </aside>
          </>
        ) : null}
      </div>

      {/* 窄屏：居中对话框（readerPanelMode = "dialog"，保留原有呈现方式）。 */}
      {isNarrowDialog ? (
        <>
          <Dialog
            open={narrowPanel === "left"}
            onOpenChange={(open) => setNarrowPanel(open ? "left" : null)}
          >
            <DialogContent className="flex h-[82vh] w-[calc(100%-1.5rem)] max-w-md flex-col gap-0 p-0">
              <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4 pr-12">
                <DialogTitle>{READER_PANE_TITLES.left}</DialogTitle>
                <DialogDescription className="truncate">
                  {book?.title ?? "书籍目录"}
                </DialogDescription>
              </DialogHeader>
              {leftPanel("min-h-0 flex-1")}
            </DialogContent>
          </Dialog>

          <Dialog
            open={narrowPanel === "right"}
            onOpenChange={(open) => setNarrowPanel(open ? "right" : null)}
          >
            <DialogContent className="flex h-[86vh] w-[calc(100%-1.5rem)] max-w-md flex-col gap-0 p-0">
              <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4 pr-12">
                <DialogTitle>{READER_PANE_TITLES.right}</DialogTitle>
                <DialogDescription className="truncate">
                  {chapter?.title ?? book?.title ?? "当前书籍"}
                </DialogDescription>
              </DialogHeader>
              {rightPanel("min-h-0 flex-1")}
            </DialogContent>
          </Dialog>
        </>
      ) : null}

      {/* 窄屏：覆盖式侧边抽屉（readerPanelMode = "drawer"，默认）。 */}
      {isNarrowDrawer ? (
        <>
          {narrowPanel === "left" ? (
            <PanelDrawer
              side="left"
              title={READER_PANE_TITLES.left}
              subtitle={book?.title}
              width={drawerLeftWidth}
              closeLabel="关闭知识面板"
              onClose={closeNarrowPanel}
            >
              {leftPanel("min-h-0 flex-1")}
            </PanelDrawer>
          ) : null}
          {narrowPanel === "right" ? (
            <PanelDrawer
              side="right"
              title={READER_PANE_TITLES.right}
              subtitle={chapter?.title ?? book?.title}
              width={drawerRightWidth}
              closeLabel="关闭探索面板"
              onClose={closeNarrowPanel}
            >
              {rightPanel("min-h-0 flex-1")}
            </PanelDrawer>
          ) : null}
        </>
      ) : null}

      {/* 阅读器内设置：全屏覆盖层，正文与滚动位置保留在下面；Esc/返回阅读关闭。 */}
      {settingsOpen ? <ReaderSettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </AppShell>
  );
}
