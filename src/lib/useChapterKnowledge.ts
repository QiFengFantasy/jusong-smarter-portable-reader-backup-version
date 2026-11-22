import { useEffect, useState } from "react";
import type { ChapterDigest, KnowledgeEntry } from "@jusong/core";

import { loadChapterBundle } from "./chapter-data";
import { useLibrary } from "./library";
import { isLegacyArchive } from "./knowledge";
import { getErrorMessage } from "./utils";

export interface ChapterKnowledge {
  /** 章节摘要（种子书为人工档案摘要，导入书为结构摘要）。 */
  digest: ChapterDigest | null;
  /** 本章的旧档案条目（只有种子书有）。 */
  archive: KnowledgeEntry | null;
  loading: boolean;
  error: string | null;
}

/** 读取当前章节的摘要与旧档案，供左栏「摘要」面板使用。refreshKey 变化时重新读取。 */
export function useChapterKnowledge(
  bookId: string,
  chapterId?: string,
  refreshKey = 0,
): ChapterKnowledge {
  const { library } = useLibrary();
  const [state, setState] = useState<ChapterKnowledge>({
    digest: null,
    archive: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!library || !chapterId) {
      setState({ digest: null, archive: null, loading: false, error: null });
      return;
    }

    let alive = true;
    setState({ digest: null, archive: null, loading: true, error: null });

    loadChapterBundle(library, bookId, chapterId, refreshKey > 0)
      .then((bundle) => {
        if (!alive) return;
        setState({
          digest: bundle.digest,
          archive: bundle.entries.find(isLegacyArchive) ?? null,
          loading: false,
          error: null,
        });
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setState({ digest: null, archive: null, loading: false, error: getErrorMessage(reason) });
      });

    return () => {
      alive = false;
    };
  }, [library, bookId, chapterId, refreshKey]);

  return state;
}
