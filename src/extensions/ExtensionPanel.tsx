import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import "./map/map.css";
import "./extension.css";

import type { BookMeta } from "@jusong/core";
import { Bot, CalendarClock, CircleHelp, Map as MapIcon, Sparkles, X } from "lucide-react";

import { AgentConsole } from "../components/agent/AgentConsole";
import type { AgentPrefillInput } from "../components/agent/AgentComposer";
import { ReaderTabBar, type ReaderTabItem } from "../components/reader/ReaderTabBar";
import { Button } from "../components/ui/button";
import {
  buildExploreAgentPrompt,
  exploreMissingCopy,
  useChapterExplore,
  type ExploreMissingKind,
  type ExplorePromptAction,
} from "../lib/explore";
import { useLibrary } from "../lib/library";
import { READER_PANE_TITLES } from "../lib/paneResize";
import { useSettings } from "../lib/settings";
import { MapCanvas } from "./map/MapCanvas";
import type { MapLanguage } from "./map/mapTiles";
import { TimelineView } from "./TimelineView";
import { useBookTopics } from "./useBookTopics";
import { useChapterDossier } from "./useChapterDossier";

/** 探索面板标签：地图/时间线按本章 explore 数据动态出现，「其他」只在缺数据时出现，AGENT 始终最后。 */
export type ExtensionTab = "map" | "timeline" | "other" | "agent";

/** 程序化切标签请求：`nonce` 变化时生效（阅读器划词引用后需要直接打开 AGENT）。 */
export interface ExtensionTabRequest {
  tab: ExtensionTab;
  nonce: number;
}

/** 划词引用到 AGENT 的文本；`nonce` 变化时 AgentConsole 把引用插入输入区（不自动发送）。 */
export interface AgentQuote {
  text: string;
  chapterId?: string;
  chapterTitle?: string;
  nonce: number;
}

interface ExtensionPanelProps {
  bookId: string;
  bookTitle?: string;
  chapterId?: string;
  chapterTitle?: string;
  book?: BookMeta | null;
  /** 当前章正文前 ~1200 字，供 AGENT「插入当前章节」使用（默认不自动附带）。 */
  excerpt?: string;
  /** 由外部（阅读器划词）请求切换到某个标签。 */
  tabRequest?: ExtensionTabRequest | null;
  /** 由外部（阅读器划词）传入的引用文本。 */
  quote?: AgentQuote | null;
  className?: string;
}

const TAB_LABELS: Record<ExtensionTab, string> = {
  map: "地图",
  timeline: "时间线",
  other: "其他",
  agent: "AGENT",
};

const TAB_ICONS: Record<ExtensionTab, typeof MapIcon> = {
  map: MapIcon,
  timeline: CalendarClock,
  other: CircleHelp,
  agent: Bot,
};

/** 「其他」卡片 → AGENT 时记录最近一次请求，用于输入框上方的轻提示。 */
interface AgentPromptHint {
  kind: ExploreMissingKind;
  action: ExplorePromptAction;
}

/**
 * 「其他」面板：只列缺失的探索项（地图/时间线）。
 * 每张卡 = 一个缺失项，右侧「更新」「添加」交给 AGENT 预填提示词，不伪造数据。
 */
function OtherExplorerPanel({
  missing,
  error,
  hint,
  onRequestAgent,
}: {
  missing: ExploreMissingKind[];
  error: string | null;
  hint: string | null;
  onRequestAgent: (kind: ExploreMissingKind, action: ExplorePromptAction) => void;
}) {
  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 pb-8 pt-4">
      <div className="flex items-center gap-2">
        <CircleHelp className="h-4 w-4 text-cinnabar" aria-hidden="true" />
        <h2 className="font-serif text-sm font-semibold tracking-[0.2em] text-ink-soft">其他</h2>
      </div>
      <p className="mt-1 text-[11px] leading-5 text-ink-soft/70">
        探索面板按本章展示地图与时间线；缺少的数据可交给 AGENT 补充，不会自动生成，也不伪造数据。
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-md border border-cinnabar/25 bg-cinnabar/5 px-2.5 py-2 text-[11px] leading-5 text-cinnabar"
        >
          本章探索数据读取失败：{error}
        </p>
      ) : null}

      {hint ? (
        <p
          role="status"
          className="mt-3 rounded-md border border-cinnabar/25 bg-cinnabar/5 px-2.5 py-2 text-[11px] leading-5 text-ink-soft"
        >
          {hint}
        </p>
      ) : null}

      {missing.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-border/80 bg-paper/50 px-3 py-3 text-center text-[11px] leading-5 text-ink-soft/70">
          本章的地图与时间线数据都已就绪。
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {missing.map((kind) => {
            const copy = exploreMissingCopy(kind);
            return (
              <li key={kind}>
                <div className="rounded-lg border border-border/80 bg-paper/70 p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="block font-serif text-sm font-semibold leading-snug text-ink">
                        {copy.title}
                      </span>
                      <p className="mt-1 text-[11px] leading-5 text-ink-soft">{copy.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => onRequestAgent(kind, "update")}
                        title="打开 AGENT 并预填「更新」提示词（不自动发送）"
                      >
                        更新
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[11px] text-cinnabar hover:bg-cinnabar/10"
                        onClick={() => onRequestAgent(kind, "add")}
                        title="打开 AGENT 并预填「添加」提示词（不自动发送）"
                      >
                        添加
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 text-[10px] leading-5 text-ink-soft/55">
        提示：AGENT 只生成建议，数据写入仍需逐条确认，避免把推测当成书中事实。
      </p>
    </div>
  );
}

export function ExtensionPanel({
  bookId,
  bookTitle,
  chapterId,
  chapterTitle,
  excerpt,
  tabRequest,
  quote,
  className,
}: ExtensionPanelProps) {
  const { library } = useLibrary();
  const { settings } = useSettings();
  const topics = useBookTopics(library, bookId);
  const { dossier, loading: dossierLoading } = useChapterDossier(library, bookId, chapterId);
  const exploreState = useChapterExplore(library, bookId, chapterId);
  const [tab, setTab] = useState<ExtensionTab>("map");
  const [mapLanguage, setMapLanguage] = useState<MapLanguage>(() => {
    if (typeof window === "undefined") return "zh";
    return window.localStorage.getItem("jusong.mapLanguage") === "en" ? "en" : "zh";
  });
  const [eventFocus, setEventFocus] = useState<{ lon: number; lat: number; zoom?: number } | null>(null);
  /** 「其他」卡片 → AGENT：提示词预填请求（nonce 变化才应用）。 */
  const [agentPrefill, setAgentPrefill] = useState<AgentPrefillInput | null>(null);
  const [agentHint, setAgentHint] = useState<AgentPromptHint | null>(null);
  /** 用户/外部是否显式选过标签：未显式选择时数据收敛按「第一项可用」走，不落到「其他」。 */
  const tabPinnedRef = useRef(false);
  const selectTab = useCallback((next: ExtensionTab) => {
    tabPinnedRef.current = true;
    // 离开 AGENT 时清掉一次性预填/提示：再次进入不会覆盖用户重新输入的草稿。
    if (next !== "agent") {
      setAgentPrefill(null);
      setAgentHint(null);
    }
    setTab(next);
  }, []);

  // explore 读取中（且没有旧数据）时先乐观展示地图/时间线，读完再按实际数据收敛 tab 集合，
  // 避免先闪一下「其他」；缓存命中时 loading 为 false，不会闪。
  const exploreResolved = !exploreState.loading || exploreState.explore !== null;
  const hasMap = exploreResolved ? exploreState.hasMap : true;
  const hasTimeline = exploreResolved ? exploreState.hasTimeline : true;

  const visibleTabs = useMemo<ExtensionTab[]>(() => {
    const ids: ExtensionTab[] = [];
    if (hasMap) ids.push("map");
    if (hasTimeline) ids.push("timeline");
    if (!hasMap || !hasTimeline) ids.push("other");
    ids.push("agent");
    return ids;
  }, [hasMap, hasTimeline]);

  const tabs = useMemo<ReaderTabItem<ExtensionTab>[]>(
    () => visibleTabs.map((id) => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id] })),
    [visibleTabs],
  );

  const missingKinds = useMemo<ExploreMissingKind[]>(() => {
    const kinds: ExploreMissingKind[] = [];
    if (!exploreResolved) return kinds;
    if (!exploreState.hasMap) kinds.push("map");
    if (!exploreState.hasTimeline) kinds.push("timeline");
    return kinds;
  }, [exploreResolved, exploreState.hasMap, exploreState.hasTimeline]);

  // 外部请求切标签（如阅读器划词引用 → 直接打开 AGENT）。
  const tabRequestNonce = tabRequest?.nonce ?? 0;
  useEffect(() => {
    if (tabRequest) selectTab(tabRequest.tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabRequestNonce]);

  // 当前标签不可用（本章没有该项数据）时收敛到可见标签：
  // - 用户/外部显式选过 map/timeline 但缺数据 → 落到「其他」，让用户看到缺失说明；
  // - 只是默认初始标签不可用 → 选第一项可用（有地图选地图、否则时间线…），不抢先落到「其他」。
  useEffect(() => {
    if (visibleTabs.includes(tab)) return;
    if (
      tabPinnedRef.current &&
      (tab === "map" || tab === "timeline") &&
      visibleTabs.includes("other")
    ) {
      setTab("other");
      return;
    }
    setTab(visibleTabs[0] ?? "agent");
  }, [visibleTabs, tab]);

  useEffect(() => {
    setEventFocus(null);
    setAgentPrefill(null);
    setAgentHint(null);
  }, [chapterId]);

  const toggleLanguage = () => {
    setMapLanguage((current) => {
      const next: MapLanguage = current === "zh" ? "en" : "zh";
      try {
        window.localStorage.setItem("jusong.mapLanguage", next);
      } catch {
        // 忽略隐私模式下的 localStorage 失败
      }
      return next;
    });
  };

  const explore = exploreState.explore;
  const exploreMap = explore?.map ?? null;
  const mapData = topics.map;
  const writingPlaceIds = dossier?.writing?.placeIds ?? [];

  // 地图：用本章 explore.map 的 placeIds/routeIds 从整书 topics 解析（不再依赖档案筛选）。
  const mapView = useMemo(() => {
    if (!mapData || !exploreMap) {
      return { places: [], routes: [], activeRouteIds: [] as string[] };
    }
    const routeIds = new Set(exploreMap.routeIds);
    const placeIds = new Set(exploreMap.placeIds);
    for (const route of mapData.routes.features) {
      if (!routeIds.has(route.properties.id)) continue;
      for (const id of route.properties.placeIds ?? []) placeIds.add(id);
    }
    return {
      places: mapData.places.filter((place) => placeIds.has(place.id)),
      routes: mapData.routes.features.filter((route) => routeIds.has(route.properties.id)),
      activeRouteIds: [...routeIds],
    };
  }, [mapData, exploreMap]);

  /** 地图焦点：explore 优先 → 旧档案焦点兜底 → 单个地点/写作地点。 */
  const mapFocus = useMemo(() => {
    if (!mapData) return null;
    if (exploreMap?.focus) return exploreMap.focus;
    if (dossier?.map?.focus) return dossier.map.focus;
    const writingPlace = mapData.places.find((place) => writingPlaceIds.includes(place.id));
    const singlePlace = mapView.places.length === 1 ? mapView.places[0] : null;
    const place = writingPlace ?? singlePlace;
    return place ? { lon: place.lon, lat: place.lat, zoom: 7 } : null;
  }, [mapData, exploreMap, dossier, writingPlaceIds, mapView.places]);

  const placeNames = useMemo(
    () => new Map((mapData?.places ?? []).map((place) => [place.id, place.name])),
    [mapData],
  );

  const focusPlace = useCallback(
    (placeId: string) => {
      const place = mapData?.places.find((item) => item.id === placeId);
      if (!place) return;
      setEventFocus({ lon: place.lon, lat: place.lat, zoom: 8 });
      // 本章有地图数据时才联动切到地图；没有地图时保持在时间线，避免跳到「其他」。
      if (visibleTabs.includes("map")) selectTab("map");
    },
    [mapData, visibleTabs, selectTab],
  );

  const requestAgentFor = useCallback(
    (kind: ExploreMissingKind, action: ExplorePromptAction) => {
      const prompt = buildExploreAgentPrompt({ kind, action, bookTitle, chapterTitle, chapterId });
      setAgentPrefill({ text: prompt, nonce: Date.now() });
      setAgentHint({ kind, action });
      selectTab("agent");
    },
    [bookTitle, chapterTitle, chapterId, selectTab],
  );

  const timelineEventIds = explore?.timeline?.eventIds ?? [];
  const writingDate = dossier?.writing?.date;
  const agentHintCopy = agentHint
    ? `已把「${exploreMissingCopy(agentHint.kind).title} · ${agentHint.action === "update" ? "更新" : "添加"}」提示词填入 AGENT 输入框，可修改后发送；数据不会自动写入。`
    : null;

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ""}`}>
      <ReaderTabBar<ExtensionTab>
        ariaLabel={READER_PANE_TITLES.right}
        tabs={tabs}
        active={tab}
        onChange={selectTab}
        minTabWidth={settings.readerRightTabMinWidth}
        toolbarSide="right"
      />

      <div className="min-h-0 flex-1">
        {tab === "agent" ? (
          <div className="flex h-full min-h-0 flex-col">
            {agentHint ? (
              <div
                role="status"
                className="flex shrink-0 items-start gap-2 border-b border-border/70 bg-cinnabar/5 px-3 py-2 text-[11px] leading-5 text-ink-soft"
              >
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cinnabar" aria-hidden="true" />
                <p className="min-w-0 flex-1">{agentHintCopy}</p>
                <button
                  type="button"
                  onClick={() => setAgentHint(null)}
                  aria-label="关闭提示"
                  className="shrink-0 rounded p-0.5 text-ink-soft/70 hover:bg-paper hover:text-ink"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <AgentConsole
              compact
              className="min-h-0 flex-1"
              context={{ bookId, bookTitle, chapterId, chapterTitle, excerpt }}
              quote={quote ?? undefined}
              prefill={agentPrefill ?? undefined}
            />
          </div>
        ) : null}

        {tab === "map" ? (
          <div className="relative h-full min-h-[320px]">
            {mapData ? (
              <MapCanvas
                places={mapView.places}
                routes={mapView.routes}
                themes={mapData.themes}
                activeRouteIds={mapView.activeRouteIds}
                writingPlaceIds={writingPlaceIds}
                loading={dossierLoading || topics.loading || exploreState.loading}
                focus={mapFocus}
                eventFocus={eventFocus}
                language={mapLanguage}
                onToggleLanguage={toggleLanguage}
              />
            ) : topics.loading ? (
              <p className="px-4 py-8 text-center text-xs text-ink-soft">正在载入本书地图专题…</p>
            ) : (
              <div className="rounded-md border border-dashed border-border bg-paper-soft/40 px-4 py-8 text-center text-xs leading-6 text-ink-soft">
                这本书还没有地图专题数据（整书地点/路线库）。
                <br />
                本章探索数据引用了地点，需要先有整书专题库才能展示。
              </div>
            )}
          </div>
        ) : null}

        {tab === "timeline" ? (
          <TimelineView
            chapterId={chapterId ?? ""}
            chapterTitle={chapterTitle}
            topics={topics.timeline}
            eventIds={timelineEventIds}
            writingDate={writingDate}
            placeNames={placeNames}
            onFocusPlace={focusPlace}
          />
        ) : null}

        {tab === "other" ? (
          <OtherExplorerPanel
            missing={missingKinds}
            error={exploreState.error}
            hint={agentHintCopy}
            onRequestAgent={requestAgentFor}
          />
        ) : null}
      </div>
    </div>
  );
}
