import type { ChapterDigest, DigestPoint } from "./types";

/** 动态分析输出：只保留要点与少量结构化字段，正文不回传。 */
export interface SectionAnalysis {
  keyPoints: DigestPoint[];
  writing?: ChapterDigest["writing"];
  themes?: string[];
  map?: ChapterDigest["map"];
  note?: string;
}

/**
 * 按节分析器契约（本轮只定义，不接任何 API）。
 * 输入是已存档的 ChapterDigest；实现方应只发送摘要，不重新加载整章。
 */
export interface SectionAnalyzer {
  analyze(digest: ChapterDigest, options?: { signal?: AbortSignal }): Promise<SectionAnalysis>;
}
