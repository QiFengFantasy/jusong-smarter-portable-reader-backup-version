import { useCallback } from "react";
import type { BookMeta, GlobalSearchHit, SearchOptions } from "@jusong/core";

import { useLibrary } from "./library";
import type { SearchScopeSpec } from "./searchScope";
import { useScopedSearch, type ScopedSearchState } from "./useGlobalSearch";

export interface UseKnowledgeSearchOptions {
  books: BookMeta[];
  /** 来自 `useSettings().settings.searchScope` 的解析结果。 */
  scope: SearchScopeSpec;
}

export type KnowledgeSearchState = ScopedSearchState;

/**
 * 知识库检索（首页知识库视图内使用，与高级检索互相独立）：
 *
 * - 调用 `library.searchKnowledge`（Rust 只扫档案 + 章节摘要，不扫章节正文）；
 * - 最近阅读优先 + 「查找更多」档位扩大 + 结果合并去重，与 `useGlobalSearch` 同一套引擎；
 * - 只保留 kind=knowledge 的命中，不占用高级检索的查询状态。
 */
export function useKnowledgeSearch({ books, scope }: UseKnowledgeSearchOptions): KnowledgeSearchState {
  const { library } = useLibrary();
  const search = useCallback(
    (text: string, options: SearchOptions): Promise<GlobalSearchHit[]> => {
      if (!library) return Promise.reject(new Error("书库尚未就绪，请稍后重试"));
      return library.searchKnowledge(text, options);
    },
    [library],
  );
  const accept = useCallback((hit: GlobalSearchHit) => hit.kind === "knowledge", []);
  return useScopedSearch({ books, scope, search, accept });
}
