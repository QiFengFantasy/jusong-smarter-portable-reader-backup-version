import type { TimelineEvent, TimelinePhaseEvent, TimelineTopics } from "./types";

export interface BuiltTimeline {
  available: boolean;
  reason?: string;
  writtenDateLabel: string;
  before: TimelinePhaseEvent[];
  after: TimelinePhaseEvent[];
}

/** 时间线输入：章节 explore 的事件 id + 整书事件库 + 写作日期（用于前后相位）。 */
export interface BuildTimelineInput {
  chapterId: string;
  /** `explore.timeline.eventIds`：本章应展示的事件；已在迁移时按章节规则筛好。 */
  eventIds: readonly string[];
  topics: TimelineTopics | null;
  /** 本章写作日期（来自人工档案 payload.writing.date）；缺失时事件不拆前后。 */
  writingDate?: string;
}

function parseDate(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = value.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 1)];
}

function dateLabel(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!match) return date;
  const [, year, month, day] = match;
  return day ? `${year}年${Number(month)}月${Number(day)}日` : `${year}年${Number(month)}月`;
}

/** 按年/月/日数值比较，避免数组被字符串化后同一年内相位判反（BUG-01）。 */
function compareDateParts(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

function compareDate(a: string, b: string): number {
  const left = parseDate(a);
  const right = parseDate(b);
  if (!left || !right) return a.localeCompare(b);
  return compareDateParts(left, right);
}

function toPhaseEvent(
  event: TimelineEvent,
  chapterId: string,
  written: [number, number, number] | null,
): TimelinePhaseEvent {
  const date = parseDate(event.date);
  // 没有写作日期时不拆前后（全部放在「写成之后」列表，时间轴仍按事件日期排序）。
  const phase: "before" | "after" =
    written && date ? (compareDateParts(date, written) < 0 ? "before" : "after") : "after";
  return {
    ...event,
    dateLabel: event.dateLabel ?? dateLabel(event.date),
    phase,
    articleSpecific: (event.articleIds ?? []).includes(chapterId),
  };
}

/**
 * 按章节 explore 的事件 id 从整书事件库解析时间线。
 *
 * 与旧 `buildTimeline` 的差别（见 CONTRACTS §2.3/§3.3）：
 * - 选哪些事件完全由 `explore.timeline.eventIds` 决定（迁移脚本已按章节规则筛选），
 *   不再在前端按 `config.enabledArticleIds` / 主题 / 时间窗二次过滤；
 * - 仍然用写作日期把事件拆成「写成之前 / 写成之后」两段；
 * - 引用了事件库中不存在的事件 id 时跳过，并在全部缺失时给出原因。
 */
export function buildTimeline({ chapterId, eventIds, topics, writingDate }: BuildTimelineInput): BuiltTimeline {
  const written = parseDate(writingDate);
  const writtenDateLabel = writingDate ? dateLabel(writingDate) : "日期待考";

  if (!topics?.events?.length) {
    return {
      available: false,
      reason: "本书还没有时间线事件库。",
      writtenDateLabel,
      before: [],
      after: [],
    };
  }
  if (eventIds.length === 0) {
    return {
      available: false,
      reason: "本章暂无时间线数据。",
      writtenDateLabel,
      before: [],
      after: [],
    };
  }

  const byId = new Map(topics.events.map((event) => [event.id, event]));
  const before: TimelinePhaseEvent[] = [];
  const after: TimelinePhaseEvent[] = [];
  let missing = 0;

  for (const id of eventIds) {
    const event = byId.get(id);
    if (!event) {
      missing += 1;
      continue;
    }
    const item = toPhaseEvent(event, chapterId, written);
    (item.phase === "before" ? before : after).push(item);
  }

  if (before.length === 0 && after.length === 0) {
    return {
      available: false,
      reason: `本章引用的 ${missing} 个时间线事件在本书事件库中不存在（探索数据可能已过期）。`,
      writtenDateLabel,
      before: [],
      after: [],
    };
  }

  const sortByDate = (items: TimelinePhaseEvent[]) =>
    items.sort((a, b) => compareDate(a.date, b.date));

  return {
    available: true,
    writtenDateLabel,
    before: sortByDate(before),
    after: sortByDate(after),
  };
}
