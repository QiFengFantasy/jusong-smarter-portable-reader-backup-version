import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { BookMeta, TransferProgress } from "@jusong/core";
import { CheckCircle2, FileUp, Loader2, Upload } from "lucide-react";

import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { ErrorPanel } from "../feedback";
import { PlaceholderPage } from "./PlaceholderPanel";
import { ImportBuildCompleteView } from "./ImportBuildCompleteView";
import { ImportBuildProgressView } from "./ImportBuildProgressView";
import { ImportBuildSelectionView } from "./ImportBuildSelectionView";
import { formatBytes, PACKAGE_EXTENSION } from "./ExportBookView";
import { fetchAgentConfig } from "../../lib/agent";
import type { BuildItemId, BuildResult } from "../../lib/import-build/types";
import { useLibrary } from "../../lib/library";
import { getErrorMessage } from "../../lib/utils";

/** 导入进度事件：与 Rust 端 `library-transfer-progress` 对应。 */
const TRANSFER_PROGRESS_EVENT = "library-transfer-progress";

type ImportFileKind = "epub" | "package" | "original";

interface PickedFile {
  path: string;
  name: string;
  ext: string;
  kind: ImportFileKind;
  /** Android content:// 探测时已读出的字节，避免重复 IPC。 */
  buffer?: ArrayBuffer;
}

type ImportStage = "preparing" | "reading" | "parsing" | "importing" | "writing";

const STAGE_LABEL: Record<ImportStage, string> = {
  preparing: "识别文件类型…",
  reading: "读取文件…",
  parsing: "解析 EPUB（卷 / 章 / 目录 / 封面）…",
  importing: "解密、校验并写入书库…",
  writing: "刷新书架…",
};

const EXTENSION_KIND: Record<string, ImportFileKind> = {
  epub: "epub",
  [PACKAGE_EXTENSION]: "package",
  mobi: "original",
  pdf: "original",
  txt: "original",
};

const KIND_LABEL: Record<ImportFileKind, string> = {
  epub: "EPUB 电子书",
  package: "加密解析包（.jusong）",
  original: "原始文件",
};

const KIND_HINT: Record<ImportFileKind, string> = {
  epub: "解析卷 / 章 / 目录并生成结构摘要；成功后出现在书架。",
  package: "解密并校验 book.json 与书籍目录后合并入书库，包含原文件与知识库数据。",
  original: "MOBI / PDF / TXT 作为原始文件书入库：保留原文件、标记待解析，暂不生成章节。",
};

const PHASE_LABEL: Record<TransferProgress["phase"], string> = {
  copy: "复制文件",
  zip: "打包",
  unzip: "解压",
  validate: "校验",
  encrypt: "加密",
  decrypt: "解密",
};

function decodeUriPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function baseName(path: string): string {
  const decoded = decodeUriPath(path);
  return decoded.split(/[\\/]/).pop() ?? decoded;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 进度事件 payload：宽松读取旧后端的缺省字段。 */
type TransferProgressPayload = Partial<TransferProgress>;

/**
 * EPUB 基础导入成功后的第二流程（仅 EPUB）：
 * select = 选择构建条目，building = 全屏团队对话，complete = 构建结果。
 * `.jusong` 解析包与原始文件不进入该流程，沿用原完成卡片。
 */
type BuildFlow =
  | { step: "select" }
  | { step: "building"; selected: BuildItemId[] }
  | { step: "complete"; result: BuildResult };

export interface ImportBooksViewProps {
  className?: string;
}

/**
 * 导入书籍页（替换原「导入 · 导入书籍」占位）。
 *
 * - 「选择文件」经 Tauri dialog 选 `.epub` / `.jusong` / `.mobi` / `.pdf` / `.txt`；
 * - 按扩展名分流：`.jusong` → `library.importPackage`（解密校验），epub → 现有 EPUB 解析导入流程，
 *   其他 → `library.importOriginalBook`（原始文件书，待解析）；
 * - 显示类型识别、处理阶段与 `library-transfer-progress` 进度；
 * - EPUB 基础导入成功 → 进入第二流程：选择构建条目 → 全屏 AGENT 团队构建 → 完成页；
 *   `.jusong` 解析包与原始文件保持原有完成卡片，不触发构建；跳过 / 完成都回书架；
 * - 构建前用 `fetchAgentConfig` 检查 AGENT Key，无 Key 时选择页禁用开始并引导去设置。
 *
 * 不直接读写文件：读文件走 Rust 命令 `library_read_epub`，写库全部经 Library。
 */
export function ImportBooksView({ className }: ImportBooksViewProps) {
  const navigate = useNavigate();
  const { library, status, error: libraryError, refreshBooks } = useLibrary();

  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [stage, setStage] = useState<ImportStage | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TransferProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BookMeta | null>(null);
  /** EPUB 第二流程的当前步骤；其他文件类型始终为 null。 */
  const [buildFlow, setBuildFlow] = useState<BuildFlow | null>(null);
  const [agentConfigured, setAgentConfigured] = useState(false);
  /** 正在向 Rust 询问 AGENT 配置（进入选择页 / 点开始构建时）。 */
  const [checkingAgent, setCheckingAgent] = useState(false);

  /** 回书架：带一次性 openView，避免首页恢复「上次选择的是导入入口」而绕回本页。 */
  const goShelf = () => navigate("/", { state: { openView: "shelf" } });

  /** 读取 AGENT 配置（只看 configured，不接触密钥明文）；失败按未配置处理。 */
  const refreshAgentStatus = useCallback(async (): Promise<boolean> => {
    setCheckingAgent(true);
    let configured = false;
    try {
      configured = (await fetchAgentConfig()).configured;
    } catch {
      configured = false;
    } finally {
      setCheckingAgent(false);
    }
    setAgentConfigured(configured);
    return configured;
  }, []);

  /** 选择页点「开始构建」：先复查 Key（用户可能刚在设置里配置），再进入全屏构建。 */
  const handleStartBuild = (selected: BuildItemId[]) => {
    if (!result || selected.length === 0) return;
    void (async () => {
      const configured = await refreshAgentStatus();
      if (!configured) return;
      setBuildFlow({ step: "building", selected });
    })();
  };

  /** 构建结束（成功或中断）：进入完成页，并刷新书架以显示新写入的知识。 */
  const handleBuildComplete = (buildResult: BuildResult) => {
    setBuildFlow({ step: "complete", result: buildResult });
    void refreshBooks().catch((reason) => {
      console.warn("[jusong] 构建完成后刷新书架失败：", reason);
    });
  };

  /** 仅导入期间接收进度事件；组件卸载或导入结束即停止。 */
  const busyRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    listen<TransferProgressPayload>(TRANSFER_PROGRESS_EVENT, (event) => {
      if (disposed || !busyRef.current) return;
      const payload = event.payload;
      if (!payload) return;
      if (payload.direction && payload.direction !== "import") return;
      setProgress(payload);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // 非 Tauri 环境没有事件通道；导入本身会给出错误提示。
      });

    return () => {
      disposed = true;
      busyRef.current = false;
      unlisten?.();
    };
  }, []);

  const runImport = async (file: PickedFile) => {
    if (!library) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(null);
    setStage("preparing");
    busyRef.current = true;
    try {
      let meta: BookMeta;
      if (file.kind === "epub") {
        setStage("reading");
        const bytes =
          file.buffer ??
          (await invoke<ArrayBuffer | number[]>("library_read_epub", { path: file.path }));
        const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
        setStage("parsing");
        meta = await library.importEpub({ name: file.name, buffer, path: file.path });
      } else if (file.kind === "package") {
        setStage("importing");
        meta = await library.importPackage(file.path);
      } else {
        setStage("importing");
        meta = await library.importOriginalBook(file.path);
      }

      setStage("writing");
      await refreshBooks();
      setResult(meta);
      // 只有 EPUB 基础导入成功才进入第二流程；`.jusong` / 原始文件保持原有完成卡片。
      if (file.kind === "epub" && meta.format === "epub" && meta.parseState !== "pending") {
        setBuildFlow({ step: "select" });
        void refreshAgentStatus();
      }
    } catch (reason) {
      console.error("[jusong] 导入书籍失败：", reason);
      setError(getErrorMessage(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStage(null);
    }
  };

  const chooseFile = async () => {
    setError(null);
    setResult(null);
    setProgress(null);
    setBuildFlow(null);
    setAgentConfigured(false);
    if (!isTauri()) {
      setError("浏览器运行已停用：请使用 Tauri 桌面版导入书籍。");
      return;
    }
    if (status !== "ready" || !library) {
      setError("书库尚未就绪，请稍后重试。");
      return;
    }

    let selection: string | string[] | null = null;
    try {
      selection = await open({
        multiple: false,
        directory: false,
        title: "选择要导入的书籍文件",
        filters: [
          {
            name: "书籍文件（EPUB / 加密解析包 / 原始文件）",
            extensions: ["epub", PACKAGE_EXTENSION, "mobi", "pdf", "txt"],
          },
          { name: "EPUB 电子书", extensions: ["epub"] },
          { name: "加密解析包（.jusong）", extensions: [PACKAGE_EXTENSION] },
          { name: "原始文件（MOBI / PDF / TXT）", extensions: ["mobi", "pdf", "txt"] },
        ],
      });
    } catch (reason) {
      setError(getErrorMessage(reason));
      return;
    }
    const path = typeof selection === "string" ? selection : Array.isArray(selection) ? (selection[0] ?? null) : null;
    if (!path) return;

    const name = baseName(path);
    const ext = extensionOf(name);
    let kind = EXTENSION_KIND[ext];
    let buffer: ArrayBuffer | undefined;

    // Android 文件选择器返回 content:// URI，部分 provider 的 URI 末段没有扩展名。
    // 先用 ZIP/EPUB 读取探测一次；成功就按 EPUB 导入，避免误报“非 EPUB”。
    if (!kind && path.startsWith("content://")) {
      try {
        const bytes = await invoke<ArrayBuffer | number[]>("library_read_epub", { path });
        buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
        kind = "epub";
      } catch (reason) {
        setPicked(null);
        setError(getErrorMessage(reason));
        return;
      }
    }

    if (!kind) {
      setPicked(null);
      setError(
        ext === "zip"
          ? "旧版 .zip 解析包已不再支持：请让来源设备用当前版本重新导出 .jusong 加密解析包。"
          : ext
            ? `不支持的文件类型「.${ext}」：请选择 .epub、.jusong（加密解析包）、.mobi、.pdf 或 .txt。`
            : "无法识别文件类型：请选择 .epub、.jusong（加密解析包）、.mobi、.pdf 或 .txt。",
      );
      return;
    }

    const file: PickedFile = {
      path,
      name: kind === "epub" && !extensionOf(name) ? `${name || "book"}.epub` : name,
      ext: kind === "epub" && !ext ? "epub" : ext,
      kind,
      ...(buffer ? { buffer } : {}),
    };
    setPicked(file);
    await runImport(file);
  };

  const readableBook = result && result.format === "epub" && result.parseState !== "pending";

  const progressPercent =
    progress && progress.total && progress.total > 0 && progress.current != null
      ? Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)))
      : null;
  const progressPhase = progress?.phase
    ? (PHASE_LABEL[progress.phase as TransferProgress["phase"]] ?? "处理中")
    : null;

  // EPUB 第二流程：选择构建条目 → 全屏 AGENT 团队构建 → 完成页。
  // `.jusong` / 原始文件不会设置 buildFlow，继续走下方原有完成卡片。
  if (buildFlow && result) {
    switch (buildFlow.step) {
      case "select":
        return (
          <ImportBuildSelectionView
            book={result}
            agentConfigured={agentConfigured}
            busy={checkingAgent}
            onStart={handleStartBuild}
            onSkip={goShelf}
            onConfigureAgent={() => navigate("/", { state: { openView: "settings" } })}
          />
        );
      case "building":
        return library ? (
          <ImportBuildProgressView
            library={library}
            book={result}
            selected={buildFlow.selected}
            onComplete={handleBuildComplete}
          />
        ) : null;
      case "complete":
        return <ImportBuildCompleteView book={result} result={buildFlow.result} onShelf={goShelf} />;
    }
  }

  const page = (
    <PlaceholderPage
      className={className}
      eyebrow="导入 · BOOKS"
      title="导入书籍"
      planLabel="EPUB / 加密解析包 / 原始文件"
      description={
        <>
          <p>
            选择本地文件接入书斋：EPUB 会解析卷、章、目录并生成本地结构摘要；基础导入完成后可选择用 AGENT
            团队构建摘要、档案、地图地点与时间线。加密解析包（
            <span className="text-ink">.jusong</span>）会解密校验后合并入书库；MOBI / PDF / TXT
            作为原始文件书入库，暂不生成章节。
          </p>
          <p className="text-xs leading-6 text-ink-soft/75 sm:text-sm">
            所有文件只复制进本地书库，不上传网络；导入失败不会留下半成品书。
          </p>
        </>
      }
      footer={
        <p className="text-xs leading-6 text-ink-soft/70">
          导入完成后可在书架打开 EPUB；原始文件书保留原文件，等待后续解析。
        </p>
      }
    >
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileUp className="h-4 w-4 text-cinnabar" aria-hidden="true" />
            选择文件
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void chooseFile()} disabled={busy || status !== "ready"}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="h-4 w-4" aria-hidden="true" />
              )}
              {busy ? "正在导入…" : "选择文件"}
            </Button>
            <span className="text-[11px] leading-5 text-ink-soft/75">
              支持 .epub、.jusong（加密解析包）、.mobi、.pdf、.txt；一次一本。
            </span>
          </div>

          {status === "error" ? (
            <p className="mt-3 text-xs leading-6 text-cinnabar">书库初始化失败：{libraryError ?? "未知错误"}</p>
          ) : null}

          {picked ? (
            <div className="mt-4 rounded-md border border-border/80 bg-paper/70 px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-sm border border-cinnabar/30 bg-cinnabar/[0.06] px-1.5 py-0.5 text-[10px] tracking-wider text-cinnabar">
                  {KIND_LABEL[picked.kind]}
                </span>
                <span className="break-all text-xs font-medium text-ink">{picked.name}</span>
              </div>
              <p className="mt-1.5 text-[11px] leading-5 text-ink-soft/80">{KIND_HINT[picked.kind]}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {busy ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 rounded-lg border border-border/80 bg-paper-soft/70 px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-cinnabar" aria-hidden="true" />
            <span className="font-medium text-ink">{stage ? STAGE_LABEL[stage] : "正在处理…"}</span>
            {progressPhase ? (
              <span className="rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] tracking-wider">
                {progressPhase}
              </span>
            ) : null}
            {progressPercent !== null ? <span className="text-[11px]">{progressPercent}%</span> : null}
          </div>
          {progressPercent !== null ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-cinnabar transition-[width] duration-200"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          ) : null}
          {progress?.message ? (
            <p className="mt-1.5 break-all text-[11px] leading-5 text-ink-soft/80">{progress.message}</p>
          ) : null}
        </div>
      ) : null}

      {error ? <ErrorPanel className="mt-4" title="导入失败" message={error} /> : null}

      {result ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 rounded-lg border border-emerald-700/25 bg-emerald-50/70 px-4 py-3 text-emerald-900"
        >
          <p className="flex items-center gap-2 font-serif text-sm font-semibold tracking-wide">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            导入完成：《{result.title}》
          </p>
          <p className="mt-1.5 text-xs leading-6">
            {KIND_LABEL[result.format === "epub" ? "epub" : "original"]}
            {result.author ? ` · ${result.author}` : null}
            {result.parseState === "pending"
              ? " · 已按原始文件入库，章节待解析"
              : ` · ${result.chapterCount} 篇`}
            {typeof result.sourceSize === "number" ? ` · 原文件 ${formatBytes(result.sourceSize)}` : null}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {readableBook ? (
              <Button type="button" size="sm" onClick={() => navigate(`/read/${result.id}`)}>
                去阅读
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" onClick={goShelf}>
              返回书架
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setResult(null);
                setPicked(null);
                setError(null);
                setProgress(null);
                setBuildFlow(null);
                setAgentConfigured(false);
              }}
            >
              继续导入
            </Button>
          </div>
        </div>
      ) : null}
    </PlaceholderPage>
  );

  return page;
}
