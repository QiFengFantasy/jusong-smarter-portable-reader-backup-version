import { useId } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Bot, Palette, RotateCcw, SlidersHorizontal, UserRound } from "lucide-react";

import { cn } from "../../lib/utils";
import { CardDescription, CardHeader, CardTitle } from "../ui/card";

/**
 * 设置页的共享骨架：
 * - 四个设置分类（账号 / 行为 / 外观 / AGENT）的类型与选项，供首页右面板与设置本体共用；
 * - 无外部 `category` 时（阅读器设置覆盖层）用的内部分类切换 `SettingsSectionNav`；
 * - 各分类卡片共用的标题区 / 本卡重置 / 开关三件套，保持与旧设置卡完全一致的视觉。
 *
 * 单独成文件是为了避免 `SettingsContent` 与四个 `*Section` 互相 import 形成循环依赖。
 */

export type SettingsCategory = "account" | "behavior" | "appearance" | "agent";

export interface SettingsCategoryOption {
  value: SettingsCategory;
  /** 分类名（首页右面板子项与设置内 tab 共用）。 */
  label: string;
  /** 一句话说明该分类管什么，用于无障碍描述与设置页引导。 */
  description: string;
  icon: LucideIcon;
}

/** 四个设置分类（顺序即首页右面板子项与设置内 tab 的顺序）。 */
export const SETTINGS_CATEGORIES: SettingsCategoryOption[] = [
  {
    value: "account",
    label: "账号",
    description: "书斋概览：藏书、档案与摘要统计，以及本地优先说明。",
    icon: UserRound,
  },
  {
    value: "behavior",
    label: "行为",
    description: "阅读与注释、界面记忆与导航记忆、检索范围。",
    icon: SlidersHorizontal,
  },
  {
    value: "appearance",
    label: "外观",
    description: "强调色、封面占位色与阅读器面板呈现。",
    icon: Palette,
  },
  {
    value: "agent",
    label: "AGENT",
    description: "AGENT 模型服务：baseUrl、模型与 API Key。",
    icon: Bot,
  },
];

/** 无外部 category 时（阅读器设置覆盖层）的默认分类。 */
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = "behavior";

/**
 * 设置内部分类切换（分段式 tab）。
 *
 * `SettingsContent` 只在「无外部 category」（阅读器设置覆盖层）时渲染它；
 * 首页右面板由 HomePage 自己画子项，通过 `category` / `onCategoryChange` 受控。
 * 用 `aria-pressed` 的分段按钮而不是 role=tablist：切换的是整块内容而非同一页内的 tab 面板，
 * 不需要 ARIA tab 的 tab/tabpanel 关联，读屏不会误报缺失面板。
 */
export function SettingsSectionNav({
  value,
  onChange,
  className,
}: {
  value: SettingsCategory;
  onChange: (category: SettingsCategory) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="设置分类"
      className={cn(
        "flex flex-wrap items-center gap-1 rounded-lg border border-border/70 bg-muted/50 p-1",
        className,
      )}
    >
      {SETTINGS_CATEGORIES.map((category) => {
        const Icon = category.icon;
        const active = value === category.value;
        return (
          <button
            key={category.value}
            type="button"
            aria-pressed={active}
            title={category.description}
            onClick={() => onChange(category.value)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40 sm:flex-none",
              active
                ? "bg-paper text-ink shadow-sm"
                : "text-ink-soft hover:bg-paper/60 hover:text-ink",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {category.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 各分类卡片共用的小组件与样式                                                  */
/* -------------------------------------------------------------------------- */

export const selectClass =
  "mt-2 h-9 w-full max-w-xs rounded-md border border-border bg-paper px-2 text-sm text-ink transition-colors focus:outline-none focus:ring-2 focus:ring-cinnabar/30 disabled:cursor-not-allowed disabled:opacity-60";
export const hintClass = "mt-2 max-w-lg text-xs leading-5 text-ink-soft/70";
export const fieldLabelClass = "text-sm font-medium text-ink";

/** 卡片标题区：左侧标题/说明，右侧放本卡重置等操作（样式沿用原「恢复默认」小按钮）。 */
export function SettingsCardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <CardHeader>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </CardHeader>
  );
}

/** 单个卡片的重置按钮；`danger` 用于「再次点击才真正执行」的二次确认态。 */
export function CardResetButton({
  label = "重置",
  title,
  disabled = false,
  danger = false,
  onClick,
}: {
  label?: string;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      // 多张卡片都有「重置」按钮：用说明文案当无障碍名称，读屏能区分是重置哪张卡。
      aria-label={title ?? label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        danger
          ? "border-cinnabar/50 bg-cinnabar/5 text-cinnabar hover:border-cinnabar hover:bg-cinnabar/10"
          : "border-border/80 text-ink-soft hover:border-cinnabar/40 hover:text-ink",
      )}
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

/** 与现有设置卡一致的开关（role=switch）。 */
export function SettingsSwitch({
  checked,
  label,
  hint,
  onToggle,
}: {
  checked: boolean;
  label: string;
  hint: string;
  onToggle: () => void;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p id={labelId} className="text-sm font-medium text-ink">
          {label}
        </p>
        <p id={hintId} className="mt-1 text-xs leading-5 text-ink-soft">
          {hint}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onClick={onToggle}
        className={cn(
          "mt-0.5 flex h-6 w-11 shrink-0 items-center rounded-full border px-0.5 transition-colors",
          checked ? "border-cinnabar bg-cinnabar" : "border-border bg-muted",
        )}
      >
        <span
          className={cn(
            "block h-5 w-5 rounded-full bg-paper shadow-sm transition-transform",
            checked ? "translate-x-[18px]" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}
