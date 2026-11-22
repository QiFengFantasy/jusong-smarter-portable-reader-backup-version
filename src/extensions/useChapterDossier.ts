import { useEffect, useState } from "react";
import type { Library } from "@jusong/core";

import { loadChapterBundle } from "../lib/chapter-data";
import { isLegacyArchive } from "../lib/knowledge";
import type { LegacyDossier } from "./types";

export interface ChapterDossierState {
  dossier: LegacyDossier | null;
  /** 正在读取本章档案：地图/时间线应等待，避免先渲染整本书的数据。 */
  loading: boolean;
}

/** 当前章节对应的旧版文章档案（只有 legacy-article 条目带 payload）。 */
export function useChapterDossier(
  library: Library | null,
  bookId: string,
  chapterId: string | undefined,
): ChapterDossierState {
  const [state, setState] = useState<ChapterDossierState>({ dossier: null, loading: false });

  useEffect(() => {
    if (!library || !chapterId) {
      setState({ dossier: null, loading: false });
      return;
    }
    let alive = true;
    setState({ dossier: null, loading: true });
    loadChapterBundle(library, bookId, chapterId)
      .then((bundle) => {
        if (!alive) return;
        const archive = bundle.entries.find(isLegacyArchive);
        setState({
          dossier: (archive?.payload as LegacyDossier | undefined) ?? null,
          loading: false,
        });
      })
      .catch(() => {
        if (alive) setState({ dossier: null, loading: false });
      });
    return () => {
      alive = false;
    };
  }, [library, bookId, chapterId]);

  return state;
}
