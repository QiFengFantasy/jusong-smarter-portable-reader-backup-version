import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { wgs84ToGcj02 } from "./coordTransform";
import { buildPlaceLayer, buildRouteLayer } from "./mapLayers";
import { createTileManager, type MapLanguage, type TileMode } from "./mapTiles";
import { RouteAnimator } from "./routeAnimation";
import { RouteLegend, type GeoStatus, type LegendPlace, type LegendRoute } from "./RouteLegend";
import type { MapPlace, MapTheme, RouteFeature } from "./types";

const INITIAL_CENTER: [number, number] = [34.5, 108];
const INITIAL_ZOOM = 4;

interface MapCanvasProps {
  places: MapPlace[];
  routes: RouteFeature[];
  themes: MapTheme[];
  activeRouteIds: string[];
  /** 当前文章的写作地点，图例里单独标注。 */
  writingPlaceIds?: string[];
  /** 章节档案/专题数据仍在载入：保持旧图层与视角，避免先渲染全书数据。 */
  loading?: boolean;
  focus?: { lon: number; lat: number; zoom?: number } | null;
  eventFocus?: { lon: number; lat: number; zoom?: number } | null;
  language: MapLanguage;
  onToggleLanguage: () => void;
}

/** 低于该缩放级别时隐藏常显地名，避免拥挤。 */
const PLACE_LABEL_MIN_ZOOM = 5;

function displayLatLng(lon: number, lat: number, mode: "wgs84" | "gcj02"): L.LatLngTuple {
  if (mode === "gcj02") {
    const [gcjLon, gcjLat] = wgs84ToGcj02(lon, lat);
    return [gcjLat, gcjLon];
  }
  return [lat, lon];
}

/** 阅读器右栏内的地图扩展：地点、路线、无级缩放、中文/英文底图。 */
export function MapCanvas({
  places,
  routes,
  themes,
  activeRouteIds,
  writingPlaceIds = [],
  loading = false,
  focus,
  eventFocus,
  language,
  onToggleLanguage,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const animatorRef = useRef<RouteAnimator | null>(null);
  const playingRef = useRef(false);
  const [tileMode, setTileMode] = useState<TileMode>(language === "zh" ? "amap" : "esri-street");
  const [tileAttempt, setTileAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  /** 容器是否有可见尺寸：侧栏在窄屏被 CSS 隐藏时 Leaflet 无法安全飞行。 */
  const [mapVisible, setMapVisible] = useState(false);
  const showPlaceLabels = routes.length > 0;

  const coordinateMode = tileMode === "amap" ? "gcj02" : "wgs84";
  const project = useCallback(
    (lon: number, lat: number): L.LatLngTuple => displayLatLng(lon, lat, coordinateMode),
    [coordinateMode],
  );
  const themesById = useMemo(() => new Map(themes.map((theme) => [theme.id, theme])), [themes]);

  // 图例只反映当前文章实际展示的点与线。
  const legendPlaces = useMemo<LegendPlace[]>(
    () =>
      places.map((place) => ({
        id: place.id,
        name: place.name,
        color: themesById.get(place.themes[0])?.color ?? "#6b5e4e",
        isWriting: writingPlaceIds.includes(place.id),
      })),
    [places, themesById, writingPlaceIds],
  );

  const legendRoutes = useMemo<LegendRoute[]>(
    () =>
      routes.map((feature) => {
        const properties = feature.properties;
        const themeColor = properties.themeIds
          .map((id) => themesById.get(id)?.color)
          .find((color): color is string => Boolean(color));
        return {
          id: properties.id,
          name: properties.name,
          color: properties.color ?? themeColor ?? "#9c2f25",
          dashed: properties.style === "dashed",
        };
      }),
    [routes, themesById],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = L.map(container, {
      center: displayLatLng(INITIAL_CENTER[1], INITIAL_CENTER[0], language === "zh" ? "gcj02" : "wgs84"),
      zoom: INITIAL_ZOOM,
      minZoom: 3,
      maxZoom: 18,
      zoomSnap: 0,
      zoomDelta: 0.5,
      zoomControl: false,
      worldCopyJump: true,
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
    map.attributionControl.setPrefix(false);
    mapRef.current = map;
    animatorRef.current = new RouteAnimator();

    const reportZoom = () => {
      container.dataset.mapZoom = map.getZoom().toFixed(2);
      // 低缩放时隐藏常显地名，避免标签互相重叠。
      container.classList.toggle("map-labels-hidden", map.getZoom() < PLACE_LABEL_MIN_ZOOM);
    };
    map.on("zoom", reportZoom);
    map.on("zoomend", reportZoom);
    reportZoom();

    // 无级滚轮缩放；短动画让旧瓦片先缩放，避免白屏闪烁。
    map.scrollWheelZoom.disable();
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const magnitude = Math.min(0.45, Math.max(0.03, 0.05 + Math.abs(event.deltaY) / 600));
      const next = Math.min(18, Math.max(3, map.getZoom() + (event.deltaY > 0 ? -magnitude : magnitude)));
      if (next === map.getZoom()) return;
      const latlng = map.containerPointToLatLng(map.mouseEventToContainerPoint(event));
      map.setZoomAround(latlng, next, { animate: true });
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    const syncSize = () => {
      const { width, height } = container.getBoundingClientRect();
      map.invalidateSize();
      setMapVisible(width > 0 && height > 0);
    };
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncSize) : null;
    observer?.observe(container);
    syncSize();
    return () => {
      container.removeEventListener("wheel", onWheel);
      observer?.disconnect();
      animatorRef.current?.dispose();
      animatorRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // 只初始化一次；底图/数据变化由后续 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const manager = createTileManager(map, { language, onModeChange: setTileMode });
    return () => manager.dispose();
  }, [tileAttempt, language]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileMode !== "offline") {
      setGeoStatus("idle");
      return;
    }
    let alive = true;
    let layer: L.GeoJSON | null = null;
    setGeoStatus("loading");
    fetch("/geo/china-provinces.geojson")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("离线底图缺失"))))
      .then((geo) => {
        if (!alive || !mapRef.current) return;
        layer = L.geoJSON(geo, {
          style: { color: "#b7a992", weight: 1, fillColor: "#ece3d3", fillOpacity: 0.55 },
        }).addTo(mapRef.current);
        layer.bringToBack();
        setGeoStatus("ready");
      })
      .catch(() => alive && setGeoStatus("missing"));
    return () => {
      alive = false;
      if (layer && mapRef.current) mapRef.current.removeLayer(layer);
    };
  }, [tileMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || loading) return;
    const group = buildPlaceLayer({
      places,
      project,
      themesById,
      activeThemeId: null,
      showPlaceLabels,
    });
    group.addTo(map);
    return () => {
      map.removeLayer(group);
    };
  }, [places, project, themesById, showPlaceLabels, loading]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || loading) return;
    const { group, animated } = buildRouteLayer({
      routes,
      project,
      themesById,
      activeRouteIds,
      activeThemeId: null,
    });
    group.addTo(map);
    animatorRef.current?.setRoutes(animated);
    animatorRef.current?.setPlaying(playingRef.current);
    return () => {
      animatorRef.current?.setRoutes([]);
      map.removeLayer(group);
    };
  }, [routes, project, themesById, activeRouteIds, loading]);

  useEffect(() => {
    playingRef.current = playing;
    animatorRef.current?.setPlaying(playing);
  }, [playing]);

  // 用基本类型作依赖：父组件每次渲染都会新建 focus 对象，若直接依赖对象会导致
  // 每次重渲染都重新 flyTo（拖拽侧栏时会疯狂移动地图）。
  const focusLon = focus?.lon;
  const focusLat = focus?.lat;
  const focusZoom = focus?.zoom;
  const eventLon = eventFocus?.lon;
  const eventLat = eventFocus?.lat;
  const eventZoom = eventFocus?.zoom;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapVisible || loading) return;
    // 容器被隐藏或尺寸为 0 时 Leaflet 的投影会得到 NaN，flyTo 会抛异常；
    // 侧栏收起到窄屏断点以下就会出现这种情况，直接跳过（等重新可见后由 ResizeObserver 修正尺寸）。
    const size = map.getSize();
    if (size.x <= 0 || size.y <= 0) return;

    if (Number.isFinite(eventLon) && Number.isFinite(eventLat)) {
      map.flyTo(project(eventLon as number, eventLat as number), eventZoom ?? 8, { duration: 0.8 });
      return;
    }
    if (routes.length > 0) {
      const points = routes
        .flatMap((feature) => feature.geometry.coordinates.map(([lon, lat]) => project(lon, lat)))
        .filter((point): point is L.LatLngTuple => Number.isFinite(point[0]) && Number.isFinite(point[1]));
      if (points.length > 0) {
        map.flyToBounds(L.latLngBounds(points).pad(0.16), { maxZoom: 9, duration: 0.9 });
        return;
      }
    }
    if (Number.isFinite(focusLon) && Number.isFinite(focusLat)) {
      map.flyTo(project(focusLon as number, focusLat as number), focusZoom ?? 8, { duration: 0.9 });
      return;
    }
    map.flyTo(project(INITIAL_CENTER[1], INITIAL_CENTER[0]), INITIAL_ZOOM, { duration: 0.6 });
  }, [focusLon, focusLat, focusZoom, eventLon, eventLat, eventZoom, routes, project, mapVisible, loading]);

  return (
    <div className="map-stage extension-map">
      <div className="map-canvas" ref={containerRef} aria-label="书籍专题地图" />
      <button
        type="button"
        className="map-lang-toggle"
        onClick={onToggleLanguage}
        aria-label={language === "zh" ? "切换为英文底图" : "切换为中文底图"}
      >
        <span className={language === "zh" ? "is-active" : ""}>中文</span>
        <span className="map-lang-toggle__sep">/</span>
        <span className={language === "en" ? "is-active" : ""}>EN</span>
      </button>
      {tileMode === "offline" ? (
        <div className="map-badge" role="status">
          离线底图{geoStatus === "missing" ? "（省界缺失）" : geoStatus === "loading" ? "（加载中）" : ""}
        </div>
      ) : null}
      <RouteLegend
        places={legendPlaces}
        routes={legendRoutes}
        loading={loading}
        playing={playing}
        onTogglePlaying={() => setPlaying((value) => !value)}
        offline={tileMode === "offline"}
        geoStatus={geoStatus}
        onRetryTiles={() => setTileAttempt((value) => value + 1)}
      />
    </div>
  );
}
