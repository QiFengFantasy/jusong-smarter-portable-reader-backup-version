import { useState } from "react";
import { Sparkles } from "lucide-react";

import { cn } from "../../lib/utils";

interface GenerateHintButtonProps {
  label?: string;
  hint?: string;
  className?: string;
}

/**
 * 缺失数据时的「生成」占位按钮。
 * 生成逻辑暂未接入分析 API，点击只提示待接入，不做任何写入。
 */
export function GenerateHintButton({
  label = "生成",
  hint = "生成接口尚未接入，后续与分析 API 对接后启用。",
  className,
}: GenerateHintButtonProps) {
  const [shown, setShown] = useState(false);
  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <button
        type="button"
        onClick={() => setShown(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-cinnabar/40 bg-cinnabar/5 px-2.5 py-1.5 text-[11px] text-cinnabar transition-colors hover:bg-cinnabar/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30"
      >
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        {label}
      </button>
      {shown ? (
        <p role="status" className="text-[10px] leading-4 text-ink-soft/70">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
