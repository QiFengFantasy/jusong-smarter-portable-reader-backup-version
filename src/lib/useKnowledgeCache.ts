import { useSyncExternalStore } from "react";

import {
  getKnowledgeCacheVersion,
  invalidateAll,
  invalidateBook,
  subscribeKnowledgeCache,
} from "./knowledge-cache";

/**
 * 订阅知识内存缓存：失效 / AGENT 增量插入 / 书签数量变化后返回新的 version，
 * 已挂载视图把它放进 effect 依赖里即可从缓存刷新（缓存命中时不再发 IPC）。
 *
 * 返回的失效函数供「手动刷新」使用：先 invalidate 再重载，确保绕过缓存。
 */
export interface KnowledgeCacheControl {
  version: number;
  invalidateAll: () => void;
  invalidateBook: (bookId: string) => void;
}

export function useKnowledgeCache(): KnowledgeCacheControl {
  const version = useSyncExternalStore(
    subscribeKnowledgeCache,
    getKnowledgeCacheVersion,
    getKnowledgeCacheVersion,
  );
  return { version, invalidateAll, invalidateBook };
}
