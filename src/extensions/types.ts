export interface LegacyDossier {
  writing?: { date?: string; placeName?: string; placeIds?: string[] };
  map?: { themeIds?: string[]; placeIds?: string[]; routeIds?: string[]; focus?: { lon: number; lat: number; zoom?: number } };
}

export interface TimelineEvent {
  id: string;
  date: string;
  dateLabel?: string;
  title: string;
  summary: string;
  themes?: string[];
  articleIds?: string[];
  placeIds?: string[];
  importance?: number;
  sources?: { label: string; type?: string; url?: string }[];
}

export interface TimelineTopics {
  config?: { enabledArticleIds?: string[]; beforeYears?: number; afterYears?: number; note?: string };
  events: TimelineEvent[];
}

export interface TimelinePhaseEvent extends TimelineEvent {
  phase: "before" | "after";
  articleSpecific: boolean;
}
