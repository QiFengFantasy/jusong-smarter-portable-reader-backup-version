import { useState } from "react";

import { useSettings } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { AccountSection } from "./AccountSection";
import { AgentSection } from "./AgentSection";
import { AppearanceSection } from "./AppearanceSection";
import { BehaviorSection } from "./BehaviorSection";
import {
  DEFAULT_SETTINGS_CATEGORY,
  SETTINGS_CATEGORIES,
  SettingsSectionNav,
  type SettingsCategory,
} from "./SettingsSectionNav";

export { SETTINGS_CATEGORIES };
export type { SettingsCategory };

export interface SettingsContentProps {
  /** 嵌入首页中间栏或阅读器覆盖层时是否显示自带的「设置」标题与说明；外部已提供标题时传 false。 */
  showHeader?: boolean;
  className?: string;
  /**
   * 受控分类（首页右面板子项切换）。传了 `category` 即受控：内部不再渲染分类切换条，
   * 由外部右面板控制并高亮；省略时（阅读器设置覆盖层、独立 `/settings` 路由）
   * 使用内部 tab 切换，默认落在「行为」。
   */
  category?: SettingsCategory;
  /** 分类变化回调：受控时点击外部右面板后由此回传；非受控时内部 tab 切换后也会通知。 */
  onCategoryChange?: (category: SettingsCategory) => void;
}

/** 按分类渲染对应分区；未识别的值回落到默认分类，避免白屏。 */
function SettingsSection({ category }: { category: SettingsCategory }) {
  switch (category) {
    case "account":
      return <AccountSection />;
    case "appearance":
      return <AppearanceSection />;
    case "agent":
      return <AgentSection />;
    case "behavior":
    default:
      return <BehaviorSection />;
  }
}

/**
 * 设置主体：账号 / 行为 / 外观 / AGENT 四分类。
 *
 * 两种用法共用同一份实现：
 * - 受控（首页右面板）：`<SettingsContent category={child} showHeader={false} onCategoryChange={...} />`；
 * - 非受控（阅读器设置覆盖层、独立 `/settings` 路由）：`<SettingsContent showHeader={false} />`，
 *   内部用 `SettingsSectionNav` 切换分类，默认「行为」，保证阅读器设置覆盖层继续可用。
 *
 * 不含 AppShell、返回链接与「关于」卡片。各卡片右上角「重置」只重置本卡字段；
 * 末尾的「恢复全部默认」等同旧的全局恢复（只重置界面设置，不影响 AGENT 的 baseUrl/模型与已保存密钥）。
 */
export function SettingsContent({
  showHeader = true,
  className,
  category,
  onCategoryChange,
}: SettingsContentProps) {
  const { resetSettings } = useSettings();
  const [innerCategory, setInnerCategory] = useState<SettingsCategory>(DEFAULT_SETTINGS_CATEGORY);

  const controlled = category !== undefined;
  const requested: SettingsCategory = controlled ? category : innerCategory;
  // 外部若传了未知分类（运行期非法字符串），回落到默认分类，避免「分类标题与内容不一致」。
  const activeCategory: SettingsCategory = SETTINGS_CATEGORIES.some(
    (item) => item.value === requested,
  )
    ? requested
    : DEFAULT_SETTINGS_CATEGORY;
  const activeOption =
    SETTINGS_CATEGORIES.find((item) => item.value === activeCategory) ?? SETTINGS_CATEGORIES[0];

  const selectCategory = (next: SettingsCategory) => {
    if (!controlled) setInnerCategory(next);
    onCategoryChange?.(next);
  };

  return (
    <div className={cn("w-full space-y-5", className)}>
      {showHeader ? (
        <header>
          <p className="text-[11px] uppercase tracking-[0.4em] text-cinnabar">SETTINGS</p>
          <h1 className="mt-2 font-serif text-2xl font-semibold tracking-wide sm:text-3xl">设置</h1>
          <p className="mt-3 text-sm leading-7 text-ink-soft">
            账号、行为、外观与 AGENT 四类设置：书斋统计、阅读与注释、界面记忆与检索范围、强调色与阅读器面板、模型服务。
            全部保存在本机用户库（appData），不上传；AGENT 的 API Key 只写不读。
          </p>
        </header>
      ) : null}

      {controlled ? null : (
        <div className="space-y-2">
          <SettingsSectionNav value={activeCategory} onChange={selectCategory} />
          <p className="text-[11px] leading-5 text-ink-soft/75">{activeOption.description}</p>
        </div>
      )}

      <div role="region" aria-label={`${activeOption.label}设置`}>
        <SettingsSection category={activeCategory} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border/70 bg-paper/40 px-3 py-2">
        <p className="text-[11px] leading-5 text-ink-soft/75">
          各卡片右上角的「重置」只重置本卡字段；这里恢复全部界面设置默认值（强调色、封面占位色、阅读器面板、行为与检索），
          不影响 AGENT 的 baseUrl/模型与已保存的 API Key。
        </p>
        <button
          type="button"
          onClick={resetSettings}
          title="恢复全部界面设置默认值（不影响 AGENT 的 baseUrl/模型与已保存的 API Key）"
          className="shrink-0 rounded-md border border-border/80 px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-cinnabar/40 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40"
        >
          恢复全部默认
        </button>
      </div>
    </div>
  );
}
