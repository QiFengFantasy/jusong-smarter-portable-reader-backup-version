import { useId } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { HeroArt } from "../brand/HeroArt";
import { cn } from "../../lib/utils";

export interface PlaceholderPlanItem {
  icon?: LucideIcon;
  title: string;
  description: string;
}

export interface PlaceholderPanelProps {
  /** 页面主标题（渲染为 h1）。 */
  title: string;
  /** 主说明；可传 ReactNode 组合多段文字与强调。 */
  description: ReactNode;
  /** 标题上方的小栏目名，如「涌现 · EMERGENCE」。 */
  eyebrow?: string;
  /** 标题旁的计划状态标签，如「规划中」「本批为入口与占位」。 */
  planLabel?: string;
  /** 计划中的能力清单；不传则不渲染。 */
  items?: readonly PlaceholderPlanItem[];
  /** 底部说明框（未来更新说明等）。 */
  note?: ReactNode;
  /** 额外内容，渲染在 note 之后。 */
  children?: ReactNode;
  /** 内容底部页脚（可选）。 */
  footer?: ReactNode;
  className?: string;
}

/**
 * 统一占位面板：纸墨底 + 品牌装饰 + 栏目名 / 标题 / 计划标签 / 说明 / 计划清单 / 未来更新说明。
 *
 * 只负责视觉与语义，不自带页面高度与滚动；整页占位请直接用同文件导出的 `PlaceholderPage`。
 * 用于「涌现」「指引」「导入 / 导出」等尚在规划中的入口，文案保持规划感、不写成报错。
 */
export function PlaceholderPanel({
  title,
  description,
  eyebrow,
  planLabel,
  items,
  note,
  children,
  footer,
  className,
}: PlaceholderPanelProps) {
  const headingId = useId();
  const list = items && items.length > 0 ? items : null;

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-paper-soft/60 px-5 py-7 shadow-paper sm:px-8 sm:py-9",
        className,
      )}
    >
      <HeroArt variant="compact" />

      <div className="relative">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {eyebrow ? (
            <p className="text-[11px] uppercase tracking-[0.42em] text-cinnabar">{eyebrow}</p>
          ) : null}
          {planLabel ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cinnabar/25 bg-cinnabar/[0.06] px-2.5 py-0.5 text-[11px] leading-5 text-cinnabar">
              <span className="h-1.5 w-1.5 rounded-full bg-cinnabar/70" aria-hidden="true" />
              {planLabel}
            </span>
          ) : null}
        </div>

        <h1
          id={headingId}
          className="mt-3 font-serif text-3xl font-semibold tracking-[0.08em] text-ink sm:text-4xl"
        >
          {title}
        </h1>

        <div className="mt-4 max-w-2xl space-y-3 text-sm leading-7 text-ink-soft sm:text-[15px] sm:leading-8">
          {description}
        </div>

        {list ? (
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {list.map((item) => {
              const Icon = item.icon;
              return (
                <li
                  key={item.title}
                  className="rounded-lg border border-border/80 bg-paper/70 p-3.5"
                >
                  <div className="flex items-start gap-3">
                    {Icon ? (
                      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-muted/40 text-cinnabar">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                    ) : null}
                    <div className="min-w-0">
                      <p className="font-serif text-sm font-semibold tracking-wide text-ink">
                        {item.title}
                      </p>
                      <p className="mt-1 text-xs leading-6 text-ink-soft">{item.description}</p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {note ? (
          <div className="mt-6 rounded-md border border-dashed border-cinnabar/25 bg-cinnabar/[0.03] px-3.5 py-3 text-xs leading-6 text-ink-soft">
            {note}
          </div>
        ) : null}

        {children ? <div className="mt-6">{children}</div> : null}

        {footer ? <div className="mt-6 border-t border-border/60 pt-4">{footer}</div> : null}
      </div>
    </section>
  );
}

/**
 * 整页占位壳：`flex h-full min-h-0 flex-col` + 内部滚动 + 居中限宽，
 * 与 `ShelfView` / `KnowledgeLibraryView` 的页面骨架一致，可直接放进首页中间栏。
 */
export function PlaceholderPage(props: PlaceholderPanelProps) {
  const { className, ...rest } = props;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="region"
        aria-label={`${rest.title} · 页面内容`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cinnabar/30 sm:px-8 sm:py-8"
      >
        <div className="mx-auto w-full max-w-3xl">
          <PlaceholderPanel className={className} {...rest} />
        </div>
      </div>
    </div>
  );
}
