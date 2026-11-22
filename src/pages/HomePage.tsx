import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2, PanelLeftClose, PanelRightClose } from "lucide-react";

import { AboutChangelogView, AboutDetailView, AboutRoadmapView } from "../components/about/AboutPages";
import { EmergenceView } from "../components/home/EmergenceView";
import { GuideAgentView } from "../components/home/GuideAgentView";
import { GuideView } from "../components/home/GuideView";
import { HomeSearchView } from "../components/home/HomeSearchView";
import { HomeEntryPanel } from "../components/home/HomeEntryPanel";
import { HomeGuidePanel } from "../components/home/HomeGuidePanel";
import { HomeTopBar } from "../components/home/HomeTopBar";
import { ImportExportView } from "../components/home/ImportExportView";
import { KnowledgeLibraryView } from "../components/home/KnowledgeLibraryView";
import { PlaceholderPage } from "../components/home/PlaceholderPanel";
import { ShelfView } from "../components/home/ShelfView";
import { PaneResizer } from "../components/layout/PaneResizer";
import { SettingsContent } from "../components/settings/SettingsContent";
import { HOME_LEFT_PANE, HOME_RIGHT_PANE, selectionForLegacyOpenView, isLegacyHomeView } from "../lib/home";
import type { HomeGuideTarget } from "../lib/home-guide";
import {
  HOME_PARENTS_BY_ID,
  centerKeyForSelection,
  firstNavChild,
  isChildOfParent,
  isHomeParentId,
  type HomeChildId,
  type HomeFixedGuideId,
  type HomeNavChild,
  type HomeParentId,
  type HomeSelection,
} from "../lib/home-nav";
import {
  createEmptyHomeMemory,
  elementPathFromRoot,
  readHomeMemory,
  readScrollMemory,
  recordNavSelection,
  recordScrollMemory,
  resolveElementPath,
  resolveHomeSelection,
  storeHomeMemory,
  type HomeUiMemory,
} from "../lib/home-memory";
import { useLibrary } from "../lib/library";
import { useSettings } from "../lib/settings";
import { useHomeLayout } from "../lib/useHomeLayout";
import { usePaneWidth } from "../lib/usePaneWidth";
import { cn } from "../lib/utils";

/** 滚动位置还原时，内容异步加载可能还没撑开高度：在这些次数内持续重试。 */
const SCROLL_RESTORE_MAX_ATTEMPTS = 40;
const SCROLL_RESTORE_RETRY_MS = 100;
/** 滚动位置写盘防抖。 */
const MEMORY_PERSIST_DEBOUNCE_MS = 250;

type SettingsCategory = "account" | "behavior" | "appearance" | "agent";
type ImportExportSection = "books" | "knowledge" | "config";

const SETTINGS_CATEGORIES: readonly SettingsCategory[] = ["account", "behavior", "appearance", "agent"];
const IMPORT_EXPORT_SECTIONS: readonly ImportExportSection[] = ["books", "knowledge", "config"];

/** 设置子项 id（`settings.xxx`）→ SettingsContent 的 category。 */
function settingsCategoryForChild(childId: HomeChildId | null): SettingsCategory {
  const key = childId && childId.startsWith("settings.") ? childId.slice("settings.".length) : "";
  return SETTINGS_CATEGORIES.includes(key as SettingsCategory) ? (key as SettingsCategory) : "account";
}

/** 导入/导出子项 id（`import.xxx`）→ ImportExportView 的 section。 */
function importExportSectionForChild(childId: HomeChildId | null): ImportExportSection {
  const key = childId ? childId.slice(childId.indexOf(".") + 1) : "";
  return IMPORT_EXPORT_SECTIONS.includes(key as ImportExportSection)
    ? (key as ImportExportSection)
    : "books";
}

/** 面板栏头（56px，与中间顶栏对齐）：默认标题在左、收起按钮在右；reverse 时按钮在左、标题在右。 */
function HomePaneHeader({
  title,
  closeLabel,
  closeIcon: CloseIcon,
  onClose,
  reverse = false,
}: {
  title: string;
  closeLabel: string;
  closeIcon: typeof PanelLeftClose;
  onClose: () => void;
  /** 右面板「导览」：收起按钮放最左、标题放最右。 */
  reverse?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-3",
        reverse && "flex-row-reverse",
      )}
    >
      <span className="font-serif text-xs font-semibold tracking-[0.3em] text-ink-soft">{title}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        title={closeLabel}
        className="rounded-md p-1.5 text-ink-soft/70 transition-colors hover:bg-muted/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
      >
        <CloseIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** 导航 state 里的一次性 openView（AGENT「前往设置配置」等旧入口兼容）。 */
function legacyOpenViewFromState(state: unknown): HomeSelection | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as { openView?: unknown }).openView;
  return isLegacyHomeView(candidate) ? selectionForLegacyOpenView(candidate) : null;
}

/**
 * 首页工作区 Shell：顶格三栏 + 左「入口」/ 右「导览」父子层级。
 *
 * - 左右面板从窗口顶部开始（各自 56px 栏头），中间顶栏只在中间列顶部；
 * - 左入口选中后右面板显示其子项；检索（顶部）与 AGENT（底部）为常驻项；
 * - 层级选择按设置 `navMemory` 记忆：both=左右都记、rightOnly/alwaysHome=入口始终首页；
 * - 滚动位置、侧栏开合、常驻项按 `rememberUiState` 记忆（不改动各视图组件）。
 */
export function HomePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { library, books } = useLibrary();
  const { settings, loaded: settingsLoaded } = useSettings();
  const layout = useHomeLayout();

  const [selection, setSelection] = useState<HomeSelection>(() => ({
    parent: "home",
    child: firstNavChild("home")?.id ?? "home.shelf",
    fixed: null,
  }));
  /** 设置加载完成、初始层级/栏开合已应用；此前不写记忆、不还原滚动。 */
  const [uiReady, setUiReady] = useState(false);
  const [leftOpen, setLeftOpen] = useState(layout.canShowLeft);
  const [rightOpen, setRightOpen] = useState(layout.canShowRight);
  const [leftDrawer, setLeftDrawer] = useState(false);
  const [rightDrawer, setRightDrawer] = useState(false);

  const mainRef = useRef<HTMLElement | null>(null);
  /** 界面记忆存档：读一次，之后就地修改并延迟写盘。 */
  const memoryRef = useRef<HomeUiMemory | null>(null);
  if (memoryRef.current === null) {
    memoryRef.current = readHomeMemory() ?? createEmptyHomeMemory();
  }
  /** 启动初始化只执行一次（等设置异步加载完成后再决定初始层级）。 */
  const initializedRef = useRef(false);
  /** 导航 state 带来的显式选择（设置加载完成前先暂存，等初始化一起应用）。 */
  const explicitSelectionRef = useRef<HomeSelection | null>(null);
  /** 用户手动开关过侧栏后，断点变化不再自动改它的开合。 */
  const leftDirtyRef = useRef(false);
  const rightDirtyRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const uiReadyRef = useRef(uiReady);
  uiReadyRef.current = uiReady;
  const rememberRef = useRef(settings.rememberUiState);
  rememberRef.current = settings.rememberUiState;

  const leftPane = usePaneWidth({
    ...HOME_LEFT_PANE,
    side: "left",
    isVisible: () => layout.canShowLeft,
  });
  const rightPane = usePaneWidth({
    ...HOME_RIGHT_PANE,
    side: "right",
    isVisible: () => layout.canShowRight,
    reservedWidth: () => (layout.canShowLeft && leftOpen ? leftPane.width : 0),
  });

  const persistMemory = useCallback(() => {
    if (!uiReadyRef.current) return;
    const memory = memoryRef.current;
    if (!memory) return;
    storeHomeMemory(memory);
  }, []);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persistMemory();
    }, MEMORY_PERSIST_DEBOUNCE_MS);
  }, [persistMemory]);

  // 离开首页（进阅读器等）时把还没落盘的位置写掉。
  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      persistMemory();
    },
    [persistMemory],
  );

  // 消费一次导航 state 的 openView（AGENT「前往设置配置」等旧入口）。
  // 先于下面的启动初始化执行：设置加载完成前先暂存，加载完成后由初始化统一应用；
  // 消费后立刻 replace 清掉 state，刷新/回退不会重复触发。
  useEffect(() => {
    const state = location.state as { openView?: unknown } | null;
    if (!state || state.openView === undefined) return;
    const explicit = legacyOpenViewFromState(state);
    navigate(location.pathname, { replace: true, state: null });
    if (!explicit) return;
    if (!initializedRef.current) {
      explicitSelectionRef.current = explicit;
      return;
    }
    setSelection(explicit);
    setLeftDrawer(false);
    setRightDrawer(false);
  }, [location.pathname, location.state, navigate]);

  // 启动初始化：设置加载完成后执行一次，层级选择完全由 navMemory 决定。
  useEffect(() => {
    if (!settingsLoaded || initializedRef.current) return;
    initializedRef.current = true;

    const memory = memoryRef.current ?? createEmptyHomeMemory();
    memoryRef.current = memory;
    const explicit = explicitSelectionRef.current;
    explicitSelectionRef.current = null;
    const remember = settings.rememberUiState;

    setSelection(
      resolveHomeSelection({
        navMemory: settings.navMemory,
        memory,
        restoreFixed: remember,
        explicit,
      }),
    );

    if (remember) {
      // 恢复桌面侧栏开合；移动端只保留状态值，等宽到断点以上再显现（抽屉不记忆）。
      leftDirtyRef.current = true;
      rightDirtyRef.current = true;
      setLeftOpen(memory.leftOpen);
      setRightOpen(memory.rightOpen);
    } else {
      leftDirtyRef.current = false;
      rightDirtyRef.current = false;
      setLeftOpen(layout.canShowLeft);
      setRightOpen(layout.canShowRight);
    }
    setUiReady(true);
    // 只在设置加载完成时跑一次；之后用户在设置里改选项不打断当前界面。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  // 断点变化：用户没手动开关过时跟随「当前断点是否内联显示」，否则保留用户选择。
  useEffect(() => {
    if (!leftDirtyRef.current) setLeftOpen(layout.canShowLeft);
  }, [layout.canShowLeft]);

  useEffect(() => {
    if (!rightDirtyRef.current) setRightOpen(layout.canShowRight);
  }, [layout.canShowRight]);

  // 宽到能内联显示侧栏时关掉对应抽屉，避免旋转/放大后抽屉和侧栏同时出现。
  useEffect(() => {
    if (layout.canShowLeft) setLeftDrawer(false);
  }, [layout.canShowLeft]);

  useEffect(() => {
    if (layout.canShowRight) setRightDrawer(false);
  }, [layout.canShowRight]);

  // 层级选择记忆写盘（受 navMemory 策略控制；常驻项受 rememberUiState 控制）。
  useEffect(() => {
    if (!uiReady) return;
    const memory = memoryRef.current;
    if (!memory) return;
    const changed = recordNavSelection(memory, selection, {
      navMode: settings.navMemory,
      rememberUiState: settings.rememberUiState,
    });
    if (changed) persistMemory();
  }, [selection, uiReady, settings.navMemory, settings.rememberUiState, persistMemory]);

  // 桌面侧栏开合的记忆写盘（受 rememberUiState 控制）。
  useEffect(() => {
    if (!uiReady || !settings.rememberUiState) return;
    const memory = memoryRef.current;
    if (!memory) return;
    memory.leftOpen = leftOpen;
    persistMemory();
  }, [leftOpen, uiReady, settings.rememberUiState, persistMemory]);

  useEffect(() => {
    if (!uiReady || !settings.rememberUiState) return;
    const memory = memoryRef.current;
    if (!memory) return;
    memory.rightOpen = rightOpen;
    persistMemory();
  }, [rightOpen, uiReady, settings.rememberUiState, persistMemory]);

  // 滚动监听：document 捕获阶段能收到 <main> 内各滚动容器（含 Radix ScrollArea 视口）的
  // scroll 事件；按 DOM 索引路径记到当前中间页面（常驻项 / 入口子项）名下。
  useEffect(() => {
    const onScroll = (event: Event) => {
      if (!uiReadyRef.current || !rememberRef.current) return;
      const root = mainRef.current;
      const target = event.target;
      if (!root || !(target instanceof Element) || !root.contains(target)) return;
      const path = elementPathFromRoot(root, target);
      if (!path) return;
      const memory = memoryRef.current;
      if (!memory) return;
      const centerKey = centerKeyForSelection(selectionRef.current);
      if (recordScrollMemory(memory, centerKey, path, (target as HTMLElement).scrollTop)) {
        schedulePersist();
      }
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, [schedulePersist]);

  const centerKey = centerKeyForSelection(selection);

  // 中间页面切换后还原该页面的滚动位置：内容可能异步加载，未撑开高度时短暂重试；
  // 用户一旦手动滚动/触摸就放弃还原，避免和用户抢滚动。
  useEffect(() => {
    if (!uiReady || !rememberRef.current) return;
    const memory = memoryRef.current;
    if (!memory) return;
    const entries = readScrollMemory(memory, centerKey);
    if (entries.length === 0) return;

    let cancelled = false;
    let timer: number | null = null;
    let frame = 0;

    const stop = () => {
      cancelled = true;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener("wheel", onUserInput);
      window.removeEventListener("touchstart", onUserInput);
      window.removeEventListener("pointerdown", onUserInput);
    };
    const onUserInput = () => stop();

    window.addEventListener("wheel", onUserInput, { passive: true });
    window.addEventListener("touchstart", onUserInput, { passive: true });
    window.addEventListener("pointerdown", onUserInput, { passive: true });

    let attempts = 0;
    const attempt = () => {
      if (cancelled) return;
      if (!rememberRef.current) {
        stop();
        return;
      }
      const root = mainRef.current;
      if (!root) {
        stop();
        return;
      }
      let pending = false;
      for (const entry of entries) {
        const element = resolveElementPath(root, entry.path);
        if (!element) continue;
        if (Math.abs(element.scrollTop - entry.top) <= 1) continue;
        element.scrollTop = entry.top;
        // 内容还不够高时会被夹取到较小值，等 DOM 长高后重试。
        if (Math.abs(element.scrollTop - entry.top) > 1) pending = true;
      }
      attempts += 1;
      if (pending && attempts < SCROLL_RESTORE_MAX_ATTEMPTS) {
        timer = window.setTimeout(() => {
          timer = null;
          attempt();
        }, SCROLL_RESTORE_RETRY_MS);
      } else {
        stop();
      }
    };

    frame = requestAnimationFrame(() => {
      frame = 0;
      attempt();
    });
    return stop;
  }, [centerKey, uiReady]);

  useEffect(() => {
    if (!leftDrawer && !rightDrawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLeftDrawer(false);
        setRightDrawer(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leftDrawer, rightDrawer]);

  /** 某入口的记忆子项（没有记忆/不合法时用首项）。 */
  const rememberedChildFor = (parentId: HomeParentId): HomeChildId | null => {
    const remembered = memoryRef.current?.nav.children[parentId] ?? null;
    if (remembered && isChildOfParent(parentId, remembered)) return remembered;
    return firstNavChild(parentId)?.id ?? null;
  };

  /** 切换左入口：恢复该入口上次的子项（无记忆用首项），常驻项关闭。 */
  const selectParent = (parentId: HomeParentId) => {
    if (!isHomeParentId(parentId)) return;
    setSelection({ parent: parentId, child: rememberedChildFor(parentId), fixed: null });
    setLeftDrawer(false);
  };

  /** 切换右导览子项：入口不变，关闭移动端抽屉。 */
  const selectChild = (child: HomeNavChild) => {
    setSelection((current) => ({
      parent: current.parent,
      child: isChildOfParent(current.parent, child.id) ? child.id : current.child,
      fixed: null,
    }));
    setRightDrawer(false);
  };

  /** 打开常驻项（检索 / AGENT）：不改变左入口与子项。 */
  const openFixed = (fixed: HomeFixedGuideId) => {
    setSelection((current) => ({ ...current, fixed }));
    setLeftDrawer(false);
    setRightDrawer(false);
  };

  /** 设置分类在 SettingsContent 内部切换时，同步右面板子项选中。 */
  const handleSettingsCategoryChange = (category: SettingsCategory) => {
    setSelection((current) =>
      current.parent === "settings"
        ? { ...current, child: `settings.${category}`, fixed: null }
        : current,
    );
  };

  /** 导览检索 / AGENT 直达索引的跳转目标。 */
  const openGuideTarget = (target: HomeGuideTarget) => {
    setLeftDrawer(false);
    setRightDrawer(false);
    if (target.fixed) {
      // 常驻项不改变左入口。
      setSelection((current) => ({ ...current, fixed: target.fixed }));
      return;
    }
    const parentId: HomeParentId = isHomeParentId(target.parent) ? target.parent : "home";
    const fromCategory =
      parentId === "settings" && target.settingsCategory
        ? (`settings.${target.settingsCategory}` as HomeChildId)
        : null;
    const candidate = fromCategory ?? target.child;
    // target.child 为 null 表示「打开该入口的默认子项」，这里按首项处理（而不是上次记忆）。
    const child =
      candidate && isChildOfParent(parentId, candidate) ? candidate : firstNavChild(parentId)?.id ?? null;
    setSelection({ parent: parentId, child, fixed: null });
  };

  // 顶部/面板开合：桌面切内联栏，移动端切抽屉。收起操作只在面板栏头提供。
  const expandLeft = () => {
    if (layout.canShowLeft) {
      leftDirtyRef.current = true;
      setLeftOpen(true);
    } else {
      setLeftDrawer(true);
    }
  };

  const collapseLeft = () => {
    if (layout.canShowLeft) {
      leftDirtyRef.current = true;
      setLeftOpen(false);
    } else {
      setLeftDrawer(false);
    }
  };

  const expandRight = () => {
    if (layout.canShowRight) {
      rightDirtyRef.current = true;
      setRightOpen(true);
    } else {
      setRightDrawer(true);
    }
  };

  const collapseRight = () => {
    if (layout.canShowRight) {
      rightDirtyRef.current = true;
      setRightOpen(false);
    } else {
      setRightDrawer(false);
    }
  };

  const leftVisible = layout.canShowLeft ? leftOpen : leftDrawer;
  const rightVisible = layout.canShowRight ? rightOpen : rightDrawer;

  const openChapter = (bookId: string, chapterId: string) => {
    navigate(`/read/${bookId}/${chapterId}`, { state: { openSummary: true } });
  };

  const parent = HOME_PARENTS_BY_ID[selection.parent];

  const renderCenter = (): ReactNode => {
    if (selection.fixed === "search") return <HomeSearchView onOpen={openGuideTarget} />;
    if (selection.fixed === "agent") return <GuideAgentView onOpen={openGuideTarget} />;

    switch (selection.parent) {
      case "home":
        return selection.child === "home.knowledge" ? (
          <KnowledgeLibraryView books={books} library={library} onOpenChapter={openChapter} />
        ) : (
          <ShelfView />
        );
      case "import":
        return <ImportExportView kind="import" section={importExportSectionForChild(selection.child)} />;
      case "export":
        return <ImportExportView kind="export" section={importExportSectionForChild(selection.child)} />;
      case "about":
        switch (selection.child) {
          case "about.changelog":
            return <AboutChangelogView />;
          case "about.roadmap":
            return <AboutRoadmapView />;
          case "about.detail":
          default:
            return <AboutDetailView />;
        }
      case "settings":
        return (
          <div className="h-full overflow-y-auto px-5 py-6 sm:px-8">
            <SettingsContent
              category={settingsCategoryForChild(selection.child)}
              onCategoryChange={handleSettingsCategoryChange}
              showHeader={false}
            />
          </div>
        );
      case "emergence":
        return <EmergenceView />;
      case "guide":
        return <GuideView />;
      default:
        return (
          <PlaceholderPage
            title={parent?.placeholder?.title ?? "首页"}
            description={parent?.placeholder?.description ?? "这个入口还在规划中。"}
            planLabel="规划中"
          />
        );
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-paper text-ink">
      {layout.canShowLeft && leftOpen ? (
        <>
          <aside
            id="home-left-pane"
            data-pane="left"
            style={{ width: leftPane.width }}
            className="flex h-full min-h-0 shrink-0 flex-col border-r border-border/70 bg-paper-soft/50"
          >
            <HomePaneHeader
              title="入口"
              closeLabel="收起入口面板"
              closeIcon={PanelLeftClose}
              onClose={collapseLeft}
            />
            <HomeEntryPanel activeParent={selection.parent} onSelectParent={selectParent} />
          </aside>
          <PaneResizer
            side="left"
            controls={leftPane}
            label="调整入口面板宽度"
            controlsTargetId="home-left-pane"
            className="block"
          />
        </>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <HomeTopBar
          leftCollapsed={!leftVisible}
          rightCollapsed={!rightVisible}
          onExpandLeft={expandLeft}
          onExpandRight={expandRight}
        />
        <main
          ref={mainRef}
          key={centerKey}
          data-home-view={centerKey}
          className={cn("flex min-h-0 min-w-0 flex-1 flex-col")}
        >
          {uiReady ? (
            renderCenter()
          ) : (
            <div className="flex flex-1 items-center justify-center text-ink-soft" aria-busy="true">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              <span className="sr-only">正在准备界面…</span>
            </div>
          )}
        </main>
      </div>

      {layout.canShowRight && rightOpen ? (
        <>
          <PaneResizer
            side="right"
            controls={rightPane}
            label="调整导览面板宽度"
            controlsTargetId="home-right-pane"
            className="block"
          />
          <aside
            id="home-right-pane"
            data-pane="right"
            style={{ width: rightPane.width }}
            className="flex h-full min-h-0 shrink-0 flex-col border-l border-border/70 bg-paper-soft/40"
          >
            <HomePaneHeader
              title="导览"
              closeLabel="收起导览面板"
              closeIcon={PanelRightClose}
              onClose={collapseRight}
              reverse
            />
            <HomeGuidePanel
              parent={parent}
              selection={selection}
              onSelectChild={selectChild}
              onOpenFixed={openFixed}
            />
          </aside>
        </>
      ) : null}

      {leftDrawer ? (
        <div
          className="fixed inset-0 z-50 flex bg-ink/30"
          role="presentation"
          onClick={() => setLeftDrawer(false)}
        >
          <aside
            className="flex h-full w-[min(19rem,86vw)] flex-col border-r border-border bg-paper shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <HomePaneHeader
              title="入口"
              closeLabel="收起入口面板"
              closeIcon={PanelLeftClose}
              onClose={() => setLeftDrawer(false)}
            />
            <HomeEntryPanel activeParent={selection.parent} onSelectParent={selectParent} />
          </aside>
        </div>
      ) : null}

      {rightDrawer ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-ink/30"
          role="presentation"
          onClick={() => setRightDrawer(false)}
        >
          <aside
            className="flex h-full w-[min(20rem,88vw)] flex-col border-l border-border bg-paper shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <HomePaneHeader
              title="导览"
              closeLabel="收起导览面板"
              closeIcon={PanelRightClose}
              onClose={() => setRightDrawer(false)}
              reverse
            />
            <HomeGuidePanel
              parent={parent}
              selection={selection}
              onSelectChild={selectChild}
              onOpenFixed={openFixed}
            />
          </aside>
        </div>
      ) : null}
    </div>
  );
}
