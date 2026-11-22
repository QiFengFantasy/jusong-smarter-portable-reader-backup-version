import { useEffect, useState } from "react";
import type { Library } from "@jusong/core";

import { loadBookTopics } from "../lib/chapter-data";
import type { MapTopics } from "./map/types";
import type { TimelineTopics } from "./types";

interface TopicState {
  map: MapTopics | null;
  timeline: TimelineTopics | null;
  loading: boolean;
  error: string | null;
}

/**
 * 整书专题数据：经 Library.getBookTopics（Rust Content API）读取。
 * 同一本书的并发调用由 chapter-data 缓存去重（PERF-06）。
 */
export function useBookTopics(library: Library | null, bookId: string | null): TopicState {
  const [state, setState] = useState<TopicState>({
    map: null,
    timeline: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!bookId) {
      setState({ map: null, timeline: null, loading: false, error: null });
      return;
    }
    if (!library?.getBookTopics) {
      setState({
        map: null,
        timeline: null,
        loading: false,
        error: "专题数据需要 Tauri 运行时（请使用桌面版）。",
      });
      return;
    }

    let alive = true;
    setState({ map: null, timeline: null, loading: true, error: null });
    loadBookTopics(library, bookId)
      .then((topics) => {
        if (!alive) return;
        setState({
          map: (topics.map as MapTopics | null) ?? null,
          timeline: (topics.timeline as TimelineTopics | null) ?? null,
          loading: false,
          error: null,
        });
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setState({
          map: null,
          timeline: null,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      alive = false;
    };
  }, [library, bookId]);

  return state;
}
