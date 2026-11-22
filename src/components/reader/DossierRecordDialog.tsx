import type { KnowledgeEntry } from "@jusong/core";

import { formatDateTime } from "../../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Separator } from "../ui/separator";

interface DossierRecordDialogProps {
  entry: KnowledgeEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function payloadText(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** 原始档案记录弹窗：标题 + 正文 + 原始 JSON（保持与旧版「查看档案」一致）。 */
export function DossierRecordDialog({ entry, open, onOpenChange }: DossierRecordDialogProps) {
  const payload = entry ? payloadText(entry.payload) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {entry ? (
          <>
            <DialogHeader>
              <DialogTitle>{entry.title}</DialogTitle>
              <DialogDescription>
                {entry.type === "legacy-article" ? "档案" : "知识条目"} · {formatDateTime(entry.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <Separator />
            <div className="min-w-0 whitespace-pre-wrap break-words text-sm leading-7 text-ink">
              {entry.body}
            </div>
            {payload ? (
              <div className="min-w-0">
                <p className="mb-1.5 text-xs font-medium text-ink-soft">档案数据</p>
                <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-[11px] leading-5 text-ink-soft">
                  {payload}
                </pre>
              </div>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
