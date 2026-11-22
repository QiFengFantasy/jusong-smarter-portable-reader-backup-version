import L from "leaflet";
import { createPlacePopup, createPlaceTooltip, createTextElement } from "./mapPopup";
import type { AnimatedRoute } from "./routeAnimation";
import type { MapPlace, MapTheme, RouteFeature } from "./types";

const INK = "#6b5e4e";
const CINNABAR = "#9c2f25";
const PAPER_STROKE = "#f7f1e6";

export interface PlaceLayerOptions {
  places: MapPlace[];
  project: (lon: number, lat: number) => L.LatLngTuple;
  themesById: Map<string, MapTheme>;
  activeThemeId: string | null;
  /** 有路线时常显地点名称，扩大可读范围；无路线时保持悬停显示。 */
  showPlaceLabels?: boolean;
}

/** 当前章节相关地点；颜色随主题，主题筛选时其余点变淡。 */
export function buildPlaceLayer(options: PlaceLayerOptions): L.LayerGroup {
  const { places, project, themesById, activeThemeId, showPlaceLabels = false } = options;
  const group = L.layerGroup();

  for (const place of places) {
    const color = themesById.get(place.themes[0])?.color ?? INK;
    const dimmed = Boolean(activeThemeId && !place.themes.includes(activeThemeId));
    const marker = L.circleMarker(project(place.lon, place.lat), {
      radius: dimmed ? 4 : 6,
      color: PAPER_STROKE,
      weight: 1.5,
      fillColor: color,
      fillOpacity: dimmed ? 0.2 : 0.82,
      opacity: dimmed ? 0.35 : 1,
    });
    marker.bindTooltip(
      createPlaceTooltip(place),
      showPlaceLabels
        ? { permanent: true, direction: "top", offset: [0, -8], opacity: 0.95, className: "map-place-label" }
        : { direction: "top", offset: [0, -6], opacity: 1 },
    );
    marker.bindPopup(createPlacePopup(place), { maxWidth: 280, minWidth: 200 });
    marker.addTo(group);
  }
  return group;
}

export interface RouteLayerOptions {
  routes: RouteFeature[];
  project: (lon: number, lat: number) => L.LatLngTuple;
  themesById: Map<string, MapTheme>;
  activeRouteIds: string[];
  activeThemeId: string | null;
}

export function buildRouteLayer(options: RouteLayerOptions): { group: L.LayerGroup; animated: AnimatedRoute[] } {
  const { routes, project, themesById, activeRouteIds, activeThemeId } = options;
  const group = L.layerGroup();
  const animated: AnimatedRoute[] = [];

  for (const feature of routes) {
    const properties = feature.properties;
    const themeColor = properties.themeIds
      .map((id) => themesById.get(id)?.color)
      .find((color): color is string => Boolean(color));
    const color = properties.color ?? themeColor ?? CINNABAR;
    const isActive = activeRouteIds.includes(properties.id);
    const dimmed = Boolean(activeThemeId && !properties.themeIds.includes(activeThemeId));
    const baseDashArray = properties.style === "dashed" ? "6 8" : undefined;

    const polyline = L.polyline(
      feature.geometry.coordinates.map(([lon, lat]) => project(lon, lat)),
      {
        color,
        weight: isActive ? 4.5 : 2.4,
        opacity: dimmed ? 0.18 : 0.82,
        dashArray: baseDashArray,
        lineCap: "round",
        lineJoin: "round",
      },
    );
    // 有行进路线时不在地图上悬停显示路线名称（图例里已经说明），只保留点击弹窗描述。
    if (properties.description) {
      polyline.bindPopup(createTextElement("div", properties.description, "map-popup__route"), {
        maxWidth: 280,
      });
    }
    polyline.addTo(group);
    if (isActive) polyline.bringToFront();
    animated.push({ layer: polyline, baseDashArray });
  }
  return { group, animated };
}
