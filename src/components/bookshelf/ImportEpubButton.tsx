import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { isTauri } from "@tauri-apps/api/core";
import { Loader2, Upload } from "lucide-react";

import { useLibrary } from "../../lib/library";
import { getErrorMessage } from "../../lib/utils";
import { Button } from "../ui/button";
import type { ButtonProps } from "../ui/button";

interface ImportEpubButtonProps {
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  label?: string;
  onImported?: (bookId: string) => void;
}

export function ImportEpubButton({
  variant = "default",
  size = "default",
  className,
  label = "导入 EPUB",
  onImported,
}: ImportEpubButtonProps) {
  const { pickAndImportEpub, status } = useLibrary();
  const navigate = useNavigate();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = importing || status !== "ready";

  const handlePick = async () => {
    if (!isTauri()) {
      setError("浏览器运行已停用：请使用 Tauri 桌面版导入 EPUB。");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const meta = await pickAndImportEpub();
      if (meta) {
        onImported?.(meta.id);
        navigate(`/read/${meta.id}`);
      }
    } catch (reason) {
      console.error("[jusong] EPUB 导入失败：", reason);
      setError(getErrorMessage(reason));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={handlePick}
        disabled={disabled}
      >
        {importing ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Upload className="h-4 w-4" aria-hidden="true" />
        )}
        {importing ? "正在导入…" : label}
      </Button>
      {error ? (
        <p role="alert" className="max-w-sm text-xs leading-5 text-cinnabar">
          {error}
        </p>
      ) : null}
    </div>
  );
}
