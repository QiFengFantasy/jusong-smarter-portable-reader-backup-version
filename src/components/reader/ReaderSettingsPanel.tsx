import { useEffect, useRef } from "react";
import { ChevronLeft } from "lucide-react";

import { SettingsContent } from "../settings/SettingsContent";
import { Button } from "../ui/button";

interface ReaderSettingsPanelProps {
  /** 关闭覆盖层，回到阅读（正文与滚动位置保持不变）。 */
  onClose: () => void;
}

/**
 * 阅读器内的设置覆盖层。
 *
 * 阅读器顶栏的「设置」不再跳 `/settings`：改为在阅读器内铺一层全屏覆盖层。
 * 覆盖层是 `position: fixed`，正文组件不卸载，因此关闭后仍在原阅读位置；
 * 顶部左侧是「返回阅读」（取代返回书架，覆盖层内不保留返回书架），中间是标题「设置」。
 *
 * 设置本体复用首页/独立路由同一个 `<SettingsContent showHeader={false} />`，
 * 保证阅读设置只有一份实现。
 */
export function ReaderSettingsPanel({ onClose }: ReaderSettingsPanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Esc 关闭；打开时把焦点放到「返回阅读」，键盘用户可直接回车退出。
  useEffect(() => {
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Radix 弹窗自己处理 Esc；覆盖层打开时不在同一层，直接关闭即可。
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      data-reader-settings-overlay="true"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      className="fixed inset-0 z-[60] flex flex-col bg-paper text-ink"
    >
      <header className="relative flex h-14 shrink-0 items-center border-b border-border/70 bg-paper/90 px-2 backdrop-blur supports-[backdrop-filter]:bg-paper/75 sm:px-4">
        <Button
          ref={closeButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="-ml-1 shrink-0 gap-1 px-2 text-ink-soft hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          返回阅读
        </Button>
        <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-serif text-base font-semibold tracking-[0.22em] sm:text-lg">
          设置
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8">
          <SettingsContent showHeader={false} />
        </div>
      </div>
    </div>
  );
}
