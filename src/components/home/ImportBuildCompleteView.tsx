import { AlertTriangle, ArrowLeft, BookMarked, CheckCircle2, Clock, FileText, MapPin } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BookMeta } from "@jusong/core";

import { Button } from "../ui/button";
import type { BuildResult } from "../../lib/import-build/types";
import { cn } from "../../lib/utils";

interface StatItem {
  key: keyof Pick<BuildResult, "savedDigests" | "savedArchives" | "savedPlaces" | "savedEvents">;
  label: string;
  unit: string;
  icon: LucideIcon;
}

const STAT_ITEMS: readonly StatItem[] = [
  { key: "savedDigests", label: "章节摘要", unit: "章", icon: FileText },
  { key: "savedArchives", label: "档案", unit: "条", icon: BookMarked },
  { key: "savedPlaces", label: "地图地点", unit: "处", icon: MapPin },
  { key: "savedEvents", label: "时间线", unit: "条", icon: Clock },
];

export interface ImportBuildCompleteViewProps {
  book: BookMeta;
  result: BuildResult;
  onShelf: () => void;
}

/**
 * 导入第二流程 · 构建完成页。
 *
 * - 成功 / 失败（中断）两种卡片状态；
 * - 统计已保存的摘要 / 档案 / 地点 / 时间线数量；
 * - 失败时显示失败批次与原因，并说明已完成部分已保留；
 * - 唯一的操作是「返回书架」（跳过构建与完成都回书架）。
 */
export function ImportBuildCompleteView({ book, result, onShelf }: ImportBuildCompleteViewProps) {
  const completed = result.completed;
  const failedBatch = result.failedBatch;
  const totalSaved =
    result.savedDigests + result.savedArchives + result.savedPlaces + result.savedEvents;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="region"
        aria-label="构建知识库 · 结果"
        className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8"
      >
        <div className="mx-auto w-full max-w-2xl space-y-4">
          <section
            aria-label="构建结果"
            className="relative overflow-hidden rounded-xl border border-border bg-paper-soft/70 px-5 py-7 shadow-paper sm:px-8 sm:py-9"
          >
            <div className="flex items-start gap-4">
              <span
                className={cn(
                  "grid h-11 w-11 shrink-0 place-items-center rounded-full border",
                  completed
                    ? "border-emerald-700/25 bg-emerald-50 text-emerald-700"
                    : "border-cinnabar/25 bg-cinnabar/[0.08] text-cinnabar",
                )}
                aria-hidden="true"
              >
                {completed ? <CheckCircle2 className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-[0.42em] text-cinnabar">
                  导入 · 构建知识库
                </p>
                <h1 className="mt-2 font-serif text-2xl font-semibold tracking-[0.06em] text-ink sm:text-3xl">
                  {completed ? "知识库构建完成" : "知识库构建中断"}
                </h1>
                <p className="mt-2 text-sm leading-7 text-ink-soft">
                  {completed
                    ? `已为《${book.title}》生成并保存知识条目，现在可以在书架打开阅读。`
                    : `《${book.title}》的构建没有全部完成，失败前已写入的条目已经保留。`}
                </p>
              </div>
            </div>

            {/* 保存统计 */}
            <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {STAT_ITEMS.map((item) => {
                const Icon = item.icon;
                const value = result[item.key];
                return (
                  <div
                    key={item.key}
                    className="rounded-lg border border-border/80 bg-paper/70 px-3 py-3"
                  >
                    <div className="flex items-center gap-1.5 text-ink-soft/80">
                      <Icon className="h-3.5 w-3.5 text-cinnabar" aria-hidden="true" />
                      <span className="text-[11px] tracking-wider">{item.label}</span>
                    </div>
                    <p className="mt-1.5 font-serif text-xl font-semibold text-ink">
                      {value}
                      <span className="ml-1 text-[11px] font-normal text-ink-soft/75">
                        {item.unit}
                      </span>
                    </p>
                  </div>
                );
              })}
            </div>

            {failedBatch ? (
              <div
                role="alert"
                className="mt-4 rounded-lg border border-cinnabar/25 bg-cinnabar/[0.06] px-3.5 py-3"
              >
                <p className="font-serif text-sm font-semibold tracking-wide text-ink">
                  第 {failedBatch.index + 1} 批未完成
                </p>
                <p className="mt-1 break-words text-xs leading-6 text-ink-soft">
                  {failedBatch.reason || "审查未通过或 AGENT 调用失败。"}
                </p>
              </div>
            ) : null}

            <p className="mt-4 text-[11px] leading-5 text-ink-soft/70">
              {completed
                ? `共保存 ${totalSaved} 条知识记录，全部写入本地书库，不上传网络。`
                : `共保留 ${totalSaved} 条已保存记录；可在阅读器里对缺失的章节单独生成。`}
            </p>

            <div className="mt-6 flex flex-wrap gap-2 border-t border-border/60 pt-4">
              <Button type="button" onClick={onShelf} autoFocus>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                返回书架
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
