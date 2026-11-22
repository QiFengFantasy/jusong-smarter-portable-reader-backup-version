import type {
  Chapter,
  ChapterDigest,
  DigestCitation,
  DigestPoint,
  KnowledgeEntry,
} from "./types";

interface LegacyDossier {
  writing?: { date?: string; placeName?: string; placeIds?: string[] };
  map?: { themeIds?: string[]; placeIds?: string[]; routeIds?: string[] };
  blocks?: {
    section?: string;
    title?: string;
    text?: string;
    citations?: { paragraphId?: string; quote?: string }[];
  }[];
}

function clip(text: string, max: number): string {
  const normalized = text.trim();
  return normalized.length > max ? normalized.slice(0, max) + "…" : normalized;
}

function legacyDossier(entries: readonly KnowledgeEntry[]): LegacyDossier | null {
  const entry = entries.find(
    item => item.type === "legacy-article" && item.payload && typeof item.payload === "object",
  );
  return entry ? (entry.payload as LegacyDossier) : null;
}

function keyPointsFrom(dossier: LegacyDossier | null): DigestPoint[] {
  if (!dossier?.blocks?.length) return [];
  return dossier.blocks
    .filter(block => (block.text ?? "").trim().length > 0)
    .map(block => ({
      section: block.section ?? "background",
      ...(block.title ? { title: block.title } : {}),
      text: block.text ?? "",
      citations: (block.citations ?? [])
        .filter(citation => citation.paragraphId && citation.quote)
        .map(citation => ({
          paragraphId: citation.paragraphId as string,
          quote: citation.quote as string,
          ...(block.section ? { section: block.section } : {}),
        })) as DigestCitation[],
    }))
    .filter(point => point.citations.length > 0);
}

/** 从章节正文 + 已有档案生成紧凑摘要；不调用任何外部 API。 */
export function buildChapterDigest(
  bookId: string,
  chapter: Chapter,
  knowledgeEntries: readonly KnowledgeEntry[] = [],
  generatedAt = new Date().toISOString(),
): ChapterDigest {
  const headings = chapter.blocks
    .filter(block => block.kind === "heading")
    .map(block => block.text)
    .filter(Boolean);
  const paragraphs = chapter.blocks
    .filter(block => block.kind === "paragraph" || block.kind === "quote")
    .map(block => block.text.trim())
    .filter(Boolean);
  const dossier = legacyDossier(knowledgeEntries);
  const keyPoints = keyPointsFrom(dossier);

  const opening = clip(paragraphs.slice(0, 2).join("\n"), 320);
  const closing = clip(paragraphs.slice(-2).join("\n"), 320);

  return {
    schemaVersion: 1,
    bookId,
    chapterId: chapter.id,
    title: chapter.title,
    generatedAt,
    source: keyPoints.length > 0 ? "legacy-analysis" : "import-structure",
    stats: {
      charCount: chapter.blocks.reduce((sum, block) => sum + block.text.length, 0),
      paragraphCount: paragraphs.length,
      headingCount: headings.length,
      noteCount: chapter.blocks.filter(block => block.kind === "note").length,
    },
    headings,
    opening,
    closing,
    keyPoints,
    ...(dossier?.writing ? { writing: dossier.writing } : {}),
    ...(dossier?.map?.themeIds ? { themes: dossier.map.themeIds } : {}),
    ...(dossier?.map
      ? {
          map: {
            ...(dossier.map.placeIds ? { placeIds: dossier.map.placeIds } : {}),
            ...(dossier.map.routeIds ? { routeIds: dossier.map.routeIds } : {}),
          },
        }
      : {}),
  };
}

/** 供后续动态分析覆盖摘要：保留正文统计，替换分析要点与来源。 */
export function mergeDynamicDigest(
  base: ChapterDigest,
  analysis: Pick<ChapterDigest, "keyPoints" | "writing" | "themes" | "map" | "note">,
): ChapterDigest {
  return {
    ...base,
    ...analysis,
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "dynamic-analysis",
  };
}
