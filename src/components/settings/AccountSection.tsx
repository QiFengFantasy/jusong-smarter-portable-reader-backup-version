import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { HardDrive, Loader2, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";

import {
  getCachedKnowledgeOverview,
  loadKnowledgeOverview,
  type KnowledgeBookSummary,
} from "../../lib/knowledge-library";
import { useKnowledgeCache } from "../../lib/useKnowledgeCache";
import { useLibrary } from "../../lib/library";
import { getErrorMessage } from "../../lib/utils";
import { HeroArt } from "../brand/HeroArt";
import { ErrorPanel } from "../feedback";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { SettingsCardHeader } from "./SettingsSectionNav";

/**
 * 账号分类：书斋身份区（Hero）+ 书籍/档案/摘要/书签统计。
 *
 * 沮诵没有远端账号体系，「账号」就是本机用户库：这里展示书斋规模与数据口径，
 * 强调书籍、档案、摘要与书签都只在本地用户库（appData），不联网、不上传。
 *
 * 统计复用首页知识总览的 `loadKnowledgeOverview`（逐本读档案、章节摘要与书签，单本失败按 0 计），
 * 数据统一走 `knowledge-cache.ts` 的内存会话缓存：从首页「知识」再进「账号」不重复发 IPC，
 * 书签总数由各书缓存的书签数汇总（不再额外 `listBookmarks()` 全量读取）；书籍数直接用 `useLibrary()`
 * 的书架数据，保证与书架/知识口径一致。
 */

/** 「本地优先」说明的单个小标签。 */
function LocalFirstChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-paper/60 px-2.5 py-1 text-[11px] text-ink-soft">
      <span className="text-cinnabar" aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}

/** 统计数字块：数字用 serif 大字号，加载中显示占位，单位小字跟在后面。 */
function StatTile({
  label,
  value,
  unit,
  loading,
}: {
  label: string;
  value: number | null;
  unit: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-paper/60 px-4 py-3">
      <p className="text-[11px] tracking-wide text-ink-soft">{label}</p>
      <p className="mt-1 font-serif text-2xl font-semibold tabular-nums leading-tight text-ink">
        {value === null ? (
          loading ? (
            <span
              className="inline-block h-6 w-10 animate-pulse rounded bg-muted align-middle"
              aria-hidden="true"
            />
          ) : (
            <span className="text-ink-soft/60">—</span>
          )
        ) : (
          value
        )}
        <span className="ml-1 font-sans text-xs font-normal text-ink-soft">{unit}</span>
      </p>
    </div>
  );
}

/** 书斋 Hero：复用书架/知识库的纸墨 Hero 语汇（HeroArt 水印 + 印章 + 朱红细线）。 */
function AccountHero() {
  return (
    <Card className="relative overflow-hidden">
      <HeroArt variant="compact" />
      <div className="relative px-5 py-6 sm:px-6">
        <p className="text-[10px] uppercase tracking-[0.42em] text-cinnabar/80">JUSONG · 账号</p>
        <h2 className="mt-2 font-serif text-xl font-semibold tracking-wide sm:text-2xl">
          书斋之内，皆是本地。
        </h2>
        <p className="mt-2 max-w-xl text-xs leading-6 text-ink-soft">
          沮诵没有云端账号：你的书斋就是这台设备上的用户库（appData）。书籍、档案、摘要与设置都只保存在本机，
          阅读与检索离线可用；AGENT 是唯一可选的联网增强。
        </p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <LocalFirstChip icon={<HardDrive className="h-3 w-3" />}>用户库 · appData</LocalFirstChip>
          <LocalFirstChip icon={<WifiOff className="h-3 w-3" />}>离线可读</LocalFirstChip>
          <LocalFirstChip icon={<ShieldCheck className="h-3 w-3" />}>不上传</LocalFirstChip>
        </div>
      </div>
    </Card>
  );
}

/** 书斋统计卡：书籍 / 档案 / 摘要 / 书签，含加载、失败与空书架状态。数据走知识内存缓存。 */
function LibraryStatsCard() {
  const { library, books, status, booksError } = useLibrary();
  const cache = useKnowledgeCache();

  // 缓存命中时同步给出统计：不闪占位、不重复读取（冷启动缓存为空才走 IPC）。
  const mountOverviewRef = useRef<KnowledgeBookSummary[] | null | undefined>(undefined);
  if (mountOverviewRef.current === undefined) {
    mountOverviewRef.current = library ? getCachedKnowledgeOverview(books) : null;
  }

  const [overview, setOverview] = useState<KnowledgeBookSummary[] | null>(
    mountOverviewRef.current ?? null,
  );
  const [loading, setLoading] = useState(mountOverviewRef.current === null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const requestRef = useRef(0);

  useEffect(() => {
    if (!library) {
      setOverview(null);
      setLoading(status === "initializing");
      setError(status === "error" ? (booksError ?? "书库尚未就绪，暂时无法统计。") : null);
      return;
    }

    const cached = getCachedKnowledgeOverview(books);
    if (cached) {
      setOverview(cached);
      setLoading(false);
      setError(null);
      setProgress({ done: books.length, total: books.length });
      return;
    }

    let alive = true;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    setError(null);
    setProgress({ done: 0, total: books.length });

    loadKnowledgeOverview(library, books, (done, total) => {
      if (alive && request === requestRef.current) setProgress({ done, total });
    })
      .then((summaries) => {
        if (!alive || request !== requestRef.current) return;
        setOverview(summaries);
      })
      .catch((reason: unknown) => {
        if (alive && request === requestRef.current) setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (alive && request === requestRef.current) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [library, books, status, booksError, cache.version]);

  const totals = useMemo(() => {
    const summaries = overview ?? [];
    return summaries.reduce(
      (accumulator, summary) => ({
        archives: accumulator.archives + summary.archiveCount,
        digests: accumulator.digests + summary.digestCount,
        chapters: accumulator.chapters + summary.chapterCount,
        bookmarks: accumulator.bookmarks + summary.bookmarkCount,
      }),
      { archives: 0, digests: 0, chapters: 0, bookmarks: 0 },
    );
  }, [overview]);

  // 统计完成前不显示 0，避免把「还在统计」误读成「没有内容」。
  const ready = overview !== null && !error;
  const bookCount = ready ? (overview?.length ?? books.length) : null;
  const archiveCount = ready ? totals.archives : null;
  const digestCount = ready ? totals.digests : null;
  const bookmarkCount = ready ? totals.bookmarks : null;
  const emptyShelf = ready && bookCount === 0;

  // 手动刷新必须先失效缓存再重载（失效会通知本视图，effect 依赖 cache.version 重新读取）。
  const refresh = () => cache.invalidateAll();

  return (
    <Card>
      <SettingsCardHeader
        title="书斋概览"
        description="按书架里每本书统计：书籍为本数，档案为人工整理条目，摘要为导入时按章自动生成的结构摘要，书签为阅读器里保存的阅读现场记录；统计只在本机读取，不联网。"
        action={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={refresh}
            disabled={!library || loading}
            aria-label="重新统计书斋概览"
            title="重新统计书斋概览"
          >
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
          </Button>
        }
      />
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="书籍" value={bookCount} unit="本" loading={loading} />
          <StatTile label="档案" value={archiveCount} unit="篇" loading={loading} />
          <StatTile label="摘要" value={digestCount} unit="篇" loading={loading} />
          <StatTile label="书签" value={bookmarkCount} unit="个" loading={loading} />
        </div>

        {loading ? (
          <p role="status" aria-live="polite" className="flex items-center gap-2 text-[11px] text-ink-soft">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {progress.total > 0
              ? `正在统计 ${progress.done}/${progress.total} 本…`
              : "正在准备统计…"}
          </p>
        ) : null}

        {error ? (
          <ErrorPanel
            title="书斋统计失败"
            message={error}
            onRetry={refresh}
            retryLabel="重新统计"
          />
        ) : null}

        {emptyShelf ? (
          <div className="rounded-md border border-dashed border-border/80 bg-paper/40 px-4 py-6 text-center">
            <p className="font-serif text-sm tracking-wide text-ink">书架尚空</p>
            <p className="mx-auto mt-1.5 max-w-md text-xs leading-6 text-ink-soft">
              在首页书架导入 EPUB 后，这里会显示藏书、档案、章节摘要与书签的规模。
            </p>
          </div>
        ) : null}

        {ready && !emptyShelf ? (
          <p className="rounded-md border border-dashed border-border/80 bg-paper/50 px-3 py-2 text-[11px] leading-5 text-ink-soft/75">
            统计覆盖 <span className="text-ink">{totals.chapters}</span> 章；档案为人工整理，摘要由导入时自动生成（按章一份），
            与首页「知识」的口径一致。
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** 账号分类主体：Hero + 书斋统计。 */
export function AccountSection() {
  return (
    <div className="space-y-4">
      <AccountHero />
      <LibraryStatsCard />
    </div>
  );
}
