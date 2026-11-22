import { pinyin } from "pinyin-pro";

import { prepareCoverImage } from "./cover";
import { buildChapterDigest } from "./digest";
import { parseEpub } from "./epub";
import type {
  AgentKnowledgeWrite,
  AgentKnowledgeWriteResult,
  Bookmark,
  BookmarkInput,
  BookmarkOrder,
  BookmarkPatch,
  BookMeta,
  BookTopics,
  BookTransferInfo,
  Chapter,
  ChapterAssets,
  ChapterDigest,
  ChapterExplore,
  ExportResult,
  GlobalSearchHit,
  KnowledgeEntry,
  Library,
  LibraryCapabilities,
  RecentBook,
  SearchHit,
  SearchOptions,
  TocNode,
} from "./types";

/** Tauri invoke 的最小签名；由前端注入 @tauri-apps/api/core 的 invoke。 */
export type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface TauriLibraryOptions {
  invoke: InvokeFn;
}

export interface TauriLibrary extends Library {
  readonly mode: "tauri";
}

function pinyinSlug(title: string): string {
  const words = pinyin(title, { toneType: "none", type: "array" }).join("");
  const slug = words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "book";
}

function toError(error: unknown): Error {
  if (error && typeof error === "object" && "message" in error) {
    const detail = error as { code?: string; message?: unknown };
    return new Error(String(detail.message ?? "Tauri 命令失败"));
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Tauri 运行时 Library：所有数据经 Rust Content API（library_*）读写。
 * 前端不直接 fetch 书数据文件；浏览器实现仅作为冻结的调试回退。
 */
export function createTauriLibrary(options: TauriLibraryOptions): TauriLibrary {
  const { invoke } = options;

  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return (await invoke(command, args)) as T;
    } catch (error) {
      throw toError(error);
    }
  };

  const library: TauriLibrary = {
    mode: "tauri",

    async init(): Promise<void> {
      // 首启/升级时由 Rust 把内置种子内容包复制进用户库（幂等）。
      await call("library_ensure_seed");
    },

    async listBooks(): Promise<BookMeta[]> {
      return (await call<BookMeta[] | null>("library_list_books")) ?? [];
    },

    async getBook(bookId: string): Promise<BookMeta | null> {
      return await call<BookMeta | null>("library_get_book", { bookId });
    },

    async getToc(bookId: string): Promise<TocNode[]> {
      return (await call<TocNode[] | null>("library_get_toc", { bookId })) ?? [];
    },

    async getChapter(bookId: string, chapterId: string): Promise<Chapter | null> {
      return await call<Chapter | null>("library_get_chapter", { bookId, chapterId });
    },

    async importEpub(input: {
      name: string;
      buffer: ArrayBuffer;
      path?: string;
    }): Promise<BookMeta> {
      if (!input.path) {
        throw new Error("Tauri 导入需要文件路径（dialog 选择后传入）");
      }
      const parsed = await parseEpub({ buffer: input.buffer, name: input.name });
      const digests = parsed.chapters.map((chapter) =>
        buildChapterDigest("", { ...chapter, bookId: "" }),
      );
      // 封面在浏览器侧缩放编码后随导入 IPC 传给 Rust 落盘；失败则用占位封面。
      const preparedCover = parsed.cover ? await prepareCoverImage(parsed.cover) : null;
      return await call<BookMeta>("library_import_epub", {
        path: input.path,
        slug: pinyinSlug(parsed.title),
        book: {
          title: parsed.title,
          author: parsed.author,
          publisher: parsed.publisher,
          description: parsed.description,
        },
        toc: parsed.toc,
        chapters: parsed.chapters,
        digests,
        importedAt: new Date().toISOString(),
        cover: preparedCover?.base64 ?? null,
        coverMime: preparedCover?.mime ?? null,
      });
    },

    async search(_bookId: string, _query: string, _limit?: number): Promise<SearchHit[]> {
      // 旧版单本检索接口保留占位；全局检索走 searchAll（Rust 按需扫盘）。
      return [];
    },

    async searchAll(query: string, options: SearchOptions): Promise<GlobalSearchHit[]> {
      return (
        (await call<GlobalSearchHit[] | null>("library_search", {
          query,
          requestId: options.requestId,
          limit: options.limit ?? null,
          bookIds: options.bookIds ?? null,
          includeBookLevel: options.includeBookLevel ?? true,
          knowledgeOnly: options.knowledgeOnly ?? false,
        })) ?? []
      );
    },

    async searchKnowledge(query: string, options: SearchOptions): Promise<GlobalSearchHit[]> {
      return await library.searchAll(query, { ...options, knowledgeOnly: true });
    },

    async cancelSearch(requestId: string): Promise<void> {
      await call("library_cancel_search", { requestId });
    },

    async getRecentBooks(): Promise<RecentBook[]> {
      return (await call<RecentBook[] | null>("library_get_recent_books")) ?? [];
    },

    async recordRecentBook(bookId: string): Promise<void> {
      await call("library_record_recent_book", { bookId });
    },

    async getBookCover(bookId: string): Promise<ArrayBuffer | null> {
      const bytes = await call<ArrayBuffer | number[] | null>("library_get_book_cover", { bookId });
      if (!bytes) return null;
      if (bytes instanceof ArrayBuffer) return bytes.byteLength > 0 ? bytes : null;
      if (Array.isArray(bytes) && bytes.length > 0) return new Uint8Array(bytes).buffer;
      return null;
    },

    async listBookmarks(bookId?: string): Promise<Bookmark[]> {
      return (
        (await call<Bookmark[] | null>("library_list_bookmarks", { bookId: bookId ?? null })) ?? []
      );
    },

    async addBookmark(input: BookmarkInput): Promise<Bookmark> {
      return await call<Bookmark>("library_add_bookmark", { bookmark: input });
    },

    async updateBookmark(id: string, patch: BookmarkPatch): Promise<Bookmark> {
      return await call<Bookmark>("library_update_bookmark", { id, patch });
    },

    async deleteBookmark(id: string): Promise<void> {
      await call("library_delete_bookmark", { id });
    },

    async deleteBookmarks(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      await call("library_delete_bookmarks", { ids });
    },

    async updateBookmarkOrders(bookId: string, orders: BookmarkOrder[]): Promise<void> {
      if (orders.length === 0) return;
      await call("library_update_bookmark_orders", { bookId, orders });
    },

    async getChapterExplore(bookId: string, chapterId: string): Promise<ChapterExplore | null> {
      return await call<ChapterExplore | null>("library_get_chapter_explore", {
        bookId,
        chapterId,
      });
    },

    async importOriginalBook(path: string): Promise<BookMeta> {
      return await call<BookMeta>("library_import_original", { path });
    },

    async importPackage(path: string): Promise<BookMeta> {
      return await call<BookMeta>("library_import_package", { path });
    },

    async getBookTransferInfo(bookId: string): Promise<BookTransferInfo> {
      return await call<BookTransferInfo>("library_book_transfer_info", { bookId });
    },

    async exportBook(
      bookId: string,
      mode: "original" | "package" | "all",
      destination: string,
    ): Promise<ExportResult> {
      return await call<ExportResult>("library_export_book", { bookId, mode, destination });
    },

    async addKnowledge(entry: Omit<KnowledgeEntry, "id" | "createdAt">): Promise<KnowledgeEntry> {
      // AGENT「保存到知识库」等手动写入：Rust 原子追加到 shared/archives.json。
      return await call<KnowledgeEntry>("library_add_knowledge", {
        bookId: entry.bookId,
        chapterId: entry.chapterId ?? null,
        entryType: entry.type,
        title: entry.title,
        body: entry.body,
        payload: entry.payload ?? null,
      });
    },

    async applyAgentKnowledge(
      bookId: string,
      payload: AgentKnowledgeWrite,
    ): Promise<AgentKnowledgeWriteResult> {
      // 导入构建收尾：Rust 合并 shared/topics 与各章 explore.json（按 id 去重、原子写）。
      return await call<AgentKnowledgeWriteResult>("library_apply_agent_knowledge", {
        bookId,
        map: payload.map ?? null,
        timeline: payload.timeline ?? null,
        explores: payload.explores,
      });
    },

    async listKnowledge(bookId: string, chapterId?: string): Promise<KnowledgeEntry[]> {
      return (
        (await call<KnowledgeEntry[] | null>("library_list_knowledge", {
          bookId,
          chapterId: chapterId ?? null,
        })) ?? []
      );
    },

    async getKnowledge(bookId: string, entryId: string): Promise<KnowledgeEntry | null> {
      return await call<KnowledgeEntry | null>("library_get_knowledge", { bookId, entryId });
    },

    async getChapterDigest(bookId: string, chapterId: string): Promise<ChapterDigest | null> {
      return await call<ChapterDigest | null>("library_get_chapter_digest", { bookId, chapterId });
    },

    async listChapterDigests(bookId: string): Promise<ChapterDigest[]> {
      // 批量接口：一次 IPC 读取该书的全部章节摘要（Rust 单次 spawn_blocking）。
      return (
        (await call<ChapterDigest[] | null>("library_list_chapter_digests", { bookId })) ?? []
      );
    },

    async saveChapterDigest(digest: ChapterDigest): Promise<void> {
      await call("library_save_chapter_digest", { digest });
    },

    async getChapterAssets(bookId: string, chapterId: string): Promise<ChapterAssets> {
      return await call<ChapterAssets>("library_get_chapter_assets", { bookId, chapterId });
    },

    async getBookTopics(bookId: string): Promise<BookTopics> {
      return (
        (await call<BookTopics | null>("library_get_book_topics", { bookId })) ?? {
          map: null,
          timeline: null,
        }
      );
    },

    async getCapabilities(): Promise<LibraryCapabilities> {
      return {
        searchMode: "like",
        fts5Available: false,
        indexedChapters: 0,
      };
    },
  };

  return library;
}
