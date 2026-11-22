import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { BookMeta, Library } from "@jusong/core";

import { runImportBuild } from "../../lib/import-build/orchestrator";
import type {
  BuildAgentRole,
  BuildItemId,
  BuildMessage,
  BuildProgress,
  BuildResult,
} from "../../lib/import-build/types";
import { cn, getErrorMessage } from "../../lib/utils";

/**
 * 消息逐条淡入的局部样式：不引入全局样式表改动，组件卸载即随节点移除。
 * `prefers-reduced-motion` 下关闭动画。
 */
const FADE_IN_STYLE = `
@keyframes import-build-message-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.import-build-message { animation: import-build-message-in 320ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .import-build-message { animation: none; }
}
`;

interface RoleMeta {
  label: string;
  short: string;
  hint: string;
  badge: string;
  border: string;
  avatar: string;
}

/** 角色视觉：Lead 朱红、研究员 蓝、撰写 绿、审查 琥珀（左边框 + 徽标 + 头像区分）。 */
const ROLE_META: Record<BuildAgentRole, RoleMeta> = {
  lead: {
    label: "Lead",
    short: "L",
    hint: "计划与终审",
    badge: "border-cinnabar/30 bg-cinnabar/[0.08] text-cinnabar",
    border: "border-l-cinnabar",
    avatar: "bg-cinnabar text-paper-soft",
  },
  researcher: {
    label: "研究员",
    short: "研",
    hint: "批次分析",
    badge: "border-blue-700/25 bg-blue-50 text-blue-800",
    border: "border-l-blue-700",
    avatar: "bg-blue-700 text-white",
  },
  writer: {
    label: "撰写",
    short: "撰",
    hint: "生成条目",
    badge: "border-emerald-700/25 bg-emerald-50 text-emerald-800",
    border: "border-l-emerald-700",
    avatar: "bg-emerald-700 text-white",
  },
  reviewer: {
    label: "审查",
    short: "审",
    hint: "质量校验",
    badge: "border-amber-600/30 bg-amber-50 text-amber-800",
    border: "border-l-amber-600",
    avatar: "bg-amber-600 text-white",
  },
};

const TONE_LABEL: Partial<Record<NonNullable<BuildMessage["tone"]>, string>> = {
  success: "完成",
  error: "中断",
  review: "审查",
};

/** 编排层消息会带「Lead：」「研究员：」等前缀，角色已由徽标表达，正文去掉重复前缀。 */
function stripRolePrefix(text: string): string {
  return text.replace(/^(Lead|研究员|撰写|审查)\s*[:：]\s*/, "");
}

function BuildMessageRow({ message }: { message: BuildMessage }) {
  const meta = ROLE_META[message.role];
  const tone = message.tone ?? "normal";
  const toneLabel = TONE_LABEL[tone];

  return (
    <li
      className={cn(
        "import-build-message flex gap-3 rounded-lg border border-border/70 border-l-2 bg-paper-soft/85 px-3.5 py-2.5",
        meta.border,
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
          meta.avatar,
        )}
        aria-hidden="true"
      >
        {meta.short}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-serif text-xs font-semibold tracking-wide text-ink">{meta.label}</span>
          <span
            className={cn(
              "rounded-sm border px-1 py-px text-[10px] leading-4 tracking-wider",
              meta.badge,
            )}
          >
            {meta.hint}
          </span>
          {toneLabel ? (
            <span
              className={cn(
                "rounded-sm border px-1 py-px text-[10px] leading-4 tracking-wider",
                tone === "error"
                  ? "border-cinnabar/30 bg-cinnabar/[0.06] text-cinnabar"
                  : tone === "success"
                    ? "border-emerald-700/25 bg-emerald-50 text-emerald-800"
                    : "border-amber-600/30 bg-amber-50 text-amber-800",
              )}
            >
              {toneLabel}
            </span>
          ) : null}
        </div>
        <p
          className={cn(
            "mt-1 break-words text-xs leading-6",
            tone === "error"
              ? "text-cinnabar"
              : tone === "success"
                ? "text-emerald-800"
                : "text-ink-soft",
          )}
        >
          {stripRolePrefix(message.text)}
        </p>
      </div>
    </li>
  );
}

function ProgressStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-md border border-border/70 bg-paper/70 px-2 py-1">
      <span className="text-[10px] tracking-wider text-ink-soft/80">{label}</span>
      <span className="font-serif text-sm font-semibold text-ink">{value}</span>
    </div>
  );
}

export interface ImportBuildProgressViewProps {
  library: Library;
  book: BookMeta;
  selected: BuildItemId[];
  onComplete: (result: BuildResult) => void;
}

/**
 * 导入第二流程 · 构建进度页（全屏覆盖、用户不可操作）。
 *
 * - 挂载后内部调用 `runImportBuild`，把 `onMessage` / `onProgress` 渲染成角色化状态对话；
 * - 全屏 `fixed inset-0` 覆盖，只有状态展示、没有可操作按钮；
 * - 成功 → 短暂停留后 `onComplete(result)`；失败 → 先显示中断信息与已保存统计，再回调；
 * - 组件内用 ref 防止 React StrictMode 的 effect 重跑导致重复真实调用。
 */
export function ImportBuildProgressView({
  library,
  book,
  selected,
  onComplete,
}: ImportBuildProgressViewProps) {
  const headingId = useId();
  const descriptionId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  const [messages, setMessages] = useState<BuildMessage[]>([]);
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // 真实挂载标记：StrictMode 会「清理 → 重新 setup」，第二次 setup 同步把标记改回 true，
  // 因此异步回调不会因为开发模式的模拟卸载而失效。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 卸载时清掉进入完成页的延时器。
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  const pushMessage = useCallback((message: BuildMessage) => {
    setMessages((current) => {
      const next = [...current, message];
      return next.length > 240 ? next.slice(next.length - 240) : next;
    });
  }, []);

  /** 结果短暂停留，让用户看到最后一两条状态再进入完成页。 */
  const scheduleComplete = useCallback((result: BuildResult, delayMs: number) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!mountedRef.current) return;
      completeRef.current(result);
    }, delayMs);
  }, []);

  useEffect(() => {
    // StrictMode 会额外跑一次 setup：用 startedRef 保证真实 AGENT 调用只发起一次。
    if (startedRef.current) return;
    startedRef.current = true;

    let lastProgress: BuildProgress | null = null;

    const run = async () => {
      try {
        const result = await runImportBuild({
          library,
          book,
          selected,
          onMessage: (message) => {
            if (!mountedRef.current) return;
            pushMessage(message);
          },
          onProgress: (next) => {
            lastProgress = next;
            if (mountedRef.current) setProgress(next);
          },
        });
        if (!mountedRef.current) return;

        if (result.completed) {
          scheduleComplete(result, 500);
        } else {
          setFailure(
            result.failedBatch
              ? `第 ${result.failedBatch.index + 1} 批未通过审查：${result.failedBatch.reason}`
              : "构建没有完成，已完成的部分会保留。",
          );
          scheduleComplete(result, 1600);
        }
      } catch (reason) {
        if (!mountedRef.current) return;
        const message = getErrorMessage(reason);
        setFailure(message);
        pushMessage({
          id: `local-error-${Date.now().toString(36)}`,
          role: "lead",
          text: `构建中断：${message}`,
          tone: "error",
        });
        const fallback: BuildResult = {
          completed: false,
          savedDigests: lastProgress?.savedDigests ?? 0,
          savedArchives: lastProgress?.savedArchives ?? 0,
          savedPlaces: lastProgress?.savedPlaces ?? 0,
          savedEvents: lastProgress?.savedEvents ?? 0,
        };
        scheduleComplete(fallback, 1600);
      }
    };

    void run();
    // library/book/selected 在构建期间不会变化；pushMessage/scheduleComplete 稳定。
  }, [library, book, selected, pushMessage, scheduleComplete]);

  // 新消息追加后滚到底部（消息区是唯一的滚动容器）。
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, failure]);

  const batchCount = progress?.batchCount ?? 0;
  const batchIndex = progress?.batchIndex ?? 0;
  const percent =
    batchCount > 0 ? Math.min(100, Math.max(0, Math.round((batchIndex / batchCount) * 100))) : 0;
  const batchLabel =
    progress && batchCount > 0 ? `已完成 ${batchIndex} / ${batchCount} 批` : "正在准备批次…";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-paper text-ink"
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy="true"
      data-import-build-progress
    >
      <style>{FADE_IN_STYLE}</style>

      <div className="shrink-0 border-b border-border/70 bg-paper-soft/70">
        <div className="mx-auto w-full max-w-3xl px-5 py-5 sm:px-8">
          <p className="text-[11px] uppercase tracking-[0.42em] text-cinnabar">导入 · 构建知识库</p>
          <h1
            id={headingId}
            className="mt-2 font-serif text-xl font-semibold tracking-[0.06em] text-ink sm:text-2xl"
          >
            正在为《{book.title}》构建知识库
          </h1>
          <p id={descriptionId} className="mt-1.5 text-xs leading-6 text-ink-soft sm:text-sm">
            Lead 规划批次，研究员分析章节、撰写生成条目、审查把关；构建期间请勿关闭窗口。
          </p>

          <div className="mt-4 rounded-lg border border-border/80 bg-paper/80 px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-xs font-medium text-ink">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-cinnabar" aria-hidden="true" />
                {batchLabel}
              </p>
              <span className="text-[11px] tracking-wider text-ink-soft/80">{percent}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="构建批次进度"
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-cinnabar transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <ProgressStat label="摘要" value={progress?.savedDigests ?? 0} />
              <ProgressStat label="档案" value={progress?.savedArchives ?? 0} />
              <ProgressStat label="地点" value={progress?.savedPlaces ?? 0} />
              <ProgressStat label="时间线" value={progress?.savedEvents ?? 0} />
            </div>
          </div>

          {failure ? (
            <div
              role="alert"
              className="mt-3 flex items-start gap-3 rounded-lg border border-cinnabar/25 bg-cinnabar/[0.06] px-3.5 py-3"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-cinnabar" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-serif text-sm font-semibold tracking-wide text-ink">构建中断</p>
                <p className="mt-1 break-words text-xs leading-6 text-ink-soft">{failure}</p>
                <p className="mt-1 text-[11px] leading-5 text-ink-soft/75">
                  失败前已写入的条目会保留；马上显示构建结果。
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <ol className="mx-auto w-full max-w-3xl space-y-2 px-5 py-4 sm:px-8">
          {messages.length === 0 ? (
            <li className="import-build-message flex items-center gap-3 rounded-lg border border-border/70 border-l-2 border-l-cinnabar bg-paper-soft/85 px-3.5 py-2.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cinnabar text-[11px] font-semibold text-paper-soft">
                L
              </span>
              <p className="flex items-center gap-2 text-xs text-ink-soft">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-cinnabar" aria-hidden="true" />
                Lead 正在读取目录与章节，准备分批…
              </p>
            </li>
          ) : (
            messages.map((message) => <BuildMessageRow key={message.id} message={message} />)
          )}
        </ol>
      </div>

      <div className="shrink-0 border-t border-border/70 px-5 py-3 text-center text-[11px] leading-5 text-ink-soft/70">
        摘要与档案逐批写入，地图地点与时间线在终审后统一写入；中断不会丢失已完成内容。
      </div>
    </div>
  );
}
