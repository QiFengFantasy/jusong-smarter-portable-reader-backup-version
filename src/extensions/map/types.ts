export interface MapTheme {
  id: string;
  name: string;
  color: string;
  order?: number;
  description?: string;
}

export interface MapPlace {
  id: string;
  name: string;
  modernName?: string;
  lon: number;
  lat: number;
  type?: string;
  themes: string[];
  description?: string;
}

export interface RouteProperties {
  id: string;
  name: string;
  themeIds: string[];
  articleIds?: string[];
  year?: string;
  color?: string;
  style?: "solid" | "dashed";
  description?: string;
  placeIds?: string[];
}

export interface RouteFeature {
  type: "Feature";
  properties: RouteProperties;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

export interface MapTopics {
  schemaVersion?: number;
  bookId?: string;
  themes: MapTheme[];
  places: MapPlace[];
  routes: { type: "FeatureCollection"; features: RouteFeature[] };
}
