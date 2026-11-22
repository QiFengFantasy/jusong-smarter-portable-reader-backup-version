import L from "leaflet";

export type MapLanguage = "zh" | "en";
export type TileMode = "amap" | "esri-street" | "esri-topo" | "offline";

export interface TileManagerOptions {
  language: MapLanguage;
  onModeChange?: (mode: TileMode) => void;
}

export interface TileManager {
  dispose: () => void;
}

/** 连续多少块瓦片失败后降级。 */
const TILE_ERROR_THRESHOLD = 6;

interface TileSource {
  mode: Exclude<TileMode, "offline">;
  url: string;
  attribution: string;
  subdomains?: string;
  maxZoom?: number;
}

const SOURCES: Record<MapLanguage, TileSource[]> = {
  zh: [
    {
      mode: "amap",
      url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
      subdomains: "1234",
      maxZoom: 18,
    },
  ],
  en: [
    {
      mode: "esri-street",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      attribution:
        'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    },
    {
      mode: "esri-topo",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      attribution:
        'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, FAO, NOAA, USGS',
    },
  ],
};

/**
 * 底图管理：
 * - 中文模式：高德中文瓦片（GCJ-02），失败直接离线省界（WGS84）；
 * - 英文模式：Esri World Street Map → Esri Topo → 离线省界（均 WGS84）。
 * 坐标系由 MapCanvas 根据 TileMode 决定，切换时重投影所有图层。
 */
export function createTileManager(map: L.Map, options: TileManagerOptions): TileManager {
  const sources = SOURCES[options.language];
  let sourceIndex = 0;
  let errors = 0;
  let layer: L.TileLayer | null = null;
  const preloadLayers: L.TileLayer[] = [];
  let disposed = false;

  const removeLayer = () => {
    if (!layer) return;
    layer.off();
    map.removeLayer(layer);
    layer = null;
  };

  const report = (mode: TileMode) => options.onModeChange?.(mode);

  const removePreloadLayers = () => {
    for (const preload of preloadLayers) {
      preload.off();
      map.removeLayer(preload);
    }
    preloadLayers.length = 0;
  };

  /**
   * 预加载当前级别 ±1 的瓦片：透明图层，只负责把相邻级别拉进浏览器缓存，
   * 等真正缩放/动画结束时切换过去可以立即绘制，减少空白闪烁。
   */
  const addPreloadLayers = (source: TileSource) => {
    for (const zoomOffset of [-1, 1]) {
      const preload = L.tileLayer(source.url, {
        attribution: "",
        subdomains: source.subdomains ?? "abc",
        minZoom: 2,
        maxZoom: source.maxZoom ?? 18,
        zoomOffset,
        opacity: 0,
        detectRetina: false,
        updateWhenIdle: true,
        keepBuffer: 2,
        crossOrigin: true,
        className: "map-tiles-preload",
      }).addTo(map);
      preloadLayers.push(preload);
    }
  };

  const addSource = () => {
    removeLayer();
    removePreloadLayers();
    const source = sources[sourceIndex];
    if (!source) {
      removePreloadLayers();
      report("offline");
      return;
    }
    errors = 0;
    report(source.mode);
    layer = L.tileLayer(source.url, {
      attribution: source.attribution,
      subdomains: source.subdomains ?? "abc",
      minZoom: 2,
      maxZoom: source.maxZoom ?? 18,
      detectRetina: false,
      crossOrigin: true,
      className: "map-tiles-paper",
      // 缩放过程中保留旧瓦片，等动画结束后再切换，避免中途出现空白层。
      updateWhenZooming: false,
      keepBuffer: 3,
    }).addTo(map);
    addPreloadLayers(source);

    layer.on("tileerror", () => {
      if (disposed || !layer) return;
      errors += 1;
      if (errors < TILE_ERROR_THRESHOLD) return;
      sourceIndex += 1;
      if (sourceIndex >= sources.length) {
        removeLayer();
        removePreloadLayers();
        report("offline");
      } else {
        addSource();
      }
    });

    layer.on("load", () => {
      if (!disposed) errors = 0;
    });
  };

  addSource();

  return {
    dispose: () => {
      disposed = true;
      removeLayer();
      removePreloadLayers();
    },
  };
}
