import { useId } from "react";

import {
  DEFAULT_ACCENT_THEME,
  DEFAULT_COVER_THEME,
} from "../../lib/theme";
import {
  PANE_SHRINK_PRIORITY_OPTIONS,
  READER_PANEL_MODE_OPTIONS,
  READER_TAB_MIN_WIDTH,
  useSettings,
  type PaneShrinkPriority,
  type ReaderPanelMode,
} from "../../lib/settings";
import { cn } from "../../lib/utils";
import { Card, CardContent } from "../ui/card";
import { Separator } from "../ui/separator";
import { ColorPalettePicker } from "./ColorPalettePicker";
import {
  CardResetButton,
  SettingsCardHeader,
  fieldLabelClass,
  hintClass,
  selectClass,
} from "./SettingsSectionNav";

/**
 * 外观分类：强调色 / 封面占位色 / 阅读器面板。
 *
 * - 强调色写 `--cinnabar`（界面唯一强调色槽位），封面占位色写 `--cover-*`，两者独立；
 * - 阅读器面板设置只作用于阅读器（面板形态、收缩优先级、顶部标签最小宽度），
 *   不影响首页布局；所有修改即时写入用户库设置。
 */

/** 强调色卡片：换 UI 强调色（按钮/选中/进度/链接/Hero 抽象图形统一跟随）。 */
function AccentColorCard() {
  const { settings, updateSettings } = useSettings();

  return (
    <Card>
      <SettingsCardHeader
        title="强调色"
        description="界面唯一的强调色：按钮、选中态、进度、链接与 Hero 抽象图形都会跟随，切换即时生效；默认朱红。"
        action={
          <CardResetButton
            title="本卡重置：强调色回到默认朱红"
            disabled={settings.accentColor === DEFAULT_ACCENT_THEME}
            onClick={() => updateSettings({ accentColor: DEFAULT_ACCENT_THEME })}
          />
        }
      />
      <CardContent>
        <ColorPalettePicker
          value={settings.accentColor}
          onChange={(next) => updateSettings({ accentColor: next })}
          label="选择强调色"
          hint="色板中每个色系都保持纸墨风的明度与可读性；品牌 App 图标不随强调色变化。"
          ariaLabel="界面强调色"
        />
      </CardContent>
    </Card>
  );
}

/** 封面占位色卡片：只影响没有自带封面图的书籍占位封面。 */
function CoverColorCard() {
  const { settings, updateSettings } = useSettings();

  return (
    <Card>
      <SettingsCardHeader
        title="封面占位色"
        description="只影响没有自带封面图的书籍：书架与知识库里的占位封面渐变用这一套色；与强调色互相独立。默认朱红。"
        action={
          <CardResetButton
            title="本卡重置：封面占位色回到默认朱红"
            disabled={settings.coverColor === DEFAULT_COVER_THEME}
            onClick={() => updateSettings({ coverColor: DEFAULT_COVER_THEME })}
          />
        }
      />
      <CardContent>
        <ColorPalettePicker
          value={settings.coverColor}
          onChange={(next) => updateSettings({ coverColor: next })}
          label="选择封面占位色"
          hint="选色后书架/知识库的占位封面即时更新；已有真实封面图的书籍不受影响。"
          ariaLabel="封面占位色"
        />
      </CardContent>
    </Card>
  );
}

/** 单个顶部标签最小宽度滑杆（数字用 serif 展示，范围/步进来自 READER_TAB_MIN_WIDTH）。 */
function TabMinWidthField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className={cn(fieldLabelClass, disabled && "text-ink-soft/60")}>
          {label}
        </label>
        <span className="shrink-0 font-serif text-sm tabular-nums text-ink" aria-hidden="true">
          {value}px
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={READER_TAB_MIN_WIDTH.min}
        max={READER_TAB_MIN_WIDTH.max}
        step={READER_TAB_MIN_WIDTH.step}
        value={value}
        disabled={disabled}
        aria-describedby={hintId}
        aria-valuetext={`${value} 像素`}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full cursor-pointer accent-cinnabar focus:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <p id={hintId} className={hintClass}>
        {hint}
      </p>
    </div>
  );
}

/** 阅读器面板卡片：面板形态 / 收缩优先级 / 左右顶部标签最小宽度。 */
function ReaderPanelCard() {
  const { settings, updateSettings } = useSettings();
  const panelModeId = useId();
  const panelModeHintId = useId();
  const shrinkPriorityId = useId();
  const shrinkPriorityHintId = useId();

  const currentPanelMode =
    READER_PANEL_MODE_OPTIONS.find((option) => option.value === settings.readerPanelMode) ??
    READER_PANEL_MODE_OPTIONS[0];
  const currentShrinkPriority =
    PANE_SHRINK_PRIORITY_OPTIONS.find(
      (option) => option.value === settings.paneShrinkPriority,
    ) ?? PANE_SHRINK_PRIORITY_OPTIONS[0];

  /** 只重置本卡：面板形态/收缩优先级/顶部标签最小宽度回到默认。 */
  const resetCard = () => {
    updateSettings({
      readerPanelMode: "drawer",
      paneShrinkPriority: "left",
      readerLeftTabMinWidth: READER_TAB_MIN_WIDTH.defaultLeft,
      readerRightTabMinWidth: READER_TAB_MIN_WIDTH.defaultRight,
    });
  };

  return (
    <Card>
      <SettingsCardHeader
        title="阅读器面板"
        description="只作用于阅读器：窄屏时左右面板如何呈现、空间不足时先收哪一栏，以及知识/探索面板顶部每一项的最小宽度；不影响首页布局。"
        action={
          <CardResetButton
            title="本卡重置：面板形态回到「覆盖式浮层」、收缩优先级回到「先收左面板」、顶部项最小宽度回到 64/72px"
            onClick={resetCard}
          />
        }
      />
      <CardContent className="space-y-6">
        <div>
          <label htmlFor={panelModeId} className={fieldLabelClass}>
            窄屏面板形态
          </label>
          <select
            id={panelModeId}
            value={settings.readerPanelMode}
            aria-describedby={panelModeHintId}
            onChange={(event) =>
              updateSettings({ readerPanelMode: event.target.value as ReaderPanelMode })
            }
            className={selectClass}
          >
            {READER_PANEL_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id={panelModeHintId} className={hintClass}>
            {currentPanelMode.description}
            <span className="text-ink-soft/60">（左右面板共用同一形态）</span>
          </p>
        </div>

        <Separator />

        <div>
          <label htmlFor={shrinkPriorityId} className={fieldLabelClass}>
            收缩优先级
          </label>
          <select
            id={shrinkPriorityId}
            value={settings.paneShrinkPriority}
            aria-describedby={shrinkPriorityHintId}
            onChange={(event) =>
              updateSettings({ paneShrinkPriority: event.target.value as PaneShrinkPriority })
            }
            className={selectClass}
          >
            {PANE_SHRINK_PRIORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id={shrinkPriorityHintId} className={hintClass}>
            {currentShrinkPriority.description}
          </p>
        </div>

        <Separator />

        <div>
          <p className={fieldLabelClass}>面板顶部项最小宽度</p>
          <p className={hintClass}>
            阅读器左右面板顶部每一项（如知识库/注释/目录、摘要/对话）的最小宽度；值越大越不容易被挤成省略号，但同屏能放下的项更少。
          </p>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <TabMinWidthField
              label="知识面板（左栏）"
              hint={`范围 ${READER_TAB_MIN_WIDTH.min}–${READER_TAB_MIN_WIDTH.max}px，默认 ${READER_TAB_MIN_WIDTH.defaultLeft}px。`}
              value={settings.readerLeftTabMinWidth}
              onChange={(value) => updateSettings({ readerLeftTabMinWidth: value })}
            />
            <TabMinWidthField
              label="探索面板（右栏）"
              hint={`范围 ${READER_TAB_MIN_WIDTH.min}–${READER_TAB_MIN_WIDTH.max}px，默认 ${READER_TAB_MIN_WIDTH.defaultRight}px。`}
              value={settings.readerRightTabMinWidth}
              onChange={(value) => updateSettings({ readerRightTabMinWidth: value })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** 外观分类主体。 */
export function AppearanceSection() {
  return (
    <div className="space-y-4">
      <AccentColorCard />
      <CoverColorCard />
      <ReaderPanelCard />
    </div>
  );
}
