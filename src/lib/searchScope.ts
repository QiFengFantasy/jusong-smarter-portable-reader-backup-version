/**
 * 检索范围配置：`最近阅读本数@档位1@档位2@…@-1`。
 *
 * - 第一段：首轮覆盖的「最近阅读」本数（1–20）；
 * - 其余段：「查找更多」按绝对覆盖本数逐档扩大，`-1` 表示全部（必须最后）；
 * - 段之间用 `@`（也接受逗号/空格）。
 *
 * 例：`5@10@20@-1` = 首轮最近 5 本，点击「查找更多」依次覆盖 10、20、全部。
 */

export interface SearchScopeSpec {
  /** 首轮覆盖的最近阅读本数。 */
  recentCount: number;
  /** 查找更多档位（绝对本数，升序；末位 -1 表示全部）。 */
  tiers: number[];
}

export const SEARCH_SCOPE_MIN_RECENT = 1;
export const SEARCH_SCOPE_MAX_RECENT = 20;
export const DEFAULT_SEARCH_SCOPE: SearchScopeSpec = { recentCount: 5, tiers: [10, 20, -1] };

function validTier(tier: number, previous: number | null): boolean {
  if (tier === -1) return true;
  if (!Number.isInteger(tier) || tier <= 0) return false;
  return previous === null || tier > previous;
}

/** 解析配置文本；非法时返回默认值（不抛异常，设置页用返回的规范化文本回显）。 */
export function parseSearchScopeSpec(text: string | undefined | null): SearchScopeSpec {
  if (!text || typeof text !== "string") return { ...DEFAULT_SEARCH_SCOPE, tiers: [...DEFAULT_SEARCH_SCOPE.tiers] };
  const parts = text
    .split(/[@,，\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part));
  if (parts.length < 2 || parts.some((value) => !Number.isFinite(value))) {
    return { ...DEFAULT_SEARCH_SCOPE, tiers: [...DEFAULT_SEARCH_SCOPE.tiers] };
  }
  const [recentRaw, ...tierRaw] = parts;
  const recentCount = Math.round(recentRaw);
  if (!Number.isInteger(recentCount) || recentCount < SEARCH_SCOPE_MIN_RECENT || recentCount > SEARCH_SCOPE_MAX_RECENT) {
    return { ...DEFAULT_SEARCH_SCOPE, tiers: [...DEFAULT_SEARCH_SCOPE.tiers] };
  }
  const tiers: number[] = [];
  let previous: number | null = recentCount;
  for (const tier of tierRaw) {
    const rounded = Math.round(tier);
    if (!validTier(rounded, previous)) {
      return { ...DEFAULT_SEARCH_SCOPE, tiers: [...DEFAULT_SEARCH_SCOPE.tiers] };
    }
    if (tier === -1) {
      tiers.push(-1);
      break;
    }
    tiers.push(rounded);
    previous = rounded;
  }
  if (tiers.length === 0 || tiers[tiers.length - 1] !== -1) tiers.push(-1);
  return { recentCount, tiers };
}

/** 规范化文本（设置页回显用）。 */
export function normalizeSearchScopeText(text: string | undefined | null): string {
  const spec = parseSearchScopeSpec(text);
  return [spec.recentCount, ...spec.tiers].join("@");
}

/** 人类可读说明，例如「最近 5 本 · 查找更多 10 → 20 → 全部」。 */
export function describeSearchScope(spec: SearchScopeSpec): string {
  const tiers = spec.tiers
    .map((tier) => (tier === -1 ? "全部" : `${tier} 本`))
    .join(" → ");
  return `最近 ${spec.recentCount} 本 · 查找更多 ${tiers}`;
}

/**
 * 把「查找更多」档位换算成实际覆盖本数（受书库总本数限制）。
 * `current` 为当前已覆盖本数，返回下一档覆盖本数（-1 表示全部）；没有下一档返回 null。
 *
 * 注意：档位换算后若被总本数夹到与当前覆盖相同（如「20 本」但全书只有 10 本），
 * 必须继续看下一档，否则会返回一个「永不增长」的下一档，UI 的「查找更多」按钮点不动。
 */
export function nextCoverageTier(spec: SearchScopeSpec, current: number, total: number): number | null {
  const covered = Math.max(0, Math.min(current, total));
  for (const tier of spec.tiers) {
    if (tier === -1) {
      return total > covered ? total : null;
    }
    const candidate = Math.min(tier, total);
    if (candidate > covered) return candidate;
  }
  return null;
}
