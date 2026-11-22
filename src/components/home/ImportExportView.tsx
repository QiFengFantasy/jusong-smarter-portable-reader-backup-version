import type { ReactNode } from "react";
import {
  Archive,
  BookOpen,
  BookMarked,
  CheckCircle2,
  Download,
  FileJson,
  FileSpreadsheet,
  FileUp,
  FolderInput,
  Layers,
  ListChecks,
  RefreshCcw,
  Settings2,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";

import { PlaceholderPage } from "./PlaceholderPanel";
import type { PlaceholderPlanItem } from "./PlaceholderPanel";
import { ExportBookView } from "./ExportBookView";
import { ImportBooksView } from "./ImportBooksView";

export type ImportExportKind = "import" | "export";
export type ImportExportSection = "books" | "knowledge" | "config";

export interface ImportExportViewProps {
  kind: ImportExportKind;
  section: ImportExportSection;
  className?: string;
}

const KIND_LABEL: Record<ImportExportKind, string> = {
  import: "导入",
  export: "导出",
};

const SECTION_LABEL: Record<ImportExportSection, string> = {
  books: "书籍",
  knowledge: "知识库",
  config: "配置",
};

const SECTION_EN: Record<ImportExportSection, string> = {
  books: "BOOKS",
  knowledge: "KNOWLEDGE",
  config: "CONFIG",
};

const DESCRIPTION: Record<ImportExportKind, Record<ImportExportSection, ReactNode>> = {
  import: {
    books:
      "把 EPUB 文件接入本地书斋：解析卷、章与目录，生成章节摘要，并提取内嵌封面。阅读、知识库与检索都建立在同一份本地书库上。",
    knowledge:
      "从备份中接回档案、摘要与笔记，让重装应用或换设备之后的知识库继续可用。",
    config:
      "导入一份设置快照，快速恢复界面、检索与 AGENT 的配置；密钥等敏感信息不在快照里，需要在当前设备重新填写。",
  },
  export: {
    books: "把本地书籍整理成可迁移的备份：保留原文件与卷 / 章结构，换一台设备也能接着读。",
    knowledge: "把人工档案、自动摘要与笔记导出成可归档、可迁移的知识库备份。",
    config:
      "导出一份设置快照，便于在新设备恢复或与自己的配置做对照；不会包含密钥明文。",
  },
};

const PLANS: Record<ImportExportKind, Record<ImportExportSection, readonly PlaceholderPlanItem[]>> = {
  import: {
    books: [
      {
        icon: FileUp,
        title: "选择 EPUB 导入",
        description: "在文件选择器中选择一本或多本 EPUB，导入后出现在书架。",
      },
      {
        icon: Layers,
        title: "解析与摘要",
        description: "自动建立卷 / 章 / 目录索引，并生成各章结构摘要。",
      },
      {
        icon: BookOpen,
        title: "封面提取",
        description: "提取内嵌封面并缩放到合适尺寸，书架卡片显示真实封面。",
      },
      {
        icon: RefreshCcw,
        title: "失败与重试",
        description: "导入失败时给出原因，可重新选择文件，不留下半成品书。",
      },
    ],
    knowledge: [
      {
        icon: FolderInput,
        title: "备份识别与预览",
        description: "选择知识库备份后，先预览可导入的书籍、档案与摘要数量。",
      },
      {
        icon: Layers,
        title: "合并策略",
        description: "保留现有条目或覆盖同一条目，冲突逐条提示。",
      },
      {
        icon: BookMarked,
        title: "按书导入",
        description: "可以只接回某一本书的知识库，不必整库恢复。",
      },
      {
        icon: ListChecks,
        title: "导入报告",
        description: "结束后汇总新增、跳过与失败的条目数量。",
      },
    ],
    config: [
      {
        icon: Settings2,
        title: "设置快照",
        description: "导入界面、检索、外观与阅读器面板等设置。",
      },
      {
        icon: ShieldCheck,
        title: "AGENT 配置",
        description: "恢复接口地址与模型；密钥不随配置导出，需要重新填写。",
      },
      {
        icon: CheckCircle2,
        title: "版本校验",
        description: "导入前校验配置格式与版本，避免不兼容的快照写坏当前设置。",
      },
      {
        icon: ListChecks,
        title: "导入前预览",
        description: "先看清会改动哪些设置项，再决定是否应用。",
      },
    ],
  },
  export: {
    books: [
      {
        icon: Archive,
        title: "按书导出",
        description: "选择一本或多本书导出为备份包。",
      },
      {
        icon: Layers,
        title: "完整备份",
        description: "可选是否包含原文件、阅读进度与章节摘要。",
      },
      {
        icon: UploadCloud,
        title: "迁移恢复",
        description: "在新设备导入备份后恢复书架与阅读位置。",
      },
      {
        icon: ShieldCheck,
        title: "体积与校验",
        description: "显示导出体积与校验信息，避免损坏的备份。",
      },
    ],
    knowledge: [
      {
        icon: BookMarked,
        title: "范围选择",
        description: "按书或整库导出人工档案与自动摘要。",
      },
      {
        icon: FileSpreadsheet,
        title: "可读格式",
        description: "可选 Markdown / JSON，便于归档、检索与分享。",
      },
      {
        icon: ListChecks,
        title: "来源信息",
        description: "保留所属章节、条目类型与创建时间。",
      },
      {
        icon: Download,
        title: "导出报告",
        description: "列出导出条数与文件位置。",
      },
    ],
    config: [
      {
        icon: Settings2,
        title: "设置快照",
        description: "导出界面、检索、外观与阅读器面板等设置。",
      },
      {
        icon: ShieldCheck,
        title: "AGENT 配置",
        description: "可选是否包含接口地址与模型；密钥不会以明文导出。",
      },
      {
        icon: FileJson,
        title: "可读 JSON",
        description: "导出的配置可直接查看与手动修改。",
      },
      {
        icon: UploadCloud,
        title: "跨设备迁移",
        description: "在新设备导入后快速恢复自己的使用习惯。",
      },
    ],
  },
};

const NOTE: Record<ImportExportKind, ReactNode> = {
  import: (
    <>
      本批「导入知识库 / 导入配置」仍为入口与占位，实际业务列入未来预计更新。为避免误导，这里不放置可点击的假按钮；现有书库、阅读进度与知识库数据都不受影响。
    </>
  ),
  export: (
    <>
      本批「导出知识库 / 导出配置」仍为入口与占位，实际业务列入未来预计更新。为避免误导，这里不放置可点击的假按钮；现有书库、阅读进度与知识库数据都不受影响。
    </>
  ),
};

/**
 * 首页「导入 / 导出」入口的 6 个子项页面：导入书籍 / 导入知识库 / 导入配置、导出书籍 / 导出知识库 / 导出配置。
 *
 * - 书籍子项已接真实业务：导入走 `ImportBooksView`（选择文件 → 分流导入 → 进度 → AGENT 入口），
 *   导出走 `ExportBookView`（无 bookId 时是 Hero 指引，有 bookId 时是统计与导出操作）。
 * - 知识库 / 配置子项本批仍是占位：只说明规划，不渲染可点击的假按钮。
 */
export function ImportExportView({ kind, section, className }: ImportExportViewProps) {
  const kindLabel = KIND_LABEL[kind];
  const sectionLabel = SECTION_LABEL[section];

  if (section === "books") {
    return kind === "import" ? (
      <ImportBooksView className={className} />
    ) : (
      <ExportBookView className={className} />
    );
  }

  return (
    <PlaceholderPage
      className={className}
      eyebrow={`${kindLabel} · ${SECTION_EN[section]}`}
      title={`${kindLabel}${sectionLabel}`}
      planLabel="本批为入口与占位"
      description={
        <>
          <p>{DESCRIPTION[kind][section]}</p>
          <p className="text-xs leading-6 text-ink-soft/75 sm:text-sm">
            当前页面只描述规划，不执行任何真实读写；导入 / 导出的具体范围与交互会在后续版本接入。
          </p>
        </>
      }
      items={PLANS[kind][section]}
      note={NOTE[kind]}
      footer={
        <p className="text-xs leading-6 text-ink-soft/70">
          数据留在自己的设备上；无论导入还是导出，都以不破坏现有书库为前提。
        </p>
      }
    />
  );
}
