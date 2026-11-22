import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { createTauriLibrary } from "@jusong/core";
import type { BookMeta, Library } from "@jusong/core";

import { getErrorMessage } from "./utils";

export type LibraryStatus = "initializing" | "ready" | "error";

interface BootstrapResult {
  library: Library;
  books: BookMeta[];
  seedError: string | null;
  booksError: string | null;
}

interface LibraryContextValue {
  /** null until init() resolves. */
  library: Library | null;
  status: LibraryStatus;
  /** Fatal init failure；书架仍会渲染错误面板而不是白屏。 */
  error: string | null;
  /** 保留字段：Tauri 种子安装失败会作为致命错误展示；成功时为 null。 */
  seedError: string | null;
  booksError: string | null;
  books: BookMeta[];
  booksLoading: boolean;
  refreshBooks: () => Promise<void>;
  /** Tauri：系统 dialog 选文件 → Rust 读原文件 → 解析并原子导入。 */
  pickAndImportEpub: () => Promise<BookMeta | null>;
  retry: () => void;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

// 单例：React 18 StrictMode 会重复执行 effect，模块级缓存放行一次 init。
let librarySingleton: Library | null = null;
let bootstrapPromise: Promise<BootstrapResult> | null = null;

function getLibrary(): Library {
  if (!librarySingleton) {
    librarySingleton = createTauriLibrary({ invoke: (command, args) => invoke(command, args) });
  }
  return librarySingleton;
}

async function bootstrap(): Promise<BootstrapResult> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async (): Promise<BootstrapResult> => {
      // 浏览器存储已在 P6 移除：唯一运行时是 Tauri（Vite dev server 仅服务 Tauri dev）。
      if (!isTauri()) {
        throw new Error("浏览器运行已停用：请使用 Tauri 桌面版（pnpm tauri dev 或安装包）。");
      }

      const library = getLibrary();
      // 首启/升级时由 Rust 把内置种子内容包复制进用户库（幂等）。
      await library.init();
      try {
        console.info("[jusong] Tauri Content API:", await invoke("library_info"));
      } catch (error) {
        console.warn("[jusong] 读取 library_info 失败：", error);
      }

      let books: BookMeta[] = [];
      let booksError: string | null = null;
      try {
        books = await library.listBooks();
      } catch (error) {
        booksError = getErrorMessage(error);
        console.warn("[jusong] 书架读取失败：", error);
      }
      return { library, books, seedError: null, booksError };
    })().catch((error: unknown) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LibraryStatus>("initializing");
  const [error, setError] = useState<string | null>(null);
  const [seedError] = useState<string | null>(null);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [books, setBooks] = useState<BookMeta[]>([]);
  const [booksLoading, setBooksLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const libraryRef = useRef<Library | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("initializing");
    setError(null);
    setBooksError(null);
    setBooks([]);
    setBooksLoading(true);

    bootstrap()
      .then((result) => {
        if (cancelled) return;
        libraryRef.current = result.library;
        setLibrary(result.library);
        setBooks(result.books);
        setBooksError(result.booksError);
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        console.error("[jusong] 书库初始化失败：", reason);
        setError(getErrorMessage(reason));
        setStatus("error");
      })
      .finally(() => {
        if (!cancelled) setBooksLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const refreshBooks = useCallback(async () => {
    const active = libraryRef.current;
    if (!active) return;
    setBooksLoading(true);
    try {
      const next = await active.listBooks();
      setBooks(next);
      setBooksError(null);
    } catch (reason) {
      setBooksError(getErrorMessage(reason));
      console.warn("[jusong] 刷新书架失败：", reason);
    } finally {
      setBooksLoading(false);
    }
  }, []);

  const pickAndImportEpub = useCallback(async (): Promise<BookMeta | null> => {
    const active = libraryRef.current;
    if (!active) {
      throw new Error("书库尚未就绪，请稍后重试");
    }
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "EPUB 电子书", extensions: ["epub"] }],
    });
    const path =
      typeof selected === "string" ? selected : Array.isArray(selected) ? selected[0] : null;
    if (!path) return null;

    const bytes = await invoke<ArrayBuffer | number[]>("library_read_epub", { path });
    const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
    const name = path.split(/[\\/]/).pop() ?? "book.epub";
    const meta = await active.importEpub({ name, buffer, path });
    try {
      const next = await active.listBooks();
      setBooks(next);
      setBooksError(null);
    } catch (reason) {
      setBooksError(getErrorMessage(reason));
      console.warn("[jusong] 导入后刷新书架失败：", reason);
    }
    return meta;
  }, []);

  const retry = useCallback(() => {
    bootstrapPromise = null;
    librarySingleton = null;
    libraryRef.current = null;
    setLibrary(null);
    setAttempt((value) => value + 1);
  }, []);

  const value = useMemo<LibraryContextValue>(
    () => ({
      library,
      status,
      error,
      seedError,
      booksError,
      books,
      booksLoading,
      refreshBooks,
      pickAndImportEpub,
      retry,
    }),
    [
      library,
      status,
      error,
      seedError,
      booksError,
      books,
      booksLoading,
      refreshBooks,
      pickAndImportEpub,
      retry,
    ],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const context = useContext(LibraryContext);
  if (!context) {
    throw new Error("useLibrary 必须在 <LibraryProvider> 内部使用");
  }
  return context;
}
