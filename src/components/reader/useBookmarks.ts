import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Bookmark,
  BookmarkInput,
  BookmarkOrder,
  BookmarkPatch,
  Library,
} from "@jusong/core";

import { getErrorMessage } from "../../lib/utils";

/**
 * 书签变更通知：首页知识统计（书签数）等订阅方按 bookId 刷新。
 * 事件名与 payload 由第三批约定；监听方自行做防抖/取消。
 */
export const BOOKMARKS_CHANGED_EVENT = "jusong:bookmarks-changed";

function notifyBookmarksChanged(bookId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(BOOKMARKS_CHANGED_EVENT, { detail: { bookId } }),
    );
  } catch {
    // 自定义事件不可用（极旧运行环境）时忽略：只影响首页统计的即时刷新。
  }
}

export interface BookmarkStore {
  /** 当前书籍的书签（Rust 返回顺序，展示排序由 BookmarkPanel 负责）。 */
  bookmarks: Bookmark[];
  loading: boolean;
  error: string | null;
  /** 重新读取（后端就绪/出错后重试）。 */
  reload: () => void;
  /**
   * 新增：成功后就地插入列表并返回记录。
   * 未显式传 `order` 时自动取当前最大 order + 1，保证手动排序模式下新书签排在末尾。
   */
  add: (input: BookmarkInput) => Promise<Bookmark>;
  /** 更新标题/备注/排序：成功后替换列表项。 */
  update: (id: string, patch: BookmarkPatch) => Promise<Bookmark>;
  /** 删除：成功后从列表移除。 */
  remove: (id: string) => Promise<void>;
  /** 批量删除（一次写盘；幂等）。 */
  removeMany: (ids: string[]) => Promise<void>;
  /**
   * 批量写入手动排序（拖拽后调用）：先乐观更新本地 order，后端失败时整体回滚并抛错，
   * 由调用方给出提示。
   */
  updateOrders: (orders: BookmarkOrder[]) => Promise<void>;
}

/**
 * 阅读器书签数据：按 `bookId` 从 Rust 用户库（bookmarks.json）读取，写操作成功后
 * 就地更新本地列表，避免整表重读造成列表闪动。
 *
 * 后端未就绪时 `listBookmarks` 返回 []、写操作抛错；错误会给出提示，UI 仍可正常展示。
 */
export function useBookmarks(library: Library | null, bookId: string): BookmarkStore {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 列表请求序号：切书 / 重试时丢弃旧响应，避免慢请求覆盖新列表。
  const loadSerialRef = useRef(0);
  // 与 state 同步的最新列表快照：`add` 计算最大 order、`updateOrders` 回滚时读取。
  const bookmarksRef = useRef<Bookmark[]>([]);

  const replaceBookmarks = useCallback((next: Bookmark[]) => {
    bookmarksRef.current = next;
    setBookmarks(next);
  }, []);

  const mutateBookmarks = useCallback((updater: (current: Bookmark[]) => Bookmark[]) => {
    setBookmarks((current) => {
      const next = updater(current);
      bookmarksRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!library || !bookId) {
      replaceBookmarks([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const serial = loadSerialRef.current + 1;
    loadSerialRef.current = serial;
    setLoading(true);
    setError(null);

    library
      .listBookmarks(bookId)
      .then((list) => {
        if (cancelled || serial !== loadSerialRef.current) return;
        replaceBookmarks(Array.isArray(list) ? list : []);
      })
      .catch((reason: unknown) => {
        if (cancelled || serial !== loadSerialRef.current) return;
        replaceBookmarks([]);
        setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (cancelled || serial !== loadSerialRef.current) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [library, bookId, attempt, replaceBookmarks]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const add = useCallback(
    async (input: BookmarkInput): Promise<Bookmark> => {
      if (!library) throw new Error("书库尚未就绪，请稍后重试");
      let payload: BookmarkInput = input;
      if (input.order === undefined) {
        const maxOrder = bookmarksRef.current.reduce(
          (max, item) => (typeof item.order === "number" && item.order > max ? item.order : max),
          -1,
        );
        payload = { ...input, order: maxOrder + 1 };
      }
      const created = await library.addBookmark(payload);
      mutateBookmarks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setError(null);
      notifyBookmarksChanged(input.bookId);
      return created;
    },
    [library, mutateBookmarks],
  );

  const update = useCallback(
    async (id: string, patch: BookmarkPatch): Promise<Bookmark> => {
      if (!library) throw new Error("书库尚未就绪，请稍后重试");
      const updated = await library.updateBookmark(id, patch);
      mutateBookmarks((current) =>
        current.map((item) => (item.id === id ? { ...item, ...updated } : item)),
      );
      setError(null);
      notifyBookmarksChanged(updated.bookId || bookId);
      return updated;
    },
    [library, bookId, mutateBookmarks],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!library) throw new Error("书库尚未就绪，请稍后重试");
      await library.deleteBookmark(id);
      mutateBookmarks((current) => current.filter((item) => item.id !== id));
      setError(null);
      notifyBookmarksChanged(bookId);
    },
    [library, bookId, mutateBookmarks],
  );

  const removeMany = useCallback(
    async (ids: string[]): Promise<void> => {
      if (!library) throw new Error("书库尚未就绪，请稍后重试");
      const unique = Array.from(
        new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)),
      );
      if (unique.length === 0) return;
      const removed = new Set(unique);
      await library.deleteBookmarks(unique);
      mutateBookmarks((current) => current.filter((item) => !removed.has(item.id)));
      setError(null);
      notifyBookmarksChanged(bookId);
    },
    [library, bookId, mutateBookmarks],
  );

  const updateOrders = useCallback(
    async (orders: BookmarkOrder[]): Promise<void> => {
      if (!library) throw new Error("书库尚未就绪，请稍后重试");
      if (orders.length === 0) return;
      const previous = bookmarksRef.current;
      const nextOrder = new Map(orders.map((entry) => [entry.id, entry.order] as const));
      // 乐观更新：拖拽松手后立即按新顺序渲染，不等后端。
      mutateBookmarks((current) =>
        current.map((item) => {
          const order = nextOrder.get(item.id);
          return order === undefined ? item : { ...item, order };
        }),
      );
      try {
        await library.updateBookmarkOrders(bookId, orders);
        setError(null);
      } catch (reason: unknown) {
        // 失败回滚：恢复拖拽前的 order 并抛给 UI 提示。
        mutateBookmarks(() => previous);
        throw reason;
      }
    },
    [library, bookId, mutateBookmarks],
  );

  return { bookmarks, loading, error, reload, add, update, remove, removeMany, updateOrders };
}
