import { BookOpenCheck, Compass, MessageSquareText, SlidersHorizontal } from "lucide-react";

import { PlaceholderPage } from "./PlaceholderPanel";
import type { PlaceholderPlanItem } from "./PlaceholderPanel";

const GUIDE_PLANS: readonly PlaceholderPlanItem[] = [
  {
    icon: Compass,
    title: "入口导览",
    description: "看懂左「入口」与右「导览」的层级关系，一眼找到书架、知识库、检索与设置。",
  },
  {
    icon: BookOpenCheck,
    title: "阅读与知识库说明",
    description: "翻页、章节摘要、人工档案与检索的用法，按「第一次使用」的顺序讲清楚。",
  },
  {
    icon: MessageSquareText,
    title: "AGENT 使用指南",
    description: "从配置模型到划词引用、再到把回答保存进知识库，给出完整的上手路径。",
  },
  {
    icon: SlidersHorizontal,
    title: "设置说明",
    description: "行为、外观、AGENT 与阅读器面板等设置项的含义、推荐值与重置方式。",
  },
];

export interface GuideViewProps {
  className?: string;
}

/**
 * 首页左入口「指引」：无右子项，中间栏显示空态占位。
 *
 * 定位：功能指引 / 使用帮助的规划位置（入口导览、阅读与知识库说明、AGENT 指南等），
 * 当前尚未编写正文，因此按「规划中」呈现。
 */
export function GuideView({ className }: GuideViewProps) {
  return (
    <PlaceholderPage
      className={className}
      eyebrow="指引 · GUIDE"
      title="指引"
      planLabel="规划中"
      description={
        <>
          <p>这里将收纳沮诵的使用说明：从第一次打开，到阅读、整理知识库与使用 AGENT。</p>
          <p>
            目前指引内容还在规划中。后续会按「入口怎么走、功能怎么用、设置怎么调」的结构逐步补齐，
            让不熟悉界面的人也能安静地开始读第一本书。
          </p>
        </>
      }
      items={GUIDE_PLANS}
      note={
        <>
          本批仅提供「指引」入口与占位说明，实际指引正文列入未来预计更新。在那之前，各个功能页面内的说明文字仍可随时查看。
        </>
      }
      footer={
        <p className="text-xs leading-6 text-ink-soft/70">
          先让界面自己说明，再把说明写成可以回看的文字。
        </p>
      }
    />
  );
}
