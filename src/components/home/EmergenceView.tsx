import { Blocks, PackagePlus, Sparkles, Workflow } from "lucide-react";

import { PlaceholderPage } from "./PlaceholderPanel";
import type { PlaceholderPlanItem } from "./PlaceholderPanel";

const EMERGENCE_PLANS: readonly PlaceholderPlanItem[] = [
  {
    icon: Sparkles,
    title: "用 AGENT 生成功能",
    description: "用对话描述想要的能力，由 AGENT 生成可直接安装的功能入口。",
  },
  {
    icon: PackagePlus,
    title: "安装与管理",
    description: "已安装的涌现功能以卡片陈列在此，可启用、停用或移除，全部留在本地书斋。",
  },
  {
    icon: Workflow,
    title: "与阅读、知识库联动",
    description: "涌现功能可以读取当前书籍与知识库，把新的用法接进阅读流程。",
  },
  {
    icon: Blocks,
    title: "按需生长",
    description: "不预装、不堆功能，只保留你真正安装并常用的那一部分。",
  },
];

export interface EmergenceViewProps {
  className?: string;
}

/**
 * 首页左入口「涌现」：无右子项，中间栏显示空态占位。
 *
 * 定位：存放后续用户通过 AGENT 自行开发 / 安装的功能入口；当前尚未接入生成与安装能力，
 * 因此文案写成「留白 / 规划中」，而不是错误或缺失。
 */
export function EmergenceView({ className }: EmergenceViewProps) {
  return (
    <PlaceholderPage
      className={className}
      eyebrow="涌现 · EMERGENCE"
      title="涌现"
      planLabel="未来预计更新"
      description={
        <>
          <p>
            「涌现」留给书斋自己生长：后续你可以通过 AGENT 生成、安装或组合功能，让它们出现在这里。
          </p>
          <p>
            现在这里还是一个空的陈列架——暂时没有已安装的涌现功能。等 AGENT
            的生成与安装能力接入后，你创造的功能入口会按卡片形式出现在这一页。
          </p>
        </>
      }
      items={EMERGENCE_PLANS}
      note={
        <>
          本批仅提供「涌现」入口与占位说明，AGENT
          功能的生成与安装能力列入未来预计更新。当前为空态，不影响现有阅读与知识库。
        </>
      }
      footer={
        <p className="text-xs leading-6 text-ink-soft/70">一个安静的书斋，也需要留出生长的位置。</p>
      }
    />
  );
}
