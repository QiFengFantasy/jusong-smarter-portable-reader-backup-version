import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { BookTransferInfo, ExportResult, TransferProgress } from "@jusong/core";
import {
  Archive,
  ArrowLeft,
  BookMarked,
  Download,
  FileText,
  FolderDown,
  Loader2,
} from "lucide-react";

import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ErrorPanel, LoadingPanel } from "../feedback";
import { PlaceholderPage } from "./PlaceholderPanel";
import { useLibrary } from "../../lib/library";
import { getErrorMessage } from "../../lib/utils";

/** 导出模式：原文件 / 加密解析包 / 全部（原文件 + 加密解析包）。 */
export type ExportMode = "original" | "package" | "all";

/** 进度事件 payload：按契约可能缺省 direction/requestId（旧后端），这里做宽松读取。 */
type TransferProgressPayload = Partial<TransferProgress>;

/** 与 Rust 端 `library-export-progress` 对应的事件名（契约统一为 library-transfer-progress）。 */
const TRANSFER_PROGRESS_EVENT = "library-transfer-progress";

/** `.jusong` 解析包扩展名（内部 ZIP + 固定密钥加密，仅本应用可导入）。 */
export const PACKAGE_EXTENSION = "jusong";

const PHASE_LABEL: Record<TransferProgress["phase"], string> = {
  copy: "复制文件",
  zip: "打包",
  unzip: "解压",
  validate: "校验",
  encrypt: "加密",
  decrypt: "解密",
};

const FORMAT_LABEL: Record<string, string> = {
  epub: "EPUB 电子书",
  mobi: "MOBI 原始文件",
  pdf: "PDF 原始文件",
  txt: "TXT 原始文件",
  seed: "种子书",
};

/** 字节数 → 人类可读体积；非法值显示「—」。 */
export function formatBytes(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 文件名安全化：去掉路径分隔与 Windows 非法字符。 */
function sanitizeFileBase(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned.slice(0, 60) || "book";
}

/** 原文件扩展名（优先用 sourceName，缺失回退书籍格式）。 */
function originalExtension(info: BookTransferInfo): string {
  const sourceName = info.sourceName ?? "";
  const dot = sourceName.lastIndexOf(".");
  const raw = dot > 0 ? sourceName.slice(dot + 1).toLowerCase() : info.format;
  return /^[a-z0-9]{1,8}$/.test(raw) ? raw : "bin";
}

/** 由书籍信息推导默认导出文件名。 */
export function defaultExportName(info: BookTransferInfo): { original: string; package: string } {
  const base = sanitizeFileBase(info.title);
  return {
    original: `${base}.${originalExtension(info)}`,
    package: `${base}-解析包.${PACKAGE_EXTENSION}`,
  };
}

const MODE_LABEL: Record<ExportMode, string> = {
  original: "导出原文件",
  package: "导出加密解析包",
  all: "全部导出",
};

export interface ExportBookViewProps {
  /** 指定书籍；缺省读路由参数 `/export/:bookId`。都没有时显示 Hero 指引。 */
  bookId?: string;
  className?: string;
}

interface StatItem {
  label: string;
  value: string;
}

function HeroStep({ index, title, description }: { index: number; title: string; description: string }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border/80 bg-paper/70 p-3.5">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-cinnabar/30 bg-cinnabar/[0.06] text-[11px] font-medium text-cinnabar">
        {index}
      </span>
      <span className="min-w-0">
        <span className="block font-serif text-sm font-semibold tracking-wide text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-6 text-ink-soft">{description}</span>
      </span>
    </li>
  );
}

/**
 * 导出书籍页。
 *
 * - 无 `bookId`（路由 `/export` 或首页「导出 · 导出书籍」）：渲染 Hero 指引，说明如何从书架进入。
 * - 有 `bookId`（路由 `/export/:bookId`）：调 `library.getBookTransferInfo` 显示统计，
 *   提供原文件 / 加密解析包（`.jusong`）/ 全部三种导出；进度经 `library-transfer-progress` 事件展示。
 *
 * 组件可独立成页（路径以 `/export` 开头时补全屏外壳），也可嵌在首页中间栏。
 */
export function ExportBookView({ bookId: bookIdProp, className }: ExportBookViewProps) {
  const params = useParams<{ bookId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { library, status, error: libraryError } = useLibrary();

  const bookId = bookIdProp ?? params.bookId ?? null;
  const standalone = location.pathname.startsWith("/export");

  /** 回书架：带一次性 openView，避免首页恢复「上次选择的是导出入口」而绕回本页。 */
  const goShelf = () => navigate("/", { state: { openView: "shelf" } });

  const [info, setInfo] = useState<BookTransferInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ExportMode | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [progress, setProgress] = useState<TransferProgressPayload | null>(null);

  /** 正在导出中：进度事件只在活动期间接收（组件卸载/导出结束置 false）。 */
  const busyRef = useRef(false);

  const loadInfo = useCallback(async () => {
    if (!library || !bookId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await library.getBookTransferInfo(bookId);
      setInfo(next);
    } catch (reason) {
      setInfo(null);
      setLoadError(getErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [bookId, library]);

  useEffect(() => {
    if (!bookId) {
      setInfo(null);
      setLoadError(null);
      return;
    }
    if (!library || status !== "ready") return;
    void loadInfo();
  }, [bookId, library, status, loadInfo]);

  // 切换书籍时清掉上一次的导出结果/进度，避免串到另一本书。
  useEffect(() => {
    setResult(null);
    setExportError(null);
    setProgress(null);
    busyRef.current = false;
    setBusy(null);
  }, [bookId]);

  // 导出进度事件：仅接收导出方向；组件卸载时取消监听（lead 要求）。
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    listen<TransferProgressPayload>(TRANSFER_PROGRESS_EVENT, (event) => {
      if (disposed || !busyRef.current) return;
      const payload = event.payload;
      if (!payload) return;
      if (payload.direction && payload.direction !== "export") return;
      setProgress(payload);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // 非 Tauri 环境没有事件通道；导出本身会给出错误提示。
      });

    return () => {
      disposed = true;
      busyRef.current = false;
      unlisten?.();
    };
  }, []);

  const stats = useMemo<StatItem[]>(() => {
    if (!info) return [];
    return [
      { label: "章节", value: `${info.chapterCount}` },
      { label: "档案", value: `${info.archiveCount}` },
      { label: "摘要", value: `${info.digestCount}` },
      { label: "原文件", value: formatBytes(info.sourceSize) },
      { label: "加密解析包（内容合计）", value: formatBytes(info.packageSize) },
    ];
  }, [info]);

  const canExportOriginal = Boolean(info?.sourceName) && (info?.sourceSize ?? 0) > 0;
  const pendingParse = info?.parseState === "pending";

  const handleExport = async (mode: ExportMode) => {
    if (!bookId || !info) return;
    if (!isTauri()) {
      setExportError("浏览器运行已停用：请使用 Tauri 桌面版导出书籍。");
      return;
    }
    if (!library) {
      setExportError("书库尚未就绪，请稍后重试。");
      return;
    }
    if (mode === "original" && !canExportOriginal) {
      setExportError("该书没有可用的原文件（或原文件大小为 0），无法导出原文件。");
      return;
    }

    setExportError(null);
    setResult(null);
    setProgress(null);

    const names = defaultExportName(info);
    let destination: string | null = null;
    try {
      if (mode === "all") {
        const picked = await open({
          directory: true,
          multiple: false,
          title: "选择导出目录（原文件与加密解析包将写入此目录）",
        });
        destination = typeof picked === "string" ? picked : Array.isArray(picked) ? (picked[0] ?? null) : null;
      } else if (mode === "original") {
        destination = await save({
          title: "导出原文件",
          defaultPath: names.original,
          filters: [{ name: `${originalExtension(info).toUpperCase()} 文件`, extensions: [originalExtension(info)] }],
        });
      } else {
        destination = await save({
          title: "导出加密解析包",
          defaultPath: names.package,
          filters: [{ name: "沮诵加密解析包（.jusong）", extensions: [PACKAGE_EXTENSION] }],
        });
      }
    } catch (reason) {
      setExportError(getErrorMessage(reason));
      return;
    }
    if (!destination) return;

    setBusy(mode);
    busyRef.current = true;
    try {
      const exported = await library.exportBook(bookId, mode, destination);
      setResult(exported);
    } catch (reason) {
      setExportError(getErrorMessage(reason));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const phaseLabel = progress?.phase
    ? (PHASE_LABEL[progress.phase as TransferProgress["phase"]] ?? "处理中")
    : "准备中";
  const percent =
    progress && progress.total && progress.total > 0 && progress.current != null
      ? Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)))
      : null;

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs leading-6 text-ink-soft/70">
        数据留在自己的设备上；导出只读取书库，不修改原书。
      </p>
      {standalone ? (
        <Button type="button" variant="outline" size="sm" onClick={goShelf}>
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          返回书架
        </Button>
      ) : null}
    </div>
  );

  const hero = (
    <PlaceholderPage
      className={className}
      eyebrow="导出 · BOOKS"
      title="导出书籍"
      planLabel="书籍迁移"
      description={
        <>
          <p>
            导出把本地书籍整理成可迁移的文件：可以只带走原文件，也可以导出包含卷 / 章结构、目录与
            <span className="text-ink"> source/ </span>
            原文件的加密解析包（<span className="text-ink">.jusong</span>，仅沮诵可导入）。
          </p>
          <p className="text-xs leading-6 text-ink-soft/75 sm:text-sm">
            从书架选择一本书进入导出统计页，再决定导出范围。
          </p>
        </>
      }
      footer={footer}
    >
      <ol className="grid gap-3 sm:grid-cols-2">
        <HeroStep index={1} title="在书架找到书" description="打开首页 · 书架，找到要导出的书籍卡片。" />
        <HeroStep index={2} title="右键或长按卡片" description="桌面端右键卡片；移动端长按约 0.5 秒打开菜单。" />
        <HeroStep index={3} title="选择「导出书籍」" description="进入导出统计页，查看章节、档案、摘要与体积。" />
        <HeroStep index={4} title="选择导出范围" description="导出原文件、加密解析包（.jusong），或一次导出两个文件。" />
      </ol>
      <div className="mt-4">
        <Button type="button" onClick={goShelf}>
          <BookMarked className="h-4 w-4" aria-hidden="true" />
          去书架选书
        </Button>
      </div>
    </PlaceholderPage>
  );

  const body = !bookId ? (
    hero
  ) : status === "error" ? (
    <PlaceholderPage
      className={className}
      eyebrow="导出 · BOOKS"
      title="导出书籍"
      description={<p>书库初始化失败，暂时无法读取导出信息。</p>}
      footer={footer}
    >
      <ErrorPanel title="书库初始化失败" message={libraryError ?? "未知错误"} />
    </PlaceholderPage>
  ) : status !== "ready" || loading || (!info && !loadError) ? (
    <PlaceholderPage
      className={className}
      eyebrow="导出 · BOOKS"
      title="导出书籍"
      description={<p>正在读取这本书的导出信息…</p>}
      footer={footer}
    >
      <LoadingPanel compact label="正在统计章节、档案与原文件体积…" />
    </PlaceholderPage>
  ) : loadError ? (
    <PlaceholderPage
      className={className}
      eyebrow="导出 · BOOKS"
      title="导出书籍"
      description={<p>未能读取这本书的导出信息。</p>}
      footer={footer}
    >
      <ErrorPanel
        title="读取导出信息失败"
        message={loadError}
        onRetry={() => void loadInfo()}
        retryLabel="重试"
        action={
          <Button type="button" variant="outline" size="sm" onClick={goShelf}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            返回书架
          </Button>
        }
      />
    </PlaceholderPage>
  ) : info ? (
    <PlaceholderPage
      className={className}
      eyebrow="导出 · BOOKS"
      title={info.title}
      planLabel={FORMAT_LABEL[info.format] ?? info.format.toUpperCase()}
      description={
        <>
          <p className="text-sm text-ink-soft">
            {info.author ? `${info.author} · ` : null}
            {info.publisher ? `${info.publisher} · ` : null}
            {pendingParse ? "原始文件书（待解析）· " : null}
            导出统计如下，选择范围后开始导出。
          </p>
          {pendingParse ? (
            <p className="rounded-md border border-dashed border-cinnabar/25 bg-cinnabar/[0.04] px-3 py-2 text-xs leading-6 text-ink-soft">
              这本非 EPUB 书按原始文件入库：没有章节正文，导出加密解析包（.jusong）会包含 book.json、目录与原文件，
              供之后继续解析或迁移。
            </p>
          ) : null}
        </>
      }
      footer={footer}
    >
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Archive className="h-4 w-4 text-cinnabar" aria-hidden="true" />
            导出统计
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {stats.map((item) => (
              <div key={item.label} className="rounded-md border border-border/70 bg-paper/60 px-3 py-2">
                <dt className="text-[11px] tracking-wide text-ink-soft/80">{item.label}</dt>
                <dd className="mt-0.5 font-serif text-lg font-semibold text-ink">{item.value}</dd>
              </div>
            ))}
          </dl>
          {info.sourceName ? (
            <p className="mt-3 break-all text-[11px] text-ink-soft/70">原文件：{info.sourceName}</p>
          ) : (
            <p className="mt-3 text-[11px] text-ink-soft/70">没有记录原文件名，原文件导出不可用。</p>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void handleExport("original")}
          disabled={busy !== null || !canExportOriginal}
          title={canExportOriginal ? "把 source/ 下的原文件复制到指定位置" : "没有可用的原文件"}
        >
          {busy === "original" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileText className="h-4 w-4" aria-hidden="true" />
          )}
          导出原文件
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void handleExport("package")}
          disabled={busy !== null}
          title="把整个书籍目录（含 source/）打包为加密解析包 .jusong"
        >
          {busy === "package" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Archive className="h-4 w-4" aria-hidden="true" />
          )}
          导出加密解析包
        </Button>
        <Button
          type="button"
          onClick={() => void handleExport("all")}
          disabled={busy !== null || !canExportOriginal}
          title={canExportOriginal ? "选择一个目录，分别写出原文件与加密解析包 .jusong" : "没有可用的原文件"}
        >
          {busy === "all" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FolderDown className="h-4 w-4" aria-hidden="true" />
          )}
          全部导出（两个文件）
        </Button>
      </div>

      {busy ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 rounded-lg border border-border/80 bg-paper-soft/70 px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-cinnabar" aria-hidden="true" />
            <span className="font-medium text-ink">{MODE_LABEL[busy]}进行中…</span>
            <span className="rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] tracking-wider">
              {phaseLabel}
            </span>
            {percent !== null ? <span className="text-[11px]">{percent}%</span> : null}
          </div>
          {percent !== null ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-cinnabar transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
          ) : null}
          {progress?.message ? (
            <p className="mt-1.5 break-all text-[11px] leading-5 text-ink-soft/80">{progress.message}</p>
          ) : null}
        </div>
      ) : null}

      {exportError ? (
        <ErrorPanel className="mt-4" title="导出失败" message={exportError} />
      ) : null}

      {result ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 rounded-lg border border-emerald-700/25 bg-emerald-50/70 px-4 py-3 text-emerald-900"
        >
          <p className="flex items-center gap-2 font-serif text-sm font-semibold tracking-wide">
            <Download className="h-4 w-4" aria-hidden="true" />
            导出完成
          </p>
          <ul className="mt-2 space-y-1">
            {result.files.length > 0 ? (
              result.files.map((file) => (
                <li key={file.path} className="break-all text-xs leading-6">
                  {file.path}
                  <span className="ml-2 text-[11px] text-emerald-800/80">{formatBytes(file.bytes)}</span>
                </li>
              ))
            ) : (
              <li className="text-xs leading-6">导出命令已返回，但没有文件记录。</li>
            )}
          </ul>
          <p className="mt-2 text-[11px] leading-5 text-emerald-800/80">
            解析包为加密的 <code className="rounded bg-emerald-900/10 px-1">.jusong</code> 文件，
            可迁移到其他沮诵设备导入；建议先在文件管理器确认文件已生成。
          </p>
        </div>
      ) : null}
    </PlaceholderPage>
  ) : (
    <PlaceholderPage
      className={className}
      eyebrow="导出 · BOOKS"
      title="导出书籍"
      description={<p>没有找到这本书，或书库尚未就绪。</p>}
      footer={footer}
    >
      <ErrorPanel
        title="未找到书籍"
        message={`bookId「${bookId}」不在当前书库中，可能已被删除。`}
        action={
          <Button type="button" variant="outline" size="sm" onClick={goShelf}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            返回书架
          </Button>
        }
      />
    </PlaceholderPage>
  );

  if (!standalone) return body;

  return <div className="flex h-screen flex-col overflow-hidden bg-paper">{body}</div>;
}
