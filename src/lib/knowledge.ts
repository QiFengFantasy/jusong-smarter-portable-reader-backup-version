import type { KnowledgeEntry } from "@jusong/core";

/**
 * 旧档案（legacy-article）的 payload 结构，以及「知识库 / 摘要」两个面板共用的
 * 读取、分组、检索工具。数据来源：data/books/<bookId>/knowledge/entries/*.json。
 */

export interface DossierCitation {
  paragraphId?: string;
  quote?: string;
}

export interface DossierBlock {
  id?: string;
  /** overview / background / purpose / significance 等。 */
  section?: string;
  title?: string;
  text?: string;
  citations?: DossierCitation[];
  sourceIds?: string[];
}

export interface DossierSource {
  id?: string;
  /** primary / book / web / archive 等。 */
  type?: string;
  label?: string;
  locator?: string;
  url?: string;
}

export interface DossierWriting {
  date?: string;
  dateNote?: string;
  placeName?: string;
  placeIds?: string[];
  certainty?: string;
  note?: string;
}

export interface DossierMapRefs {
  themeIds?: string[];
  placeIds?: string[];
  routeIds?: string[];
  focus?: { lon: number; lat: number; zoom?: number };
}

export interface LegacyDossierPayload {
  schemaVersion?: number;
  articleId?: string;
  title?: string;
  volume?: number;
  period?: string;
  dateText?: string;
  writing?: DossierWriting;
  blocks?: DossierBlock[];
  sources?: DossierSource[];
  map?: DossierMapRefs;
  confidence?: string;
  updatedAt?: string;
  author?: string;
}

export interface DossierSection {
  id: string;
  label: string;
  blocks: DossierBlock[];
}

const SECTION_LABELS: Record<string, string> = {
  overview: "概览",
  background: "历史背景",
  purpose: "写作目的",
  significance: "意义与影响",
  structure: "文章结构",
  argument: "核心论述",
  context: "时代背景",
  note: "补充说明",
};

const SECTION_ORDER = ["overview", "background", "purpose", "significance", "structure", "argument", "context"];

export function dossierSectionLabel(section?: string): string {
  if (!section) return "档案要点";
  return SECTION_LABELS[section] ?? section;
}

/** 是否为旧版文章式的人工档案（带 payload）。 */
export function isLegacyArchive(entry: KnowledgeEntry | null | undefined): boolean {
  return Boolean(entry && entry.type === "legacy-article" && entry.payload);
}

export function dossierPayload(entry: KnowledgeEntry | null | undefined): LegacyDossierPayload | null {
  if (!isLegacyArchive(entry)) return null;
  const payload = entry?.payload;
  return payload && typeof payload === "object" ? (payload as LegacyDossierPayload) : null;
}

function blockText(block: DossierBlock): string {
  return (block.text ?? "").trim();
}

/** 按 section 归组，保持「概括 → 背景 → 目的 → 意义」的阅读顺序。 */
export function groupDossierBlocks(blocks: readonly DossierBlock[] | undefined): DossierSection[] {
  if (!blocks || blocks.length === 0) return [];
  const grouped = new Map<string, DossierBlock[]>();
  for (const block of blocks) {
    if (!blockText(block) && !block.title) continue;
    const id = block.section ?? "note";
    const list = grouped.get(id);
    if (list) list.push(block);
    else grouped.set(id, [block]);
  }
  const orderOf = (id: string): number => {
    const index = SECTION_ORDER.indexOf(id);
    return index < 0 ? SECTION_ORDER.length + 1 : index;
  };
  return [...grouped.entries()]
    .map(([id, sectionBlocks]) => ({ id, label: dossierSectionLabel(id), blocks: sectionBlocks }))
    .sort((left, right) => orderOf(left.id) - orderOf(right.id));
}

/** 档案整体置信度文案与配色（沿用旧版说法）。 */
export function confidenceLabel(value?: string): string | null {
  switch (value) {
    case "high":
      return "高置信度";
    case "medium":
      return "中置信度";
    case "low":
      return "低置信度";
    case "unknown":
      return "待考";
    default:
      return null;
  }
}

export function confidenceClass(value?: string): string {
  switch (value) {
    case "high":
      return "border-emerald-700/25 bg-emerald-700/10 text-emerald-800";
    case "medium":
      return "border-amber-700/25 bg-amber-700/10 text-amber-800";
    case "low":
      return "border-cinnabar/30 bg-cinnabar/10 text-cinnabar";
    default:
      return "border-border bg-muted/60 text-ink-soft";
  }
}

export function sourceTypeLabel(type?: string): string {
  switch (type) {
    case "primary":
      return "原文";
    case "book":
      return "专著";
    case "web":
      return "网络";
    case "archive":
      return "档案";
    case "journal":
      return "期刊";
    default:
      return "来源";
  }
}

export interface ParagraphRef {
  paragraphId: string;
  /** 段落序号（p0004 → 4）；无法解析时为 null。 */
  ordinal: number | null;
  quote?: string;
}

/** 把 p0004 这类稳定段落 id 解析成「4 段」里的数字。 */
export function paragraphNumber(paragraphId: string): number | null {
  const match = /^p0*(\d+)$/i.exec(paragraphId.trim());
  return match ? Number(match[1]) : null;
}

/**
 * 一块要点指向的原文段落：按段落序号排序、去重。
 * 只存 paragraphId / quote，显示用的「n 段」在这里推导，不进入数据。
 */
export function paragraphRefs(block: DossierBlock): ParagraphRef[] {
  const seen = new Set<string>();
  const refs: ParagraphRef[] = [];
  for (const citation of block.citations ?? []) {
    const paragraphId = (citation.paragraphId ?? "").trim();
    if (!paragraphId || seen.has(paragraphId)) continue;
    seen.add(paragraphId);
    refs.push({ paragraphId, ordinal: paragraphNumber(paragraphId), quote: citation.quote });
  }
  return refs.sort((left, right) => {
    const leftOrder = left.ordinal ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.ordinal ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.paragraphId.localeCompare(right.paragraphId);
  });
}

export interface SourceRefEntry {
  /** 在 payload.sources 里的 1-based 顺序号，即「参考来源」列表序号。 */
  index: number;
  source: DossierSource;
}

export interface SourceRefGroup {
  label: string;
  entries: SourceRefEntry[];
}

/**
 * 一块要点引用的来源，按类型归组并换算成「参考来源」列表里的序号。
 * 序号完全由 sources 数组顺序推导，不在要点里存任何展示文本。
 */
export function sourceRefGroups(
  block: DossierBlock,
  sources: readonly DossierSource[] | undefined,
): SourceRefGroup[] {
  if (!block.sourceIds?.length || !sources?.length) return [];
  const groups = new Map<string, SourceRefGroup>();
  for (const sourceId of block.sourceIds) {
    const index = sources.findIndex((source) => source.id === sourceId);
    if (index < 0) continue;
    const source = sources[index];
    // 原文来源由「原文：n段」的段落引用表达，不再重复一枚「原文：n篇」。
    if (source.type === "primary") continue;
    const label = sourceTypeLabel(source.type);
    const group = groups.get(label) ?? { label, entries: [] };
    if (!group.entries.some((entry) => entry.index === index + 1)) {
      group.entries.push({ index: index + 1, source });
    }
    groups.set(label, group);
  }
  return [...groups.values()]
    .map((group) => ({
      label: group.label,
      entries: [...group.entries].sort((left, right) => left.index - right.index),
    }))
    .sort((left, right) => left.entries[0].index - right.entries[0].index);
}

/** 档案检索文本：标题、摘要、各块正文、来源标签与写作信息。 */export function archiveSearchText(entry: KnowledgeEntry): string {
  const payload = dossierPayload(entry);
  const parts: string[] = [entry.title, entry.body];
  if (payload) {
    if (payload.period) parts.push(payload.period);
    if (payload.dateText) parts.push(payload.dateText);
    if (payload.writing?.placeName) parts.push(payload.writing.placeName);
    for (const block of payload.blocks ?? []) {
      if (block.title) parts.push(block.title);
      if (block.text) parts.push(block.text);
    }
    for (const source of payload.sources ?? []) {
      if (source.label) parts.push(source.label);
      if (source.locator) parts.push(source.locator);
    }
  }
  return parts.filter(Boolean).join("\n");
}

/** 章节顺序：种子书 chapterId 形如 v1-0101，可按字典序还原阅读顺序。 */
export function sortArchives(entries: readonly KnowledgeEntry[]): KnowledgeEntry[] {
  return [...entries].sort((left, right) => {
    const leftKey = left.chapterId ?? left.id;
    const rightKey = right.chapterId ?? right.id;
    const byChapter = leftKey.localeCompare(rightKey, "en");
    return byChapter !== 0 ? byChapter : left.title.localeCompare(right.title, "zh-Hans-CN");
  });
}

export function filterArchives(entries: readonly KnowledgeEntry[], query: string): KnowledgeEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) => archiveSearchText(entry).toLowerCase().includes(needle));
}

/** 档案所属的卷/时期，用于列表副标题。 */
export function archiveMeta(entry: KnowledgeEntry): string {
  const payload = dossierPayload(entry);
  const parts = [payload?.period, payload?.dateText].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.join(" · ");
  return entry.chapterId ?? "";
}
