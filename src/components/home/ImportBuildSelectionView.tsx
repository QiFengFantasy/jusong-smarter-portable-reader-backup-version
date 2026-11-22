import { useId, useMemo, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  BookMarked,
  Clock,
  Coins,
  FileText,
  Loader2,
  MapPin,
  PhoneCall,
  Settings2,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BookMeta } from "@jusong/core";

import { Button } from "../ui/button";
import { PlaceholderPage } from "./PlaceholderPanel";
import { cn } from "../../lib/utils";
import { BUILD_ITEMS, isBuildItemId } from "../../lib/import-build/types";
import type { BuildItemId } from "../../lib/import-build/types";
import { estimateImportBuild } from "../../lib/import-build/estimate";

/**
 * 构建条目顺序与卡片文案来自 `src/lib/import-build/types.ts` 的 `BUILD_ITEMS`
 * （摘要 / 档案 / 地图地点 / 时间线），这里只补界面图标。
 */
const BUILD_ITEM_ORDER: readonly BuildItemId[] = BUILD_ITEMS.map((item) => item.id);

const ICON_BY_ITEM: Record<BuildItemId, LucideIcon> = {
  digest: FileText,
  archive: BookMarked,
  place: MapPin,
  timeline: Clock,
};

const ITEM_DEFINITION_BY_ID = new Map(BUILD_ITEMS.map((item) => [item.id, item] as const));

function itemView(item: BuildItemId): { title: string; description: string; icon: LucideIcon } {
  const definition = ITEM_DEFINITION_BY_ID.get(item);
  return {
    title: definition?.title ?? item,
    description: definition?.description ?? "",
    icon: ICON_BY_ITEM[item],
  };
}

/** HTML5 拖拽的自定义 MIME；退化到 text/plain 时也能读回条目 id。 */
const DRAG_MIME = "application/x-jusong-build-item";

/** token 数 → 紧凑可读（12k / 1.2k / 480）。 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

function formatRange(min: number, max: number, unit: string): string {
  return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
}

function formatTokenRange(min: number, max: number): string {
  return min === max ? `${formatTokens(min)} token` : `${formatTokens(min)}–${formatTokens(max)} token`;
}

interface BuildCardProps {
  item: BuildItemId;
  active: boolean;
  onToggle: (item: BuildItemId) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, item: BuildItemId) => void;
}

/** 单张构建条目卡片：点击 / 回车 / 空格切换归属，同时是 HTML5 拖拽源。 */
function BuildCard({ item, active, onToggle, onDragStart }: BuildCardProps) {
  const meta = itemView(item);
  const Icon = meta.icon;
  const hint = active ? "点击移出构建" : "点击加入构建";

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle(item);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      aria-pressed={active}
      aria-label={`${meta.title}（${active ? "已选" : "可选"}）：${hint}`}
      title={`${meta.title} · ${hint}`}
      onClick={() => onToggle(item)}
      onKeyDown={handleKeyDown}
      onDragStart={(event) => onDragStart(event, item)}
      className={cn(
        "group flex cursor-grab items-start gap-3 rounded-lg border px-3.5 py-3 text-left outline-none transition-colors active:cursor-grabbing",
        "focus-visible:ring-2 focus-visible:ring-cinnabar/40",
        active
          ? "border-cinnabar bg-cinnabar text-paper-soft shadow-sm"
          : "border-border bg-paper/80 text-ink hover:border-cinnabar/40 hover:bg-cinnabar/[0.04]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border",
          active
            ? "border-paper-soft/30 bg-paper-soft/10 text-paper-soft"
            : "border-cinnabar/20 bg-cinnabar/[0.06] text-cinnabar",
        )}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-serif text-sm font-semibold tracking-wide">{meta.title}</span>
          <span
            className={cn(
              "rounded-sm border px-1 py-px text-[10px] leading-4 tracking-wider",
              active ? "border-paper-soft/30 text-paper-soft/85" : "border-border text-ink-soft/75",
            )}
          >
            {active ? "已选" : "可选"}
          </span>
        </span>
        <span
          className={cn(
            "mt-1 block text-[11px] leading-5",
            active ? "text-paper-soft/80" : "text-ink-soft/80",
          )}
        >
          {meta.description}
        </span>
        <span
          className={cn(
            "mt-1 block text-[10px] leading-4",
            active ? "text-paper-soft/65" : "text-ink-soft/55",
          )}
        >
          {hint}
        </span>
      </span>
    </div>
  );
}

export interface ImportBuildSelectionViewProps {
  book: BookMeta;
  agentConfigured: boolean;
  onStart: (selected: BuildItemId[]) => void;
  onSkip: () => void;
  onConfigureAgent: () => void;
  /**
   * 父级正在校验 AGENT 配置 / 切换步骤时禁用开始按钮（构建中本组件不会显示）。
   * 契约未列出该可选字段，默认 false，仅用于「构建中/校验中禁用开始」。
   */
  busy?: boolean;
}

/**
 * 导入第二流程 · 构建条目选择页。
 *
 * - 上抽屉 = 已选、下抽屉 = 可选；卡片可 HTML5 拖拽互转，也可点击 / 回车 / 空格切换；
 * - 已选卡片朱红填充（`bg-cinnabar text-paper-soft`）表示激活；
 * - 两个抽屉头部各有一个全量箭头：上「↓ 全部移出」、下「↑ 全部加入」；
 * - 实时估算调用次数 / token 范围 / 用时范围（`estimateImportBuild`），不显示金额；
 * - 无 AGENT Key 时提示并提供「去设置」；未选条目 / 无 Key / 校验中禁用「开始构建」。
 */
export function ImportBuildSelectionView({
  book,
  agentConfigured,
  onStart,
  onSkip,
  onConfigureAgent,
  busy = false,
}: ImportBuildSelectionViewProps) {
  const selectedHeadingId = useId();
  const availableHeadingId = useId();
  const [selected, setSelected] = useState<BuildItemId[]>([]);
  const [dragOver, setDragOver] = useState<"selected" | "available" | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const available = useMemo(
    () => BUILD_ITEM_ORDER.filter((item) => !selectedSet.has(item)),
    [selectedSet],
  );
  const estimate = useMemo(
    () => estimateImportBuild(book.chapterCount, selected),
    [book.chapterCount, selected],
  );

  const addItem = (item: BuildItemId) => {
    setSelected((current) =>
      current.includes(item) ? current : BUILD_ITEM_ORDER.filter((id) => id === item || current.includes(id)),
    );
  };

  const removeItem = (item: BuildItemId) => {
    setSelected((current) => (current.includes(item) ? current.filter((id) => id !== item) : current));
  };

  const toggleItem = (item: BuildItemId) => {
    if (selectedSet.has(item)) removeItem(item);
    else addItem(item);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, item: BuildItemId) => {
    event.dataTransfer.setData(DRAG_MIME, item);
    event.dataTransfer.setData("text/plain", item);
    event.dataTransfer.effectAllowed = "move";
    setDragOver(null);
  };

  const handleDragOver = (target: "selected" | "available") => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOver(target);
  };

  const handleDrop = (target: "selected" | "available") => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(null);
    const raw = event.dataTransfer.getData(DRAG_MIME) || event.dataTransfer.getData("text/plain");
    if (!raw || !isBuildItemId(raw)) return;
    if (target === "selected") addItem(raw);
    else removeItem(raw);
  };

  const noChapter = book.chapterCount <= 0;
  const startDisabled = selected.length === 0 || !agentConfigured || busy || noChapter;
  const disabledReason = noChapter
    ? "这本书还没有可构建的章节"
    : busy
      ? "正在检查 AGENT 配置…"
      : !agentConfigured
        ? "请先在设置中配置 AGENT"
        : selected.length === 0
          ? "请先选择至少一个构建条目"
          : undefined;

  const handleStart = () => {
    if (startDisabled) return;
    onStart(selected);
  };

  return (
    <PlaceholderPage
      eyebrow="导入 · 构建知识库"
      title="选择构建条目"
      planLabel={`《${book.title}》 · ${book.chapterCount} 章`}
      description={
        <>
          <p>
            EPUB 已导入本地书库。可以让 AGENT 团队为它生成摘要、档案、地图地点与时间线，并写入本地知识库。
          </p>
          <p className="text-xs leading-6 text-ink-soft/75 sm:text-sm">
            构建会真实调用 AGENT 并消耗 token；跳过不会影响已经完成的书籍导入，之后仍可在阅读器里单独生成。
          </p>
        </>
      }
    >
      <div className="space-y-4">
        <div className="overflow-hidden rounded-xl border border-border bg-paper-soft/70 shadow-paper">
          {/* 上抽屉：已选 */}
          <section aria-labelledby={selectedHeadingId}>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5 sm:px-4">
              <div className="min-w-0">
                <h3
                  id={selectedHeadingId}
                  className="font-serif text-sm font-semibold tracking-wide text-ink"
                >
                  已选条目
                  <span className="ml-2 text-xs font-normal text-ink-soft/80">
                    {selected.length} / {BUILD_ITEM_ORDER.length}
                  </span>
                </h3>
                <p className="mt-0.5 text-[11px] leading-5 text-ink-soft/75">
                  拖到下方抽屉，或点击卡片移出。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelected([])}
                disabled={selected.length === 0}
                title="全部移出（清空已选构建条目）"
                aria-label="全部移出已选条目"
              >
                <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
                全部移出
              </Button>
            </header>
            <div
              className={cn(
                "min-h-[5.5rem] p-3 transition-colors sm:p-3.5",
                dragOver === "selected" && "bg-cinnabar/[0.06]",
              )}
              onDragOver={handleDragOver("selected")}
              onDragLeave={() => setDragOver(null)}
              onDrop={handleDrop("selected")}
            >
              {selected.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-center text-xs leading-6 text-ink-soft/75">
                  还没有选择条目。把下方卡片拖到这里，或点击下方卡片加入。
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {selected.map((item) => (
                    <BuildCard
                      key={item}
                      item={item}
                      active
                      onToggle={toggleItem}
                      onDragStart={handleDragStart}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          <div className="border-t border-border/70" aria-hidden="true" />

          {/* 下抽屉：可选 */}
          <section aria-labelledby={availableHeadingId}>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-3.5 py-2.5 sm:px-4">
              <div className="min-w-0">
                <h3
                  id={availableHeadingId}
                  className="font-serif text-sm font-semibold tracking-wide text-ink"
                >
                  可选条目
                  <span className="ml-2 text-xs font-normal text-ink-soft/80">
                    {available.length} / {BUILD_ITEM_ORDER.length}
                  </span>
                </h3>
                <p className="mt-0.5 text-[11px] leading-5 text-ink-soft/75">
                  拖到上方抽屉，或点击卡片加入。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelected([...BUILD_ITEM_ORDER])}
                disabled={available.length === 0}
                title="全部加入（选择全部四个构建条目）"
                aria-label="全部加入可选条目"
              >
                <ArrowUpToLine className="h-3.5 w-3.5" aria-hidden="true" />
                全部加入
              </Button>
            </header>
            <div
              className={cn(
                "min-h-[5.5rem] p-3 transition-colors sm:p-3.5",
                dragOver === "available" && "bg-cinnabar/[0.06]",
              )}
              onDragOver={handleDragOver("available")}
              onDragLeave={() => setDragOver(null)}
              onDrop={handleDrop("available")}
            >
              {available.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-center text-xs leading-6 text-ink-soft/75">
                  四个条目都已加入上方。
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {available.map((item) => (
                    <BuildCard
                      key={item}
                      item={item}
                      active={false}
                      onToggle={toggleItem}
                      onDragStart={handleDragStart}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* 实时估算 */}
        <div className="rounded-lg border border-dashed border-cinnabar/25 bg-cinnabar/[0.03] px-3.5 py-3">
          <p className="text-[11px] uppercase tracking-[0.3em] text-cinnabar">预计消耗</p>
          {noChapter ? (
            <p className="mt-2 text-xs leading-6 text-ink-soft">这本书没有可构建的章节，无需估算。</p>
          ) : selected.length === 0 ? (
            <p className="mt-2 text-xs leading-6 text-ink-soft/80">选择条目后显示调用次数、token 与用时范围。</p>
          ) : (
            <>
              <dl className="mt-2 grid gap-2 sm:grid-cols-3">
                <div className="flex items-center gap-2">
                  <PhoneCall className="h-3.5 w-3.5 shrink-0 text-cinnabar" aria-hidden="true" />
                  <dt className="text-xs text-ink-soft">调用次数</dt>
                  <dd className="font-serif text-sm font-semibold text-ink">
                    {formatRange(estimate.callsMin, estimate.callsMax, "次")}
                  </dd>
                </div>
                <div className="flex items-center gap-2">
                  <Coins className="h-3.5 w-3.5 shrink-0 text-cinnabar" aria-hidden="true" />
                  <dt className="text-xs text-ink-soft">token</dt>
                  <dd className="font-serif text-sm font-semibold text-ink">
                    {formatTokenRange(estimate.tokensMin, estimate.tokensMax)}
                  </dd>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 shrink-0 text-cinnabar" aria-hidden="true" />
                  <dt className="text-xs text-ink-soft">用时</dt>
                  <dd className="font-serif text-sm font-semibold text-ink">
                    {formatRange(estimate.minutesMin, estimate.minutesMax, "分钟")}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] leading-5 text-ink-soft/70">
                按 {book.chapterCount} 章、{estimate.batchCount} 批估算；审查多轮会浮动，不含费用。
              </p>
            </>
          )}
        </div>

        {/* 无 Key 提示（首次检查/点击开始后的复查期间先不闪现） */}
        {!agentConfigured && !busy ? (
          <div
            role="alert"
            className="flex flex-wrap items-start gap-3 rounded-lg border border-cinnabar/25 bg-cinnabar/[0.06] px-4 py-3"
          >
            <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-cinnabar" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-serif text-sm font-semibold tracking-wide text-ink">尚未配置 AGENT</p>
              <p className="mt-1 text-xs leading-6 text-ink-soft">
                构建需要调用 AGENT 接口。请先在「设置 · AGENT」填写接口地址与 API Key，再回来开始构建。
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={onConfigureAgent}>
              去设置
            </Button>
          </div>
        ) : null}

        {/* 操作 */}
        <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-5 text-ink-soft/75">
            构建在本地书库中执行，只把必要的章节摘录发送给已配置的 AGENT；不上传书籍文件。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onSkip}>
              跳过构建
            </Button>
            <Button
              type="button"
              onClick={handleStart}
              disabled={startDisabled}
              title={disabledReason}
              aria-label={disabledReason ?? "开始构建知识库"}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              )}
              {busy ? "正在检查 AGENT…" : "开始构建"}
            </Button>
          </div>
        </div>
      </div>
    </PlaceholderPage>
  );
}
