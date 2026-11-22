import { useEffect, useState } from "react";
import type { BookMeta } from "@jusong/core";

import { useLibrary } from "../../lib/library";
import { cn } from "../../lib/utils";

function coverLabel(book: BookMeta): string {
  const cleaned = book.title
    .replace(/（[^）]*）/g, "")
    .replace(/[《》]/g, "")
    .trim();
  return (cleaned || book.title).slice(0, 9);
}

export interface BookCoverProps {
  book: BookMeta;
  className?: string;
  /** 加载中占位文案；缺省「封面加载中」。 */
  loadingLabel?: string;
}

/** 封面缓存键：同一本书换了封面文件时重新读取（导入覆盖场景）。 */
function coverCacheKey(book: BookMeta): string {
  return `${book.id}|${book.coverFile ?? ""}|${book.coverMime ?? ""}`;
}

/**
 * 模块级缓存：一本书只经 Rust 读一次二进制，只创建一个 blob URL。
 * blob URL 生命周期跟随页面会话（不主动 revoke，避免同一封面多卡片互踩）；
 * 页面刷新/退出即释放。
 */
const coverUrlCache = new Map<string, string>();
const coverPending = new Map<string, Promise<string | null>>();

async function loadCoverUrl(
  library: { getBookCover: (bookId: string) => Promise<ArrayBuffer | null> },
  book: BookMeta,
): Promise<string | null> {
  const key = coverCacheKey(book);
  const cached = coverUrlCache.get(key);
  if (cached) return cached;
  const pending = coverPending.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<string | null> => {
    try {
      const bytes = await library.getBookCover(book.id);
      if (!bytes || bytes.byteLength === 0) return null;
      const blob = new Blob([bytes], { type: book.coverMime || "image/jpeg" });
      const url = URL.createObjectURL(blob);
      coverUrlCache.set(key, url);
      return url;
    } catch {
      // 读取失败按「无封面」处理，回落封面占位渐变。
      return null;
    } finally {
      coverPending.delete(key);
    }
  })();

  coverPending.set(key, promise);
  return promise;
}

type CoverStatus = "placeholder" | "loading" | "ready";

/**
 * 书籍封面：有 `coverFile` 时经 Rust（`library_get_book_cover`）读取二进制并转 blob URL，
 * 否则/加载失败时用封面占位设计（`.cover-placeholder-gradient`，颜色取设置-外观的封面占位色；
 * 书自带 `coverColor` 时优先用书自身颜色）。加载中显示「封面加载中」，图片 `object-fit: cover`。
 * 尺寸由外层 className 决定（默认书架卡片的 6.25rem × 8.5rem）。
 */
export function BookCover({ book, className, loadingLabel }: BookCoverProps) {
  const { library } = useLibrary();
  const hasCover = Boolean(book.coverFile);
  const [url, setUrl] = useState<string | null>(() =>
    hasCover ? coverUrlCache.get(coverCacheKey(book)) ?? null : null,
  );
  const [status, setStatus] = useState<CoverStatus>(() => {
    if (!hasCover) return "placeholder";
    return coverUrlCache.has(coverCacheKey(book)) ? "ready" : "loading";
  });

  useEffect(() => {
    if (!hasCover || !library) {
      setUrl(null);
      setStatus("placeholder");
      return;
    }
    const key = coverCacheKey(book);
    const cached = coverUrlCache.get(key);
    if (cached) {
      setUrl(cached);
      setStatus("ready");
      return;
    }

    let alive = true;
    setUrl(null);
    setStatus("loading");
    void loadCoverUrl(library, book).then((next) => {
      if (!alive) return;
      if (next) {
        setUrl(next);
        setStatus("ready");
      } else {
        setStatus("placeholder");
      }
    });
    return () => {
      alive = false;
    };
  }, [library, hasCover, book.id, book.coverFile, book.coverMime]);

  return (
    <div
      data-book-cover={status}
      className={cn(
        "book-cover relative flex h-[8.5rem] w-[6.25rem] shrink-0 flex-col items-center justify-between overflow-hidden rounded-sm border border-ink/20 p-2 text-paper-soft shadow-inner",
        !book.coverColor && "cover-placeholder-gradient",
        className,
      )}
      style={book.coverColor ? { backgroundColor: book.coverColor } : undefined}
      aria-hidden="true"
    >
      {/* 占位层（渐变或书自身颜色）：无封面、加载中、读取失败时可见；真实封面盖在它上面。 */}
      <span className="h-1 w-6 rounded-full bg-paper-soft/40" />
      <span className="book-cover-title font-serif text-[13px] font-semibold leading-snug">
        {coverLabel(book)}
      </span>
      <span className="h-1 w-6 rounded-full bg-paper-soft/30" />

      {status === "ready" && url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => {
            setStatus("placeholder");
            setUrl(null);
          }}
        />
      ) : null}

      {status === "loading" ? (
        <span className="pointer-events-none absolute inset-0 grid place-items-center bg-ink/15 text-[10px] tracking-wide text-paper-soft/85">
          {loadingLabel ?? "封面加载中"}
        </span>
      ) : null}
    </div>
  );
}
