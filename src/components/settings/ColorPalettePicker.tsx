import { useId } from "react";
import { Check } from "lucide-react";

import { ACCENT_THEMES, type AccentTheme, type AccentThemeId } from "../../lib/theme";
import { cn } from "../../lib/utils";

export interface ColorPalettePickerProps {
  /** 当前选中的色系 id（`AccentThemeId`）。 */
  value: AccentThemeId;
  /** 选中某个色系时回调；调用方负责写入设置（强调色 / 封面占位色共用本组件）。 */
  onChange: (id: AccentThemeId) => void;
  /** 可选的标题，显示在色板上方。 */
  label?: string;
  /** 可选的说明文字，显示在色板下方，同时作为 radiogroup 的 description。 */
  hint?: string;
  /** 可选的无障碍名称；缺省用 `label`，再退化为「强调色」。 */
  ariaLabel?: string;
}

/**
 * 用主题数据生成色块的预览渐变：强调色 → 封面占位渐变（同一色系的深浅）。
 * 不硬编码任何颜色，换色板只需改 `lib/theme.ts` 的 ACCENT_THEMES。
 */
function swatchBackground(theme: AccentTheme): string {
  const { accent, coverGradient } = theme;
  return `linear-gradient(135deg, hsl(${accent}) 0%, hsl(${coverGradient.via}) 62%, hsl(${coverGradient.to}) 100%)`;
}

/**
 * 共用色板选择器（设置-外观的「强调色」与「封面占位色」都用它）。
 *
 * 无障碍与键盘：原生 radio 组成一个 `radiogroup`，方向键切换、空格/回车选中；
 * 输入框视觉隐藏但保留焦点，焦点样式通过 `peer-focus-visible` 画在色块上。
 * 选中态：色块外圈描边 + 对勾 + 文字加粗，不只依赖颜色区分。
 */
export function ColorPalettePicker({
  value,
  onChange,
  label,
  hint,
  ariaLabel,
}: ColorPalettePickerProps) {
  const groupName = useId();
  const labelId = useId();
  const hintId = useId();

  return (
    <div className="space-y-2.5">
      {label ? (
        <p id={labelId} className="text-sm font-medium text-ink">
          {label}
        </p>
      ) : null}

      <div
        role="radiogroup"
        aria-label={label ? undefined : ariaLabel ?? "强调色"}
        aria-labelledby={label ? labelId : undefined}
        aria-describedby={hint ? hintId : undefined}
        className="flex flex-wrap items-start gap-x-3 gap-y-2.5"
      >
        {ACCENT_THEMES.map((theme) => {
          const selected = theme.id === value;
          return (
            <label
              key={theme.id}
              className="group flex cursor-pointer flex-col items-center gap-1.5 rounded-md py-0.5 outline-none"
            >
              <input
                type="radio"
                name={groupName}
                value={theme.id}
                checked={selected}
                onChange={() => onChange(theme.id)}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                data-theme-id={theme.id}
                className={cn(
                  "relative grid h-9 w-9 place-items-center rounded-full border shadow-sm transition-transform duration-150 group-hover:scale-105 group-active:scale-95",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-cinnabar/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-paper",
                  selected
                    ? "border-ink/30 ring-2 ring-cinnabar ring-offset-2 ring-offset-paper"
                    : "border-ink/10",
                )}
                style={{ backgroundImage: swatchBackground(theme) }}
              >
                {selected ? (
                  <Check
                    className="h-4 w-4 text-paper-soft drop-shadow-[0_1px_1px_rgba(0,0,0,0.45)]"
                    strokeWidth={3}
                    aria-hidden="true"
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  "text-[11px] leading-none transition-colors",
                  selected
                    ? "font-medium text-ink"
                    : "text-ink-soft/80 group-hover:text-ink-soft",
                )}
              >
                {theme.label}
              </span>
            </label>
          );
        })}
      </div>

      {hint ? (
        <p id={hintId} className="max-w-lg text-xs leading-5 text-ink-soft/70">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
