import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";

import { clearHomeMemory } from "../../lib/home-memory";
import {
  DEFAULT_SEARCH_SCOPE_SPEC,
  NAV_MEMORY_OPTIONS,
  NOTE_DISPLAY_MODES,
  READER_ACTION_MODE_OPTIONS,
  useSettings,
  type NavMemoryMode,
  type NoteDisplayMode,
  type ReaderActionMode,
} from "../../lib/settings";
import {
  describeSearchScope,
  normalizeSearchScopeText,
  parseSearchScopeSpec,
} from "../../lib/searchScope";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Separator } from "../ui/separator";
import {
  CardResetButton,
  SettingsCardHeader,
  SettingsSwitch,
  fieldLabelClass,
  hintClass,
  selectClass,
} from "./SettingsSectionNav";

/**
 * 行为分类：阅读与注释 / 界面（界面记忆 + 导航记忆）/ 检索。
 *
 * 三张卡片都从旧 `SettingsContent` 迁移而来，字段与文案保持一致；
 * 新增的只有「导航记忆」下拉（`navMemory`，取代旧的「启动初始界面」固定项）。
 */

/** 「阅读与注释」卡片：注释栏开关 + 文内注释展示方式 + 移动端滑动翻章阈值。 */
function ReadingNotesCard() {
  const { settings, updateSettings } = useSettings();
  const currentMode =
    NOTE_DISPLAY_MODES.find((mode) => mode.value === settings.noteDisplayMode) ??
    NOTE_DISPLAY_MODES[0];
  const noteDisplayModeId = useId();
  const noteDisplayModeHintId = useId();
  const swipeThresholdId = useId();
  const swipeThresholdHintId = useId();
  /** 设置里存 0.1–0.4 的小数，滑条按整数百分比展示（10%–40%，步进 1%）。 */
  const swipePercent = Math.round(settings.readerSwipeThreshold * 100);

  /** 只重置本卡：注释栏关闭、文内注释回到「仅文内展示」、滑动翻章阈值回到默认 22%。 */
  const resetCard = () => {
    updateSettings({
      notesPanelEnabled: false,
      noteDisplayMode: "inline",
      readerSwipeThreshold: 0.22,
    });
  };

  return (
    <Card>
      <SettingsCardHeader
        title="阅读与注释"
        description="控制阅读器左栏是否显示「注释」标签、文内注释的展示方式，以及触屏设备左右滑动翻章的触发阈值；设置保存在用户库（appData）。"
        action={
          <CardResetButton
            title="本卡重置：注释栏关闭，文内注释回到「仅文内展示」，滑动翻章阈值回到 22%"
            onClick={resetCard}
          />
        }
      />
      <CardContent className="space-y-6">
        <SettingsSwitch
          checked={settings.notesPanelEnabled}
          label="注释栏"
          hint="打开后，阅读器左栏会在「知识库」前增加「注释」标签，按序号列出本章注释；点击注释卡片可跳回正文引用处。"
          onToggle={() => updateSettings({ notesPanelEnabled: !settings.notesPanelEnabled })}
        />

        <Separator />

        <div>
          <label
            htmlFor={noteDisplayModeId}
            className={cn(fieldLabelClass, !settings.notesPanelEnabled && "text-ink-soft/60")}
          >
            文内注释展示方式
          </label>
          <select
            id={noteDisplayModeId}
            value={settings.noteDisplayMode}
            disabled={!settings.notesPanelEnabled}
            aria-describedby={noteDisplayModeHintId}
            onChange={(event) =>
              updateSettings({ noteDisplayMode: event.target.value as NoteDisplayMode })
            }
            className={selectClass}
          >
            {NOTE_DISPLAY_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
          <p id={noteDisplayModeHintId} className={hintClass}>
            {currentMode.description}
            {settings.notesPanelEnabled
              ? ""
              : "（注释栏关闭时固定按「仅文内展示」处理，下拉设置不生效）"}
          </p>
        </div>

        <Separator />

        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={swipeThresholdId} className={fieldLabelClass}>
              滑动翻章阈值
            </label>
            <span className="shrink-0 font-serif text-sm tabular-nums text-ink" aria-hidden="true">
              {swipePercent}%
            </span>
          </div>
          <input
            id={swipeThresholdId}
            type="range"
            min={10}
            max={40}
            step={1}
            value={swipePercent}
            aria-describedby={swipeThresholdHintId}
            aria-valuetext={`滑动距离超过正文宽度的 ${swipePercent}%`}
            onChange={(event) =>
              updateSettings({ readerSwipeThreshold: Number(event.target.value) / 100 })
            }
            className="mt-2 w-full max-w-md cursor-pointer accent-cinnabar focus:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40"
          />
          <p id={swipeThresholdHintId} className={hintClass}>
            手机/平板上左右滑动正文翻章时，水平滑动距离超过正文面板宽度的这个比例才翻章，否则回弹。
            数值越大越不容易误触，越小越灵敏（默认 22%）。桌面端不受影响，用正文左右边缘的箭头翻章。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** 「界面」卡片：界面状态记忆开关 + 首页层级导航记忆策略。 */
function InterfaceCard() {
  const { settings, updateSettings } = useSettings();
  const navMemoryId = useId();
  const navMemoryHintId = useId();
  const currentNavMemory =
    NAV_MEMORY_OPTIONS.find((option) => option.value === settings.navMemory) ??
    NAV_MEMORY_OPTIONS[0];

  /** 只重置本卡，并清掉首页界面记忆存档（视图/侧栏/滚动位置）。 */
  const resetCard = () => {
    updateSettings({ rememberUiState: true, navMemory: "both" });
    clearHomeMemory();
  };

  return (
    <Card>
      <SettingsCardHeader
        title="界面"
        description="控制是否记住首页的视图、侧栏开合与滚动位置，以及再次进入首页时左右层级导航从哪里开始；设置保存在用户库（appData）。"
        action={
          <CardResetButton
            title="本卡重置：打开界面记忆、导航记忆回到「左右都记忆」，并清空已保存的首页界面记忆"
            onClick={resetCard}
          />
        }
      />
      <CardContent className="space-y-6">
        <SettingsSwitch
          checked={settings.rememberUiState}
          label="记忆界面状态"
          hint="记住首页的中间视图、桌面左右侧栏开合与各视图的滚动位置（移动端抽屉不记忆）。关闭后，启动与返回首页都回到默认书架与默认侧栏开合。"
          onToggle={() => updateSettings({ rememberUiState: !settings.rememberUiState })}
        />

        <Separator />

        <div>
          <label htmlFor={navMemoryId} className={fieldLabelClass}>
            导航记忆
          </label>
          <select
            id={navMemoryId}
            value={settings.navMemory}
            aria-describedby={navMemoryHintId}
            onChange={(event) =>
              updateSettings({ navMemory: event.target.value as NavMemoryMode })
            }
            className={selectClass}
          >
            {NAV_MEMORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id={navMemoryHintId} className={hintClass}>
            {currentNavMemory.description}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 判断检索范围草稿是否合法。
 *
 * `parseSearchScopeSpec` 对非法输入静默回退默认值，所以用「输入的每个数字必须与解析结果
 * 逐位一致（允许省略末尾 -1，解析会自动补上）」来识别回退；分隔符/空白由解析统一处理。
 */
function isSearchScopeDraftValid(text: string): boolean {
  const tokens = text.split(/[@,，\s]+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const numbers = tokens.map((token) => Number(token));
  if (numbers.some((value) => !Number.isFinite(value))) return false;
  const parsed = parseSearchScopeSpec(text);
  const parsedTokens = [parsed.recentCount, ...parsed.tiers];
  return numbers.every((value, index) => Math.round(value) === parsedTokens[index]);
}

/** 「检索」卡片：检索范围配置（最近阅读本数 + 查找更多档位）。 */
function SearchScopeCard() {
  const { settings, updateSettings } = useSettings();
  const [draft, setDraft] = useState(settings.searchScope);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const scopeId = useId();
  const scopeHintId = useId();
  const scopePreviewId = useId();

  useEffect(() => {
    setDraft(settings.searchScope);
  }, [settings.searchScope]);

  // 「已保存」提示短暂显示后自动消失。
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(timer);
  }, [saved]);

  /** 校验草稿并写入当前设置；`announce` 为 true 时显示「已保存」提示。 */
  const commitDraft = (announce: boolean) => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(settings.searchScope);
      setError(null);
      return;
    }
    if (!isSearchScopeDraftValid(trimmed)) {
      setDraft(settings.searchScope);
      setError(`格式不正确，已恢复为当前生效的「${settings.searchScope}」。示例：${DEFAULT_SEARCH_SCOPE_SPEC}`);
      setSaved(false);
      return;
    }
    const normalized = normalizeSearchScopeText(trimmed);
    setDraft(normalized);
    setError(null);
    if (normalized !== settings.searchScope) updateSettings({ searchScope: normalized });
    if (announce) setSaved(true);
  };

  const submitDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commitDraft(true);
  };

  /** 只重置本卡：检索范围回到默认值，清空草稿与错误提示。 */
  const resetCard = () => {
    updateSettings({ searchScope: DEFAULT_SEARCH_SCOPE_SPEC });
    setDraft(DEFAULT_SEARCH_SCOPE_SPEC);
    setError(null);
    setSaved(false);
  };

  return (
    <Card>
      <SettingsCardHeader
        title="检索"
        description="控制检索首轮优先扫描多少本最近阅读，以及「查找更多」按哪些档位扩大覆盖范围；设置保存在用户库（appData）。"
        action={
          <CardResetButton
            title={`本卡重置：检索范围回到默认 ${DEFAULT_SEARCH_SCOPE_SPEC}`}
            onClick={resetCard}
          />
        }
      />
      <CardContent className="space-y-4">
        <div>
          <label htmlFor={scopeId} className={fieldLabelClass}>
            检索范围
          </label>
          <form onSubmit={submitDraft} className="mt-2 flex max-w-md items-center gap-2">
            <Input
              id={scopeId}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError(null);
                if (saved) setSaved(false);
              }}
              onBlur={() => commitDraft(false)}
              spellCheck={false}
              inputMode="text"
              placeholder={DEFAULT_SEARCH_SCOPE_SPEC}
              aria-describedby={`${scopeHintId} ${scopePreviewId}`}
              aria-invalid={error ? true : undefined}
              className="min-w-0 flex-1"
            />
            <Button
              type="submit"
              variant="outline"
              // 点击「保存」时不把焦点移出输入框，避免先触发失焦规范化再提交（重复写入/提示丢失）。
              onMouseDown={(event) => event.preventDefault()}
              disabled={!draft.trim()}
            >
              保存
            </Button>
          </form>
          {saved ? (
            <p role="status" className="mt-2 text-xs text-emerald-800">
              已保存检索范围。
            </p>
          ) : null}
          <p id={scopeHintId} className={hintClass}>
            格式：最近阅读本数@查找更多档位…@-1。本数取 1–20，档位需递增，-1 表示全部并放在最后；
            例如 {DEFAULT_SEARCH_SCOPE_SPEC} = 首轮最近 5 本，点「查找更多」依次覆盖 10 本、20 本、全部。
            修改后点「保存」或按 Enter 生效，失焦时也会自动规范化。
          </p>
          <p id={scopePreviewId} className="mt-2 text-xs leading-5 text-ink-soft">
            当前生效：
            <span className="text-ink">
              {describeSearchScope(parseSearchScopeSpec(settings.searchScope))}
            </span>
          </p>
          {error ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-cinnabar/25 bg-cinnabar/5 px-2.5 py-2 text-xs leading-5 text-cinnabar"
            >
              {error}
            </p>
          ) : null}
        </div>
        <div className="rounded-md border border-border/60 bg-paper/60 px-3 py-2 text-xs leading-6 text-ink-soft">
          检索按「最近阅读优先」扫描：首轮只扫最近读过的书，点「查找更多」再按档位逐级扩大；书名与作者始终在全库范围匹配。
        </div>
      </CardContent>
    </Card>
  );
}

/** 「阅读器快捷按钮」卡片：中间面板底部「创建书签」与「引用到 AGENT」的显示/行为策略。 */
function ReaderQuickActionsCard() {
  const { settings, updateSettings } = useSettings();
  const bookmarkModeId = useId();
  const bookmarkModeHintId = useId();
  const quoteModeId = useId();
  const quoteModeHintId = useId();

  const bookmarkMode =
    READER_ACTION_MODE_OPTIONS.find((option) => option.value === settings.middleBookmarkMode) ??
    READER_ACTION_MODE_OPTIONS[1];
  const quoteMode =
    READER_ACTION_MODE_OPTIONS.find((option) => option.value === settings.middleQuoteMode) ??
    READER_ACTION_MODE_OPTIONS[1];

  return (
    <Card>
      <SettingsCardHeader
        title="阅读器快捷按钮"
        description="控制阅读器中间面板底部的「创建书签」与「引用到 AGENT」按钮何时出现，以及没有选中文字时的行为。"
        action={
          <CardResetButton
            title="本卡重置：两个按钮都恢复为「仅选中文字时出现」"
            onClick={() =>
              updateSettings({ middleBookmarkMode: "selection", middleQuoteMode: "selection" })
            }
          />
        }
      />
      <CardContent className="space-y-6">
        <div>
          <label htmlFor={bookmarkModeId} className={fieldLabelClass}>
            创建书签按钮
          </label>
          <select
            id={bookmarkModeId}
            value={settings.middleBookmarkMode}
            aria-describedby={bookmarkModeHintId}
            onChange={(event) =>
              updateSettings({ middleBookmarkMode: event.target.value as ReaderActionMode })
            }
            className={selectClass}
          >
            {READER_ACTION_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id={bookmarkModeHintId} className={hintClass}>
            {bookmarkMode.description}
            {settings.middleBookmarkMode === "always"
              ? "没有选中文字时创建「页面位置」书签（记录滚动位置与面板状态）。"
              : ""}
          </p>
        </div>

        <Separator />

        <div>
          <label htmlFor={quoteModeId} className={fieldLabelClass}>
            引用到 AGENT 按钮
          </label>
          <select
            id={quoteModeId}
            value={settings.middleQuoteMode}
            aria-describedby={quoteModeHintId}
            onChange={(event) =>
              updateSettings({ middleQuoteMode: event.target.value as ReaderActionMode })
            }
            className={selectClass}
          >
            {READER_ACTION_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id={quoteModeHintId} className={hintClass}>
            {quoteMode.description}
            {settings.middleQuoteMode === "always"
              ? "没有选中文字时引用整章（章节标题 + 正文开头，长度受限）。"
              : ""}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** 行为分类主体。 */
export function BehaviorSection() {
  return (
    <div className="space-y-4">
      <ReadingNotesCard />
      <InterfaceCard />
      <SearchScopeCard />
      <ReaderQuickActionsCard />
    </div>
  );
}
