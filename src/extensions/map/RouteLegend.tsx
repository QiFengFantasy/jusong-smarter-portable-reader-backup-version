import { cn } from "../../lib/utils";
import { GenerateHintButton } from "../../components/reader/GenerateHintButton";

export type GeoStatus = "idle" | "loading" | "ready" | "missing" | "error";

export interface LegendPlace {
  id: string;
  name: string;
  color: string;
  /** 是否是本文的写作地点（单独标注）。 */
  isWriting: boolean;
}

export interface LegendRoute {
  id: string;
  name: string;
  color: string;
  dashed?: boolean;
}

interface RouteLegendProps {
  /** 当前文章实际展示的地点与路线（已按文章过滤，不再列全部主题）。 */
  places: LegendPlace[];
  routes: LegendRoute[];
  /** 章节档案/专题仍在载入。 */
  loading?: boolean;
  playing: boolean;
  onTogglePlaying: () => void;
  offline: boolean;
  geoStatus: GeoStatus;
  onRetryTiles: () => void;
}

/** 地图左下角图例：只说明当前文章实际用到的点与线。 */
export function RouteLegend({
  places,
  routes,
  loading = false,
  playing,
  onTogglePlaying,
  offline,
  geoStatus,
  onRetryTiles,
}: RouteLegendProps) {
  const writingPlaces = places.filter((place) => place.isWriting);
  const otherPlaces = places.filter((place) => !place.isWriting);
  const countText = loading
    ? "正在载入…"
    : routes.length > 0
      ? routes.length + " 条路线"
      : places.length + " 个地点";
  const empty = !loading && routes.length === 0 && places.length === 0;

  return (
    <div className="route-legend" role="group" aria-label="地图图例">
      <div className="route-legend__head">
        <span>地图图例</span>
        <span className="route-legend__count">{empty ? "本章无地图信息" : countText}</span>
      </div>

      <ul className="route-legend__items">
        {loading ? (
          <li className="route-legend__item route-legend__name">正在载入本章地图…</li>
        ) : null}

        {routes.map((route) => (
          <li key={route.id} className="route-legend__item">
            <span
              className="route-legend__line"
              aria-hidden="true"
              style={
                route.dashed
                  ? { backgroundImage: "repeating-linear-gradient(90deg," + route.color + " 0 4px, transparent 4px 8px)" }
                  : { background: route.color }
              }
            />
            <span className="route-legend__name">{route.name}</span>
          </li>
        ))}

        {writingPlaces.length > 0 ? (
          <li className="route-legend__item">
            <span
              className="route-legend__dot"
              aria-hidden="true"
              style={{ background: writingPlaces[0].color }}
            />
            <span className="route-legend__name">
              写作地点：{writingPlaces.map((place) => place.name).join("、")}
            </span>
          </li>
        ) : null}

        {otherPlaces.length > 0 ? (
          <li className="route-legend__item">
            <span
              className="route-legend__dot"
              aria-hidden="true"
              style={{ background: otherPlaces[0].color }}
            />
            <span className="route-legend__name">
              地点：{otherPlaces.map((place) => place.name).join("、")}
            </span>
          </li>
        ) : null}

        {empty ? (
          <li className="route-legend__item">
            <GenerateHintButton label="生成地点 / 路线" className="items-start" />
          </li>
        ) : null}
      </ul>

      <div className={cn("route-legend__foot", routes.length === 0 && "route-legend__foot--plain")}>
        {routes.length > 0 ? (
          <button
            type="button"
            className={playing ? "button button--small is-playing" : "button button--small"}
            onClick={onTogglePlaying}
            aria-pressed={playing}
          >
            {playing ? "❚❚ 暂停流动" : "▶ 播放路线"}
          </button>
        ) : null}
        {offline ? (
          <div className="route-legend__offline">
            <span>离线底图{geoStatus === "missing" ? "（省界缺失）" : ""}</span>
            <button type="button" className="link-button" onClick={onRetryTiles}>
              重试在线底图
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
