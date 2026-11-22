import { useMemo } from "react";
import { CalendarClock, MapPin } from "lucide-react";

import { GenerateHintButton } from "../components/reader/GenerateHintButton";
import type { TimelinePhaseEvent, TimelineTopics } from "./types";
import { buildTimeline } from "./timeline";

interface TimelineViewProps {
  chapterId: string;
  chapterTitle?: string;
  /** 整书时间线事件库（shared/topics 事实源）。 */
  topics: TimelineTopics | null;
  /** 本章 explore.timeline.eventIds：决定展示哪些事件。 */
  eventIds: readonly string[];
  /** 本章写作日期（人工档案 payload.writing.date）；用于拆「写成之前 / 之后」。 */
  writingDate?: string;
  placeNames: Map<string, string>;
  onFocusPlace: (placeId: string) => void;
}

function EventCard({
  event,
  placeNames,
  onFocus,
}: {
  event: TimelinePhaseEvent;
  placeNames: Map<string, string>;
  onFocus: (placeId: string) => void;
}) {
  const places = (event.placeIds ?? []).map((id) => placeNames.get(id) ?? id);
  return (
    <button
      type="button"
      className="w-full rounded-lg border border-border/80 bg-paper/70 p-3 text-left transition-colors hover:border-cinnabar/40 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
      onClick={() => {
        const first = event.placeIds?.[0];
        if (first) onFocus(first);
      }}
      disabled={!event.placeIds?.length}
      title={event.sources?.map((source) => source.label).join("\n")}
    >
      <span className="flex items-center gap-2">
        <span className="font-serif text-[11px] text-cinnabar">{event.dateLabel}</span>
        {event.articleSpecific ? (
          <span className="rounded-sm bg-cinnabar px-1.5 py-0.5 text-[9px] text-paper-soft">本文相关</span>
        ) : null}
      </span>
      <span className="mt-1 block font-serif text-sm font-semibold leading-snug text-ink">
        {event.title}
      </span>
      <span className="mt-1 block text-[11px] leading-5 text-ink-soft">{event.summary}</span>
      {places.length > 0 ? (
        <span className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-soft/70">
          <MapPin className="h-3 w-3" aria-hidden="true" />
          {places.join("、")}
        </span>
      ) : null}
    </button>
  );
}

/**
 * 阅读器右栏「时间线」：按本章 explore.timeline.eventIds 从整书事件库解析，
 * 以写作日期为界展示「写成之前 / 写成之后」。
 */
export function TimelineView({
  chapterId,
  chapterTitle,
  topics,
  eventIds,
  writingDate,
  placeNames,
  onFocusPlace,
}: TimelineViewProps) {
  const timeline = useMemo(
    () => buildTimeline({ chapterId, eventIds, topics, writingDate }),
    [chapterId, eventIds, topics, writingDate],
  );
  const total = timeline.before.length + timeline.after.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/70 px-4 py-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-cinnabar" aria-hidden="true" />
          <h2 className="font-serif text-sm font-semibold tracking-[0.2em] text-ink-soft">时间线</h2>
          {timeline.available ? (
            <span className="ml-auto text-[10px] text-ink-soft/60">{total} 个节点</span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-xs text-ink-soft/70">{chapterTitle ?? "当前章节"}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4">
        {!timeline.available ? (
          <div className="rounded-lg border border-dashed border-border bg-paper-soft/40 px-4 py-8 text-center">
            <p className="font-serif text-sm font-semibold text-ink">时间线待生成</p>
            <p className="mt-2 text-xs leading-6 text-ink-soft">{timeline.reason}</p>
            <GenerateHintButton label="生成时间线" className="mt-4" />
          </div>
        ) : (
          <>
            <section aria-label="写成之前">
              <h3 className="flex items-center justify-between font-serif text-sm font-semibold text-ink">
                写成之前 <span className="text-[10px] font-normal text-ink-soft/60">{timeline.before.length} 个节点</span>
              </h3>
              <div className="mt-2 space-y-2 border-l border-border pl-3">
                {timeline.before.length === 0 ? (
                  <p className="text-xs text-ink-soft/60">暂无前置节点。</p>
                ) : (
                  timeline.before.map((event) => (
                    <EventCard key={event.id} event={event} placeNames={placeNames} onFocus={onFocusPlace} />
                  ))
                )}
              </div>
            </section>

            <div className="my-5 flex items-center gap-2 rounded-md border border-cinnabar/30 bg-cinnabar/5 px-3 py-2">
              <span className="h-2 w-2 rounded-full bg-cinnabar" aria-hidden="true" />
              <span className="text-[11px] tracking-widest text-cinnabar">本文写成</span>
              <strong className="ml-auto font-serif text-sm text-cinnabar">{timeline.writtenDateLabel}</strong>
            </div>

            <section aria-label="写成之后">
              <h3 className="flex items-center justify-between font-serif text-sm font-semibold text-ink">
                写成之后 <span className="text-[10px] font-normal text-ink-soft/60">{timeline.after.length} 个节点</span>
              </h3>
              <div className="mt-2 space-y-2 border-l border-border pl-3">
                {timeline.after.length === 0 ? (
                  <p className="text-xs text-ink-soft/60">暂无后续节点。</p>
                ) : (
                  timeline.after.map((event) => (
                    <EventCard key={event.id} event={event} placeNames={placeNames} onFocus={onFocusPlace} />
                  ))
                )}
              </div>
            </section>
            <p className="mt-6 border-t border-dashed border-border pt-3 text-[10px] leading-5 text-ink-soft/60">
              时间线为辅助阅读的背景索引，按本章探索数据筛选，不是完整年表。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
