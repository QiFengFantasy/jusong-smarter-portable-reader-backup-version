import type { BuildEstimate, BuildItemId } from "./types";
import { isBuildItemId } from "./types";

/**
 * 构建耗时/调用/成本估算（契约 §3）。
 *
 * 公式（与 CONTRACTS.md 一致，不显示金额）：
 * - 批大小 `BATCH_SIZE = 5`；批次数 `ceil(chapterCount / 5)`；
 * - 调用：低 `2 + 3*batches`，高 `2 + 4*batches`
 *   （Lead 计划 + Lead 终审 2 次；每批 研究员/撰写/审查 3 次；审查不通过时撰写修订 +1）；
 * - token：按选中条目的权重累加每批「章数 × 单章单条目基准 token」，
 *   低 ×0.8、高 ×1.3，至少 1k；基准为经验值，仅用于展示范围；
 * - 时间：低 `callsMin*8s + 10s`，高 `callsMax*25s + 10s`，向上取整分钟。
 *
 * 无选择 / 0 章时返回全 0（选择页据此禁用开始按钮）。
 */

/** 每章正文截取约 4000 字符，一批最多 5 章。 */
export const BATCH_SIZE = 5;

/** 单章 × 单条目（权重 1）的基准 token，含研究/撰写/审查的输入与输出。 */
const TOKENS_PER_CHAPTER_PER_ITEM = 2000;

/** 条目权重：摘要与档案是长文本产出；地图/时间线是结构化短条目。 */
const ITEM_TOKEN_WEIGHT: Record<BuildItemId, number> = {
  digest: 1,
  archive: 1,
  place: 0.5,
  timeline: 0.5,
};

const LOW_FACTOR = 0.8;
const HIGH_FACTOR = 1.3;
const MIN_TOKENS = 1000;
const LOW_SECONDS_PER_CALL = 8;
const HIGH_SECONDS_PER_CALL = 25;
const FIXED_OVERHEAD_SECONDS = 10;
const TOKEN_ROUNDING = 100;

function roundTokens(value: number): number {
  return Math.round(value / TOKEN_ROUNDING) * TOKEN_ROUNDING;
}

/** 归一化选中条目：去重、过滤非法 id、按 BUILD_ITEMS 顺序。 */
function normalizeItems(selected: readonly BuildItemId[]): BuildItemId[] {
  const seen = new Set<BuildItemId>();
  for (const id of selected) {
    if (isBuildItemId(id)) seen.add(id);
  }
  return (["digest", "archive", "place", "timeline"] as BuildItemId[]).filter((id) => seen.has(id));
}

/**
 * 估算一次导入构建的调用次数、token 范围与用时范围。
 * `chapterCount` 取书籍章节数；0 章或未选条目时返回全 0 值。
 */
export function estimateImportBuild(
  chapterCount: number,
  selected: BuildItemId[],
): BuildEstimate {
  const chapters = Number.isFinite(chapterCount) ? Math.max(0, Math.floor(chapterCount)) : 0;
  const items = normalizeItems(selected);

  if (chapters === 0 || items.length === 0) {
    return {
      chapterCount: chapters,
      batchCount: 0,
      callsMin: 0,
      callsMax: 0,
      tokensMin: 0,
      tokensMax: 0,
      minutesMin: 0,
      minutesMax: 0,
    };
  }

  const batchCount = Math.ceil(chapters / BATCH_SIZE);
  const callsMin = 2 + 3 * batchCount;
  const callsMax = 2 + 4 * batchCount;

  const weight = items.reduce((sum, id) => sum + ITEM_TOKEN_WEIGHT[id], 0);
  // 逐批累计：最后一批可能不足 5 章。
  let baseTokens = 0;
  for (let index = 0; index < batchCount; index += 1) {
    const batchChapters = Math.min(BATCH_SIZE, chapters - index * BATCH_SIZE);
    baseTokens += batchChapters * weight * TOKENS_PER_CHAPTER_PER_ITEM;
  }

  const tokensMin = Math.max(MIN_TOKENS, roundTokens(baseTokens * LOW_FACTOR));
  const tokensMax = Math.max(tokensMin, roundTokens(baseTokens * HIGH_FACTOR));

  const lowSeconds = callsMin * LOW_SECONDS_PER_CALL + FIXED_OVERHEAD_SECONDS;
  const highSeconds = callsMax * HIGH_SECONDS_PER_CALL + FIXED_OVERHEAD_SECONDS;
  const minutesMin = Math.ceil(lowSeconds / 60);
  const minutesMax = Math.ceil(highSeconds / 60);

  return {
    chapterCount: chapters,
    batchCount,
    callsMin,
    callsMax,
    tokensMin,
    tokensMax,
    minutesMin,
    minutesMax,
  };
}
