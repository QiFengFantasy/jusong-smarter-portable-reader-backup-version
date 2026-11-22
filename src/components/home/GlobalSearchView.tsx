import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  BookMarked,
  BookOpen,
  ChevronsDown,
  CornerDownLeft,
  LibraryBig,
  Loader2,
  Search,
  Square,
  UserRound,
  X,
} from "lucide-react";
import type { GlobalSearchHit, GlobalSearchKind } from "@jusong/core";

import { HeroArt } from "../brand/HeroArt";
import { Button } from "../ui/button";
import {
  homeGuideEntryLocation,
  homeGuideTarget,
  searchHomeGuide,
  type HomeGuideEntry,
  type HomeGuideTarget,
} from "../../lib/home-guide";
import { useLibrary } from "../../lib/library";
import { describeSearchScope, parseSearchScopeSpec } from "../../lib/searchScope";
import { useSettings } from "../../lib/settings";
import { searchHitKey, useGlobalSearch } from "../../lib/useGlobalSearch";
import { cn } from "../../lib/utils";

const KINDS: GlobalSearchKind[] = ["book", "author", "chapter", "knowledge"];

const KIND_META: Record<GlobalSearchKind, { label: string; icon: typeof BookOpen }> = {
  book: { label: "书名", icon: LibraryBig },
  author: { label: "作者", icon: UserRound },
  chapter: { label: "正文", icon: BookOpen },
  knowledge: { label: "知识库", icon: BookMarked },
};

/** 搜索框内的「界面入口」开关：开启后仅检索界面入口/子项/设置项，关闭后仅检索内容。 */
export interface GlobalSearchInterfaceToggle {
  active: boolean;
  onToggle: () => void;
  /** 界面检索命中后的跳转目标。 */
  onOpen: (target: HomeGuideTarget) => void;
}

interface GlobalSearchViewProps {
  onOpenHit: (hit: GlobalSearchHit) => void;
  /** 可选：在搜索框内显示「界面入口」开关（首页常驻检索使用）。 */
  interfaceSearch?: GlobalSearchInterfaceToggle;
}

/** 圆形扫描进度：SVG ring + 百分比；总章节未知（total=0）时显示不确定进度。 */
function ScanRing({ percent, indeterminate }: { percent: number; indeterminate: boolean }) {
  const radius = 15.5;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const dash = indeterminate ? circumference * 0.28 : (clamped / 100) * circumference;
  return (
    <span
      role="progressbar"
      aria-label="检索扫描进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : clamped}
      aria-valuetext={indeterminate ? "正在准备扫描" : `已扫描 ${clamped}%`}
      className="relative grid h-10 w-10 shrink-0 place-items-center"
    >
      <svg
        viewBox="0 0 36 36"
        className={cn("h-10 w-10 -rotate-90", indeterminate && "motion-safe:animate-spin")}
        aria-hidden="true"
      >
        <circle cx="18" cy="18" r={radius} fill="none" strokeWidth="3" className="stroke-muted" />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          className="stroke-cinnabar transition-[stroke-dasharray] duration-200"
          strokeDasharray={`${dash} ${circumference}`}
        />
      </svg>
      <span
        className="absolute inset-0 grid place-items-center text-[9px] font-medium tabular-nums text-ink-soft"
        aria-hidden="true"
      >
        {indeterminate ? "" : `${clamped}%`}
      </span>
    </span>
  );
}

function ResultCard({ hit, onOpen }: { hit: GlobalSearchHit; onOpen: () => void }) {
  const meta = KIND_META[hit.kind];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${meta.label}结果：${hit.title}（${hit.bookTitle}）`}
      className="block w-full rounded-lg border border-border bg-paper-soft/60 px-3.5 py-3 text-left transition-colors hover:border-cinnabar/40 hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
    >
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-sm border border-cinnabar/25 bg-cinnabar/5 px-1.5 py-0.5 text-[10px] text-cinnabar">
          <Icon className="h-2.5 w-2.5" aria-hidden="true" />
          {meta.label}
        </span>
        <span className="font-serif text-sm font-semibold tracking-wide text-ink">{hit.title}</span>
        {hit.kind === "author" && hit.author ? (
          <span className="text-[11px] text-cinnabar/80">作者：{hit.author}</span>
        ) : null}
        {hit.bookTitle && hit.bookTitle !== hit.title ? (
          <span className="text-[11px] text-ink-soft/70">{hit.bookTitle}</span>
        ) : null}
        {hit.chapterTitle && hit.chapterTitle !== hit.title ? (
          <span className="text-[11px] text-ink-soft/60">· {hit.chapterTitle}</span>
        ) : null}
      </span>
      <span className="mt-1.5 line-clamp-2 block text-xs leading-6 text-ink-soft">
        {hit.snippet}
      </span>
    </button>
  );
}

/** 界面检索结果：同一检索页内切换，不跳转子页面；点击条目直接打开对应界面。 */
function InterfaceSearchResults({
  query,
  results,
  onOpen,
}: {
  query: string;
  results: HomeGuideEntry[] | null;
  onOpen: (target: HomeGuideTarget) => void;
}) {
  if (!query) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-border bg-paper-soft/40 px-6 py-10 text-center">
        <p className="font-serif text-lg tracking-wide text-ink">界面入口检索</p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-ink-soft">
          输入关键词，检索首页入口、导览子项与设置项，点击结果直接跳转；本模式不检索书内正文。关闭「界面入口」开关即可回到内容检索。
        </p>
      </div>
    );
  }
  if (!results || results.length === 0) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-ink-soft">
        没有找到与「{query}」匹配的入口、子项或设置项；可试试「外观」「强调色」「API Key」。
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-xs text-ink-soft">
        「{query}」命中 <b className="text-ink">{results.length}</b> 个可跳转条目
      </p>
      <ul aria-label="可跳转的首页条目" className="mt-2 space-y-1.5">
        {results.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onOpen(homeGuideTarget(entry))}
              className="flex w-full items-start gap-3 rounded-lg border border-border/70 bg-paper-soft/50 px-3 py-2.5 text-left transition-colors hover:border-cinnabar/40 hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
            >
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-cinnabar/10 text-cinnabar">
                <Search className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-serif text-sm font-semibold tracking-wide text-ink">{entry.label}</span>
                  <span className="text-[10px] text-ink-soft/60">{homeGuideEntryLocation(entry)}</span>
                </span>
                {entry.description ? (
                  <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-ink-soft">
                    {entry.description}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 检索视图：装饰 Hero + 搜索条 + 覆盖提示（已检索 N/M 本 + 查找更多 + 圆形进度）
 * + 可切换分类标签（书名 / 作者 / 正文 / 知识库）的结果列表。
 *
 * 范围配置来自设置（`settings.searchScope`）：先扫最近阅读的前 N 本，书名/作者始终全库匹配，
 * 「查找更多」按设置档位逐步扩大；知识库命中随正文一并扩大。
 */
export function GlobalSearchView({ onOpenHit, interfaceSearch }: GlobalSearchViewProps) {
  const { books, status } = useLibrary();
  const { settings } = useSettings();
  const scope = useMemo(() => parseSearchScopeSpec(settings.searchScope), [settings.searchScope]);
  const { query, results, running, phase, scanned, total, error, cancelled, coverage, run, findMore, cancel } =
    useGlobalSearch({ books, scope });
  const libraryReady = status === "ready";

  const [draft, setDraft] = useState("");
  const [activeKind, setActiveKind] = useState<GlobalSearchKind | null>(null);
  const tabRefs = useRef<Partial<Record<GlobalSearchKind, HTMLButtonElement | null>>>({});
  const [guideQuery, setGuideQuery] = useState("");
  const [guideResults, setGuideResults] = useState<HomeGuideEntry[] | null>(null);
  const interfaceActive = Boolean(interfaceSearch?.active);

  const counts = useMemo(() => {
    const map: Record<GlobalSearchKind, number> = { book: 0, author: 0, chapter: 0, knowledge: 0 };
    for (const hit of results) map[hit.kind] += 1;
    return map;
  }, [results]);

  const firstNonEmptyKind = useMemo(
    () => KINDS.find((kind) => counts[kind] > 0) ?? null,
    [counts],
  );

  // 默认选中第一个非空分类；当前分类被新结果清空时自动回到第一个非空分类。
  useEffect(() => {
    if (!firstNonEmptyKind) {
      setActiveKind(null);
      return;
    }
    setActiveKind((previous) => (previous && counts[previous] > 0 ? previous : firstNonEmptyKind));
  }, [counts, firstNonEmptyKind]);

  const currentKind =
    activeKind && counts[activeKind] > 0 ? activeKind : firstNonEmptyKind;
  const currentHits = useMemo(
    () => (currentKind ? results.filter((hit) => hit.kind === currentKind) : []),
    [results, currentKind],
  );

  const percent = total > 0 ? Math.min(100, Math.round((scanned / total) * 100)) : 0;
  const idle = !running && results.length === 0 && !error && !query;
  const noResults = !running && results.length === 0 && !error && Boolean(query);
  const scopeDescription = describeSearchScope(scope);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (interfaceActive) {
      setGuideQuery(text);
      setGuideResults(text ? searchHomeGuide(text) : null);
      return;
    }
    if (!libraryReady) return;
    setGuideQuery("");
    setGuideResults(null);
    void run(draft);
  };

  /** 切换「界面入口」：开启时取消进行中的内容扫描，并清掉内容结果展示。 */
  const handleToggleInterface = () => {
    if (!interfaceSearch) return;
    if (!interfaceActive) {
      void cancel();
      setGuideQuery("");
      setGuideResults(null);
    }
    interfaceSearch.onToggle();
  };

  // 关闭界面模式时清空界面检索结果，回到内容检索。
  useEffect(() => {
    if (!interfaceActive) {
      setGuideQuery("");
      setGuideResults(null);
    }
  }, [interfaceActive]);

  const clearDraft = () => {
    setDraft("");
  };

  const moveTab = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, kind: GlobalSearchKind) => {
      const enabled = KINDS.filter((candidate) => counts[candidate] > 0);
      const index = enabled.indexOf(kind);
      if (index < 0) return;
      let nextIndex = index;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          nextIndex = (index + 1) % enabled.length;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          nextIndex = (index - 1 + enabled.length) % enabled.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = enabled.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextKind = enabled[nextIndex];
      setActiveKind(nextKind);
      tabRefs.current[nextKind]?.focus();
    },
    [counts],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="relative overflow-hidden border-b border-border/60 px-5 py-6 sm:px-8 sm:py-8">
        <HeroArt variant="compact" />
        <div className="relative max-w-2xl">
          <p className="text-[10px] uppercase tracking-[0.42em] text-cinnabar/80">JUSONG · 检索</p>
          <h1 className="mt-2 font-serif text-2xl font-semibold tracking-wide sm:text-3xl">
            从字里行间，打捞一处出处。
          </h1>
          <p className="mt-2 max-w-xl text-xs leading-6 text-ink-soft">
            {interfaceActive
              ? "检索首页入口、导览子项与设置项，点击结果直接跳转；本模式只做界面导航检索，不扫描书内正文。"
              : "先检索最近阅读的书籍，书名与作者始终在全库范围内匹配；可逐档扩大正文与知识库的扫描范围。扫描只在本机按需进行，不建立索引。"}
          </p>

          <form onSubmit={submit} className="mt-5 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft/60"
                aria-hidden="true"
              />
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="输入关键词，例如：湖南、阶级斗争、广州"
                aria-label="全局检索关键词"
                className="h-11 w-full rounded-md border border-border bg-paper pl-9 pr-9 text-sm text-ink placeholder:text-ink-soft/50 focus:outline-none focus:ring-2 focus:ring-cinnabar/30"
              />
              {draft ? (
                <button
                  type="button"
                  onClick={clearDraft}
                  aria-label="清空检索输入"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-soft/60 hover:bg-muted/70 hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <Button type="submit" className="h-11" disabled={!draft.trim() || running || !libraryReady}>
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="h-4 w-4" aria-hidden="true" />
              )}
              {running ? "检索中" : "检索"}
            </Button>
            {running ? (
              <Button type="button" variant="outline" className="h-11" onClick={() => void cancel()}>
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                取消
              </Button>
            ) : null}
            {interfaceSearch ? (
              <Button
                type="button"
                variant={interfaceSearch.active ? "default" : "outline"}
                className="h-11"
                aria-pressed={interfaceSearch.active}
                title="开启后检索首页入口、导览子项与设置项（不检索书内正文）"
                onClick={handleToggleInterface}
              >
                界面入口
              </Button>
            ) : null}
          </form>

          {!interfaceActive && !libraryReady ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-soft/80"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {status === "initializing" ? "书库正在加载，稍后即可检索…" : "书库未就绪，检索暂不可用。"}
            </p>
          ) : null}

          {!interfaceActive && query ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-border/80 bg-paper-soft/50 px-3 py-2">
              <span className="text-[11px] text-ink-soft">
                已检索{" "}
                <b className="font-serif text-[13px] font-semibold text-ink">
                  {coverage.coveredBooks}
                </b>
                <span className="text-ink-soft/70"> / {coverage.totalBooks} 本</span>
              </span>
              <span
                className="hidden text-[11px] text-ink-soft/60 sm:inline"
                title={scopeDescription}
              >
                最近阅读优先
              </span>
              {coverage.nextTier !== null && !running ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void findMore()}
                    className="h-7 gap-1 px-2 text-[11px]"
                    aria-label={`查找更多：把范围扩大到 ${coverage.nextTier} 本`}
                  >
                    <ChevronsDown className="h-3 w-3" aria-hidden="true" />
                    查找更多
                    <span className="text-ink-soft/60">
                      +{Math.max(1, coverage.nextTier - coverage.coveredBooks)} 本
                    </span>
                  </Button>
                  <span className="text-[10px] text-ink-soft/50">
                    {coverage.nextTier >= coverage.totalBooks
                      ? "覆盖全部书籍"
                      : `扩大到 ${coverage.nextTier} 本`}
                  </span>
                </>
              ) : null}
              {running ? (
                <span className="ml-auto flex items-center gap-2">
                  <ScanRing percent={percent} indeterminate={total === 0} />
                  <span role="status" aria-live="polite" className="text-[11px] text-ink-soft">
                    {total > 0
                      ? `${phase === "more" ? "扩大检索" : "正在扫描"} ${scanned} / ${total} 章`
                      : "正在准备扫描…"}
                  </span>
                </span>
              ) : cancelled ? (
                <span className="ml-auto text-[11px] text-ink-soft/70">已取消，显示已扫描部分</span>
              ) : null}
            </div>
          ) : null}

          {!interfaceActive && error ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-cinnabar/25 bg-cinnabar/5 px-3 py-2 text-xs leading-5 text-cinnabar"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 px-5 py-5 sm:px-8">
        {interfaceActive ? (
          <InterfaceSearchResults
            query={guideQuery}
            results={guideResults}
            onOpen={interfaceSearch?.onOpen ?? (() => undefined)}
          />
        ) : null}
        {!interfaceActive && idle ? (
          <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-border bg-paper-soft/40 px-6 py-12 text-center">
            <span className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-cinnabar/20 bg-cinnabar/5 text-cinnabar">
              <CornerDownLeft className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="mt-3 font-serif text-lg tracking-wide text-ink">检索范围</p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-ink-soft">
              书名、作者、章节标题、章节正文与知识库档案都会参与匹配。输入关键词后先扫描最近阅读的书籍，再按需「查找更多」扩大范围。
            </p>
            <p className="mx-auto mt-3 max-w-md rounded-md border border-dashed border-border/80 bg-paper/60 px-3 py-2 text-[11px] leading-5 text-ink-soft/80">
              当前范围：{scopeDescription}
            </p>
          </div>
        ) : null}

        {!interfaceActive && noResults ? (
          <div className="mx-auto max-w-2xl rounded-xl border border-dashed border-border px-6 py-10 text-center text-sm text-ink-soft">
            {coverage.totalBooks === 0 ? (
              <p>书库还没有可检索的书籍。</p>
            ) : (
              <>
                <p>
                  没有找到与「{query}」相关的内容；已检索 {coverage.coveredBooks} /{" "}
                  {coverage.totalBooks} 本。
                </p>
                {coverage.nextTier !== null ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void findMore()}
                  >
                    <ChevronsDown className="h-3.5 w-3.5" aria-hidden="true" />
                    查找更多（扩大到 {coverage.nextTier} 本）
                  </Button>
                ) : (
                  <p className="mt-2 text-xs text-ink-soft/70">已覆盖书库全部书籍。</p>
                )}
              </>
            )}
          </div>
        ) : null}

        {!interfaceActive && results.length > 0 && currentKind ? (
          <div className="mx-auto max-w-4xl">
            <p className="text-xs text-ink-soft">
              「{query}」命中 <b className="text-ink">{results.length}</b> 条
              {running ? "，仍在扩大检索…" : ""}
            </p>

            <div
              role="tablist"
              aria-label="检索结果分类"
              className="mt-2 flex flex-wrap items-center gap-1 border-b border-border/60 pb-1"
            >
              {KINDS.map((kind) => {
                const meta = KIND_META[kind];
                const Icon = meta.icon;
                const count = counts[kind];
                const disabled = count === 0;
                const selected = currentKind === kind;
                return (
                  <button
                    key={kind}
                    ref={(element) => {
                      tabRefs.current[kind] = element;
                    }}
                    type="button"
                    role="tab"
                    id={`search-tab-${kind}`}
                    aria-selected={selected}
                    aria-controls={`search-panel-${kind}`}
                    aria-disabled={disabled || undefined}
                    disabled={disabled}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setActiveKind(kind)}
                    onKeyDown={(event) => moveTab(event, kind)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30",
                      selected
                        ? "border-cinnabar text-cinnabar"
                        : "border-transparent text-ink-soft hover:text-ink",
                      disabled && "cursor-not-allowed opacity-40 hover:text-ink-soft",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {meta.label}
                    <span
                      className={cn(
                        "text-[10px]",
                        selected ? "text-cinnabar/70" : "text-ink-soft/50",
                      )}
                    >
                      ({count})
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              role="tabpanel"
              id={`search-panel-${currentKind}`}
              aria-labelledby={`search-tab-${currentKind}`}
              className="mt-3 space-y-2"
            >
              {currentHits.map((hit) => (
                <ResultCard
                  key={searchHitKey(hit)}
                  hit={hit}
                  onOpen={() => onOpenHit(hit)}
                />
              ))}
              {running ? (
                <p role="status" aria-live="polite" className="pt-1 text-[11px] text-ink-soft/70">
                  {phase === "more" ? "正在扩大检索范围…" : "正在扫描…"}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
