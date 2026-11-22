import { Fragment, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Archive,
  ExternalLink,
  Info,
  Loader2,
  MapPin,
  RefreshCw,
  Route,
  Sparkles,
} from "lucide-react";

import { useBookTopics } from "../../extensions/useBookTopics";
import { useLibrary } from "../../lib/library";
import {
  confidenceClass,
  confidenceLabel,
  dossierPayload,
  groupDossierBlocks,
  paragraphRefs,
  sourceRefGroups,
  sourceTypeLabel,
  type DossierBlock,
  type DossierSource,
} from "../../lib/knowledge";
import { useChapterKnowledge } from "../../lib/useChapterKnowledge";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { DossierRecordDialog } from "./DossierRecordDialog";
import { GenerateHintButton } from "./GenerateHintButton";

interface ChapterSummaryPanelProps {
  bookId: string;
  chapterId?: string;
  chapterTitle?: string;
  /** 点击「原文：n段」跳到正文对应段落；由 ReaderPage 负责滚动与「回到阅读位置」。 */
  onJumpToBlock?: (blockId: string) => void;
  className?: string;
}

const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-border/70 bg-paper-soft/80 px-2 py-0.5 text-[11px] leading-4 text-ink-soft";

const VOLUME_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

function volumeLabel(volume?: number): string {
  if (!volume || volume < 1) return "";
  return "第" + (VOLUME_NUMERALS[volume - 1] ?? String(volume)) + "卷";
}

function SectionTitle({ children, count }: { children: string; count?: number }) {
  return (
    <h3 className="flex items-center gap-2 border-b border-border/70 pb-1 font-serif text-[13px] font-semibold tracking-[0.1em] text-cinnabar">
      {children}
      {typeof count === "number" ? (
        <span className="text-[10px] font-normal tracking-normal text-ink-soft/50">{count}</span>
      ) : null}
    </h3>
  );
}

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: JSX.Element;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 flex w-10 shrink-0 items-center gap-1 whitespace-nowrap text-[10px] tracking-wider text-ink-soft/60">
        {icon}
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex flex-wrap items-center rounded-full border border-cinnabar/30 bg-cinnabar/5 px-1.5 py-0.5 text-[10px] leading-4 text-cinnabar/90"
    >
      {children}
    </span>
  );
}

function RefLink({
  children,
  title,
  onClick,
}: {
  children: ReactNode;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded-sm px-0.5 underline decoration-cinnabar/30 underline-offset-2 transition-colors hover:bg-cinnabar/10 hover:text-cinnabar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
    >
      {children}
    </button>
  );
}

function BlockCard({
  block,
  index,
  emphasized,
  sources,
  onJumpParagraph,
  onJumpSource,
}: {
  block: DossierBlock;
  index: number;
  emphasized: boolean;
  sources?: DossierSource[];
  onJumpParagraph?: (paragraphId: string) => void;
  onJumpSource?: (sourceIndex: number) => void;
}) {
  const refs = paragraphRefs(block);
  const sourceGroups = sourceRefGroups(block, sources);
  const hasChips = refs.length > 0 || sourceGroups.length > 0;

  return (
    <article
      className={cn(
        "min-w-0",
        emphasized && "rounded-md border-l-2 border-cinnabar/60 bg-cinnabar/[0.04] px-2.5 py-2",
      )}
    >
      {block.title ? (
        <h4 className="font-serif text-[13px] font-semibold leading-snug text-ink">{block.title}</h4>
      ) : null}
      {block.text ? (
        <p
          className={cn(
            "mt-1 font-serif text-[13px] leading-7 text-ink-soft",
            emphasized && "text-ink/90",
          )}
        >
          {block.text}
        </p>
      ) : null}
      {hasChips ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {refs.length > 0 ? (
            <Chip
              title={refs
                .map((ref) => ref.paragraphId + (ref.quote ? "：" + ref.quote : ""))
                .join("\n")}
            >
              <span>原文：</span>
              {refs.map((ref, refIndex) => (
                <Fragment key={ref.paragraphId}>
                  {refIndex > 0 ? <span className="px-0.5">、</span> : null}
                  <RefLink
                    title={ref.quote}
                    onClick={() => onJumpParagraph?.(ref.paragraphId)}
                  >
                    {ref.ordinal !== null ? ref.ordinal + "段" : ref.paragraphId}
                  </RefLink>
                </Fragment>
              ))}
            </Chip>
          ) : null}
          {sourceGroups.map((group) => (
            <Chip
              key={group.label}
              title={group.entries
                .map((entry) => entry.index + ". " + (entry.source.label ?? ""))
                .join("\n")}
            >
              <span>{group.label}：</span>
              {group.entries.map((entry, entryIndex) => (
                <Fragment key={entry.index}>
                  {entryIndex > 0 ? <span className="px-0.5">、</span> : null}
                  <RefLink
                    title={entry.source.label}
                    onClick={() => onJumpSource?.(entry.index)}
                  >
                    {entry.index}篇
                  </RefLink>
                </Fragment>
              ))}
            </Chip>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function ChapterSummaryPanel({
  bookId,
  chapterId,
  chapterTitle,
  onJumpToBlock,
  className,
}: ChapterSummaryPanelProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeSource, setActiveSource] = useState<number | null>(null);
  const sourceRefs = useRef(new Map<number, HTMLLIElement>());
  const { digest, archive, loading, error } = useChapterKnowledge(bookId, chapterId, refreshKey);
  const { library } = useLibrary();
  const topics = useBookTopics(library, bookId || null);
  const payload = dossierPayload(archive);

  const sections = useMemo(() => groupDossierBlocks(payload?.blocks), [payload]);
  // 没有旧档案时退回摘要里的要点（例如只有 digest 的章节）。
  const digestSections = useMemo(() => {
    if (!digest?.keyPoints?.length) return [];
    return groupDossierBlocks(
      digest.keyPoints.map((point, index) => ({
        id: "digest-" + index,
        section: point.section,
        title: point.title,
        text: point.text,
        citations: point.citations,
      })),
    );
  }, [digest]);
  const sectionsToRender = sections.length > 0 ? sections : digestSections;
  const confidence = confidenceLabel(payload?.confidence);
  const writing = payload?.writing ?? digest?.writing;

  const themeNames = useMemo(() => {
    const ids = payload?.map?.themeIds ?? digest?.themes ?? [];
    const themes = topics.map?.themes ?? [];
    return ids.map((id) => themes.find((theme) => theme.id === id)?.name).filter(Boolean) as string[];
  }, [payload, digest, topics.map]);

  const routeNames = useMemo(() => {
    const ids = payload?.map?.routeIds ?? digest?.map?.routeIds ?? [];
    const routes = topics.map?.routes.features ?? [];
    return ids
      .map((id) => routes.find((route) => route.properties.id === id)?.properties.name)
      .filter(Boolean) as string[];
  }, [payload, digest, topics.map]);

  // 写作地点已经在上面的写作信息里展示，地点行只保留路线沿途的其他地点，避免重复。
  const writingPlaceIds = useMemo(
    () => new Set([...(payload?.writing?.placeIds ?? []), ...(digest?.writing?.placeIds ?? [])]),
    [payload, digest],
  );

  const places = useMemo(() => {
    const ids = [
      ...new Set([...(payload?.map?.placeIds ?? []), ...(digest?.map?.placeIds ?? [])]),
    ].filter((id) => !writingPlaceIds.has(id));
    const all = topics.map?.places ?? [];
    return ids.map((id) => all.find((place) => place.id === id)).filter(Boolean);
  }, [payload, digest, topics.map, writingPlaceIds]);

  const title = payload?.title ?? digest?.title ?? chapterTitle ?? "本章";
  const crumbs = useMemo(() => {
    const volume = volumeLabel(payload?.volume);
    return [volume, payload?.period].filter(Boolean).join(" · ");
  }, [payload]);
  const dateText = payload?.dateText ?? "";
  const hasMetaCard = Boolean(
    writing?.date || writing?.placeName || themeNames.length || routeNames.length || places.length,
  );

  /** 「专著：2篇」点击：滚到参考来源第 index 项并短暂高亮。 */
  const focusSource = (index: number) => {
    const element = sourceRefs.current.get(index);
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    setActiveSource(index);
    window.setTimeout(() => {
      setActiveSource((current) => (current === index ? null : current));
    }, 2000);
  };

  if (!chapterId) {
    return (
      <div className={cn("flex h-full items-center justify-center px-5 text-center", className)}>
        <p className="text-xs leading-6 text-ink-soft/70">选择章节后，这里显示本章摘要。</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={cn("flex h-full items-center justify-center gap-2 text-xs text-ink-soft", className)}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        正在读取档案…
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("flex h-full flex-col items-center justify-center gap-3 px-5", className)}>
        <p className="text-xs leading-6 text-cinnabar">档案加载失败</p>
        <p className="text-center text-[11px] leading-5 text-ink-soft/70">{error}</p>
        <button
          type="button"
          onClick={() => setRefreshKey((value) => value + 1)}
          className="inline-flex items-center gap-1 rounded-md border border-border/80 px-2.5 py-1 text-[11px] text-ink-soft hover:text-ink"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          重试
        </button>
      </div>
    );
  }

  if (!payload && !digest) {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-3 px-6 text-center",
          className,
        )}
      >
        <p className="text-xs leading-6 text-ink-soft/70">
          本章摘要尚未生成。
          <br />
          可以先阅读原文，或后续用分析接口生成摘要。
        </p>
        <GenerateHintButton label="生成摘要" />
      </div>
    );
  }

  return (
    <>
      <ScrollArea className={cn("h-full", className)}>
        <div className="space-y-5 px-4 pb-8 pt-4">
          <header className="min-w-0">
            {crumbs ? (
              <p className="truncate text-[10px] tracking-[0.22em] text-ink-soft/60">{crumbs}</p>
            ) : null}
            <div className="mt-1 flex items-start gap-2">
              <h2 className="min-w-0 flex-1 font-serif text-[17px] font-semibold leading-snug tracking-wide text-ink">
                {title}
              </h2>
              <button
                type="button"
                onClick={() => setRefreshKey((value) => value + 1)}
                className="shrink-0 rounded p-1 text-ink-soft/60 transition-colors hover:bg-muted/60 hover:text-ink"
                aria-label="刷新本章摘要"
                title="刷新本章摘要"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {dateText ? <span className="text-[11px] text-ink-soft/70">{dateText}</span> : null}
              {confidence ? (
                <span
                  className={cn(
                    "rounded-sm border px-1.5 py-0.5 text-[10px] leading-4",
                    confidenceClass(payload?.confidence),
                  )}
                  title="档案整体置信度"
                >
                  {confidence}
                </span>
              ) : null}
            </div>
          </header>

          {hasMetaCard ? (
            <div className="space-y-2.5 rounded-md border border-border/70 bg-paper/60 p-3">
              {writing?.date || writing?.placeName ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                  {writing.date ? (
                    <div className="min-w-0">
                      <dt className="text-[10px] tracking-wider text-ink-soft/60">写作时间</dt>
                      <dd className="mt-0.5 font-serif text-[13px] leading-5 text-ink">
                        {writing.date}
                      </dd>
                    </div>
                  ) : null}
                  {writing.placeName ? (
                    <div className="min-w-0">
                      <dt className="text-[10px] tracking-wider text-ink-soft/60">写作地点</dt>
                      <dd className="mt-0.5 font-serif text-[13px] leading-5 text-ink">
                        {writing.placeName}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}

              {themeNames.length > 0 ? (
                <MetaRow icon={<Sparkles className="h-3 w-3" aria-hidden="true" />} label="主题">
                  {themeNames.map((name) => (
                    <span key={name} className={CHIP}>
                      {name}
                    </span>
                  ))}
                </MetaRow>
              ) : null}

              {routeNames.length > 0 ? (
                <MetaRow icon={<Route className="h-3 w-3" aria-hidden="true" />} label="路线">
                  {routeNames.map((name) => (
                    <span
                      key={name}
                      className={cn(CHIP, "border-cinnabar/25 bg-cinnabar/5 text-cinnabar/90")}
                    >
                      {name}
                    </span>
                  ))}
                </MetaRow>
              ) : null}

              {places.length > 0 ? (
                <MetaRow icon={<MapPin className="h-3 w-3" aria-hidden="true" />} label="地点">
                  {places.map((place) =>
                    place ? (
                      <span key={place.id} className={CHIP} title={place.modernName ?? place.name}>
                        {place.name}
                      </span>
                    ) : null,
                  )}
                </MetaRow>
              ) : null}
            </div>
          ) : null}

          {(payload?.writing?.dateNote || payload?.writing?.note) ? (
            <div className="space-y-1.5">
              {payload?.writing?.dateNote ? (
                <p className="flex gap-1.5 text-[11px] leading-5 text-ink-soft/70">
                  <Info className="mt-0.5 h-3 w-3 shrink-0 text-ink-soft/50" aria-hidden="true" />
                  <span className="min-w-0">{payload.writing.dateNote}</span>
                </p>
              ) : null}
              {payload?.writing?.note ? (
                <p className="flex gap-1.5 text-[11px] leading-5 text-ink-soft/70">
                  <Info className="mt-0.5 h-3 w-3 shrink-0 text-ink-soft/50" aria-hidden="true" />
                  <span className="min-w-0">{payload.writing.note}</span>
                </p>
              ) : null}
            </div>
          ) : null}

          {sectionsToRender.length > 0
            ? sectionsToRender.map((section) => (
                <section key={section.id} className="min-w-0">
                  <SectionTitle count={section.blocks.length}>{section.label}</SectionTitle>
                  <div className="mt-2 space-y-3">
                    {section.blocks.map((block, index) => (
                      <BlockCard
                        key={block.id ?? section.id + "-" + index}
                        block={block}
                        index={index}
                        emphasized={section.id === "overview" && index === 0}
                        sources={payload?.sources}
                        onJumpParagraph={onJumpToBlock}
                        onJumpSource={focusSource}
                      />
                    ))}
                  </div>
                </section>
              ))
            : null}

          {sectionsToRender.length === 0 && digest ? (
            <section className="min-w-0 space-y-2">
              <SectionTitle>结构摘要</SectionTitle>
              <p className="text-[11px] leading-5 text-ink-soft/70">
                这本书没有人工档案，以下是导入时自动生成的结构摘要。
              </p>
              <dl className="grid grid-cols-2 gap-2">
                {[
                  ["字数", digest.stats.charCount.toLocaleString()],
                  ["段落", String(digest.stats.paragraphCount)],
                  ["小标题", String(digest.stats.headingCount)],
                  ["注释", String(digest.stats.noteCount)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md border border-border/60 bg-paper/60 px-2 py-1.5">
                    <dt className="text-[10px] text-ink-soft/55">{label}</dt>
                    <dd className="mt-0.5 font-serif text-[13px] text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              {digest.headings.length > 0 ? (
                <ul className="space-y-1">
                  {digest.headings.slice(0, 8).map((heading) => (
                    <li key={heading} className="flex gap-1.5 text-[12px] leading-5 text-ink-soft">
                      <span className="text-cinnabar/60" aria-hidden="true">
                        ·
                      </span>
                      <span className="min-w-0">{heading}</span>
                    </li>
                  ))}
                  {digest.headings.length > 8 ? (
                    <li className="text-[10px] text-ink-soft/50">…共 {digest.headings.length} 个小标题</li>
                  ) : null}
                </ul>
              ) : null}
              {digest.opening ? (
                <p className="line-clamp-6 border-l-2 border-border pl-2 font-serif text-[12px] leading-6 text-ink-soft/80">
                  {digest.opening}
                </p>
              ) : null}
            </section>
          ) : null}

          {payload?.sources && payload.sources.length > 0 ? (
            <section className="min-w-0">
              <SectionTitle count={payload.sources.length}>参考来源</SectionTitle>
              <ul className="mt-2 space-y-1.5">
                {payload.sources.map((source, index) => (
                  <li
                    key={source.id ?? "source-" + index}
                    ref={(element) => {
                      if (element) sourceRefs.current.set(index + 1, element);
                    }}
                    className={cn(
                      "flex scroll-mt-2 items-start gap-1.5 rounded-sm text-[11px] leading-5 text-ink-soft transition-colors",
                      activeSource === index + 1 && "bg-cinnabar/[0.06] ring-1 ring-cinnabar/20",
                    )}
                  >
                    <span className="mt-0.5 w-4 shrink-0 text-right text-[9px] leading-4 text-ink-soft/40">
                      {index + 1}.
                    </span>
                    <span className="mt-0.5 shrink-0 whitespace-nowrap rounded-full border border-cinnabar/30 bg-cinnabar/5 px-2 py-0.5 text-[10px] leading-4 text-cinnabar/90">
                      {sourceTypeLabel(source.type)}
                    </span>
                    <span className="min-w-0 break-words">
                      {source.url ? (
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline decoration-border/80 underline-offset-2 transition-colors hover:text-cinnabar"
                        >
                          {source.label}
                          <ExternalLink className="ml-1 inline h-2.5 w-2.5" aria-hidden="true" />
                        </a>
                      ) : (
                        source.label
                      )}
                      {source.locator ? (
                        <span className="ml-1 text-ink-soft/55">· {source.locator}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {archive ? (
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border/80 bg-paper-soft/70 px-3 py-2 text-[12px] text-ink-soft transition-colors hover:border-cinnabar/30 hover:text-ink"
            >
              <Archive className="h-3.5 w-3.5" aria-hidden="true" />
              查看原始档案记录
            </button>
          ) : null}
        </div>
      </ScrollArea>

      <DossierRecordDialog entry={archive} open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
