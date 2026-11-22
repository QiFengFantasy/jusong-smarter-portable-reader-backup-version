import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  Compass,
  MoreHorizontal,
  Moon,
  Smartphone,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { BrandMark } from "../brand/BrandMark";
import { HeroArt } from "../brand/HeroArt";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { useAppVersion } from "../../lib/version";
import { cn } from "../../lib/utils";

/** 关于子页统一外壳：整页占满中间栏、内部滚动、正文居中限宽。 */
function AboutPageShell({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  /** 滚动区域的可见名称（键盘可聚焦滚动区，便于读屏定位）。 */
  label: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div
        role="region"
        aria-label={`${label} · 页面内容`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cinnabar/30 sm:px-8 sm:py-8"
      >
        <div className="mx-auto w-full max-w-3xl space-y-5">{children}</div>
      </div>
    </div>
  );
}

/** 页面标题区（非卡片）：栏目名 + 主标题 + 说明 + 可选版本标签。 */
function AboutPageHeader({
  eyebrow,
  title,
  description,
  meta,
}: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="relative overflow-hidden rounded-xl border border-border bg-paper-soft/50 px-5 py-5 sm:px-7 sm:py-6">
      <HeroArt variant="compact" />
      <div className="relative">
        <p className="text-[11px] uppercase tracking-[0.42em] text-cinnabar">{eyebrow}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="font-serif text-2xl font-semibold tracking-wide text-ink sm:text-3xl">
            {title}
          </h1>
          {meta}
        </div>
        <div className="mt-2 max-w-2xl space-y-2 text-sm leading-7 text-ink-soft">{description}</div>
      </div>
    </header>
  );
}

export interface AboutDetailViewProps {
  className?: string;
}

const DETAIL_ROWS: readonly { label: string; value: string }[] = [
  {
    label: "存储",
    value: "Tauri 2 + Rust Content API；用户库保存在 appData（开发态 data/library）。",
  },
  { label: "阅读", value: "离线优先，不依赖网络服务；书籍、笔记与检索记录都留在本机。" },
  { label: "多端", value: "Windows 桌面（M1）+ Android（M2）；iOS 待 macOS / CI 支持。" },
  { label: "定位", value: "先把读与记做扎实，再慢慢长成自己的书斋。" },
];

/**
 * 关于 · 详细：复用原「关于软件」的 Hero 视觉与版本信息，展示产品名、本地优先说明与多端形态。
 * 版本号来自 `useAppVersion()`（src/lib/version.ts，底层为 Tauri `getVersion()`）。
 */
export function AboutDetailView({ className }: AboutDetailViewProps) {
  const version = useAppVersion();

  return (
    <div className={cn("h-full min-h-0", className)}>
      <AboutPageShell label="关于沮诵">
        <section className="relative overflow-hidden rounded-xl border border-border bg-paper-soft/60 px-5 py-7 shadow-paper sm:px-8 sm:py-9">
          <HeroArt variant="large" />

          <div className="relative">
            <div className="mb-5" aria-hidden="true">
              <BrandMark size="lg" showWordmark={false} />
            </div>
            <p className="text-[11px] uppercase tracking-[0.42em] text-cinnabar">JUSONG · 本地书斋</p>
            <h1 className="mt-3 font-serif text-4xl font-semibold tracking-[0.12em] text-ink sm:text-5xl">
              沮诵
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-ink-soft sm:text-base sm:leading-8">
              纸上存书，字里藏识。所有书籍、笔记与检索记录都保存在你的设备上，离线也能安静地读完一章。
            </p>
            <p className="mt-4 text-xs leading-6 text-ink-soft/70">
              一款本地优先的电子书阅读与知识库工具：先把读与记做扎实，再慢慢长成自己的书斋。
            </p>
            <p className="mt-4 flex items-center gap-1.5 text-[11px] text-ink-soft/60">
              <span className="h-1.5 w-1.5 rounded-full bg-cinnabar/70" aria-hidden="true" />
              本地存储 · 离线可读
            </p>
          </div>
        </section>

        <Card>
          <CardHeader>
            <CardTitle>关于沮诵</CardTitle>
            <CardDescription>版本、存储与使用形态。</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border/70 text-sm">
              <div className="flex flex-col gap-1 py-3 first:pt-0 sm:flex-row sm:items-baseline sm:gap-6">
                <dt className="shrink-0 text-xs tracking-widest text-ink-soft/70 sm:w-16">版本</dt>
                <dd className="min-w-0 break-words leading-6 text-ink">
                  {version} · Tauri 2
                  <span className="ml-2 text-xs text-ink-soft/60">（三段 semver，第三段为出包次数）</span>
                </dd>
              </div>
              {DETAIL_ROWS.map((row) => (
                <div
                  key={row.label}
                  className="flex flex-col gap-1 py-3 last:pb-0 sm:flex-row sm:items-baseline sm:gap-6"
                >
                  <dt className="shrink-0 text-xs tracking-widest text-ink-soft/70 sm:w-16">
                    {row.label}
                  </dt>
                  <dd className="min-w-0 break-words leading-6 text-ink">{row.value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <footer className="flex flex-col items-center gap-3 pb-2 pt-1 text-center">
          <BrandMark size="sm" showSubtitle />
          <p className="text-[11px] leading-5 text-ink-soft/60">书与笔记，留在自己的设备上。</p>
        </footer>
      </AboutPageShell>
    </div>
  );
}

interface ChangelogEntry {
  title: string;
  description: string;
}

const BATCH_TWO_ENTRIES: readonly ChangelogEntry[] = [
  {
    title: "首页层级重构",
    description:
      "左「入口」、右「导览」两级导航：首页 / 涌现 / 导入 / 导出 / 指引 / 关于 / 设置；三栏顶格布局，检索与 AGENT 常驻导览。",
  },
  {
    title: "阅读器知识与探索面板",
    description:
      "左「知识」右「探索」，面板顶部标签可横向滑动；窄屏支持抽屉 / 对话框 / 内联三种呈现，平板自动展开探索面板。",
  },
  {
    title: "强调色与封面占位色",
    description:
      "设置-外观可切换强调色，纸墨与 Hero 装饰同步换色；没有真实封面的书按封面占位色生成纸面渐变。",
  },
  {
    title: "检索与界面记忆",
    description:
      "高级检索分类标签、最近阅读优先与「查找更多」；知识库独立检索；记住上次入口、子项、滚动位置与导航方式。",
  },
  {
    title: "AGENT",
    description:
      "轻量对话 harness（流式输出、取消、会话保存）；阅读器右栏 AGENT、划词引用，以及把回答保存进知识库。",
  },
  {
    title: "导入与封面",
    description:
      "EPUB 内嵌封面提取、缩放与显示；大 EPUB 导入的逐项移动回退，失败后可重试，不留下半成品书。",
  },
  {
    title: "关于与占位页",
    description:
      "关于拆为「详细 / 本次打包更新 / 未来预计更新」；新增「涌现 / 导入 / 导出 / 指引」入口与统一的规划占位页。",
  },
  {
    title: "移动端与细节",
    description:
      "修复阅读器宽度溢出（长章节不再把正文撑出屏幕）；面板拖拽始终保证正文最小宽度；手机竖屏抽屉与平板断点调整。",
  },
];

const BATCH_ONE_ENTRIES: readonly ChangelogEntry[] = [
  {
    title: "首页三栏工作区",
    description:
      "左「书斋」、中内容、右「导航」；左右栏可拖拽并记忆宽度，窄屏收起为抽屉，竖屏 / 横屏使用不同断点。",
  },
  {
    title: "全局检索",
    description: "按需扫描本地书库、显示扫描进度、可取消，结果点击直达对应章节。",
  },
  {
    title: "阅读器顶栏与最小宽度",
    description:
      "空间不足时按钮自动折叠为菜单，标题保持居中；阅读器中间内容最小宽度 460，避免正文被挤到重叠。",
  },
  {
    title: "品牌与视觉",
    description: "新应用图标、Hero 抽象图形水印与「书斋」印章；纸墨 / 朱红视觉体系。",
  },
  {
    title: "移动端基础",
    description: "Android edge-to-edge 下的状态栏、刘海与手势条安全区适配。",
  },
  {
    title: "桌面与 Android 交付",
    description: "v0.1.1 Windows 安装包与 Android APK 可用。",
  },
];

function UpdateItem({ entry }: { entry: ChangelogEntry }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full bg-cinnabar/70" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-serif text-sm font-semibold tracking-wide text-ink">{entry.title}</p>
        <p className="mt-0.5 text-xs leading-6 text-ink-soft">{entry.description}</p>
      </div>
    </li>
  );
}

export interface AboutChangelogViewProps {
  className?: string;
}

/**
 * 关于 · 本次打包更新：静态清单，分「第二批（本次）」与「第一批」两组。
 */
export function AboutChangelogView({ className }: AboutChangelogViewProps) {
  const version = useAppVersion();

  return (
    <div className={cn("h-full min-h-0", className)}>
      <AboutPageShell label="本次打包更新">
        <AboutPageHeader
          eyebrow="关于 · 更新记录"
          title="本次打包更新"
          meta={
            <span className="rounded-full border border-cinnabar/25 bg-cinnabar/[0.06] px-2.5 py-0.5 text-[11px] leading-5 text-cinnabar">
              当前版本 {version}
            </span>
          }
          description={
            <p>
              本版把两批改动合并出包：第一批完成首页工作区基础，第二批完成首页层级、阅读器面板、强调色、AGENT
              与界面记忆等体验重构。以下为静态整理的功能摘要，实际行为以应用内界面为准。
            </p>
          }
        />

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>第二批（本次）</CardTitle>
              <span className="rounded-sm border border-cinnabar/30 bg-cinnabar/10 px-1.5 py-0.5 text-[10px] tracking-wider text-cinnabar">
                本次
              </span>
            </div>
            <CardDescription>首页层级、阅读器面板、强调色、检索与记忆、AGENT 与占位页。</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3.5">
              {BATCH_TWO_ENTRIES.map((entry) => (
                <UpdateItem key={entry.title} entry={entry} />
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>第一批</CardTitle>
            <CardDescription>首页三栏工作区、全局检索、阅读器顶栏与品牌视觉的基础。</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3.5">
              {BATCH_ONE_ENTRIES.map((entry) => (
                <UpdateItem key={entry.title} entry={entry} />
              ))}
            </ul>
          </CardContent>
        </Card>

        <p className="rounded-md border border-dashed border-border/80 bg-paper/50 px-3.5 py-3 text-xs leading-6 text-ink-soft/75">
          更新记录为手工整理，可能与最终发布说明在措辞上略有差异；功能以实际版本行为为准。
        </p>
      </AboutPageShell>
    </div>
  );
}

interface RoadmapEntry {
  icon: LucideIcon;
  title: string;
  description: string;
}

const ROADMAP_ENTRIES: readonly RoadmapEntry[] = [
  {
    icon: ArrowLeftRight,
    title: "真实导入 / 导出业务",
    description:
      "书籍、知识库与配置的备份、迁移与恢复；「导入 / 导出」入口从占位变成可用的业务页面。",
  },
  {
    icon: Moon,
    title: "深色模式",
    description: "纸墨夜读配色，覆盖首页、阅读器与设置；与强调色体系一起设计，而不是简单反色。",
  },
  {
    icon: Smartphone,
    title: "Android AGENT 联网",
    description: "移动端接入模型网络能力，让对话、划词引用与保存知识库在 Android 上同样可用。",
  },
  {
    icon: Sparkles,
    title: "更多 AGENT 涌现功能",
    description: "用 AGENT 生成、安装功能入口，「涌现」页从空态逐步长成你的功能陈列架。",
  },
  {
    icon: Compass,
    title: "功能指引与使用帮助",
    description: "入口导览、阅读与知识库说明、AGENT 使用指南；从界面内提示扩展到可回看的指引页。",
  },
  {
    icon: MoreHorizontal,
    title: "其他待定",
    description: "更多数据来源、iOS 支持等方向，随版本节奏与使用反馈评估，不逐个承诺时间。",
  },
];

export interface AboutRoadmapViewProps {
  className?: string;
}

/**
 * 关于 · 未来预计更新：静态清单（真实导入导出、深色模式、Android AGENT 联网、涌现功能等）。
 * 文案强调「计划中」，避免让用户误以为已有对应功能。
 */
export function AboutRoadmapView({ className }: AboutRoadmapViewProps) {
  return (
    <div className={cn("h-full min-h-0", className)}>
      <AboutPageShell label="未来预计更新">
        <AboutPageHeader
          eyebrow="关于 · 未来预计更新"
          title="未来预计更新"
          meta={
            <span className="inline-flex items-center gap-1.5 rounded-full border border-cinnabar/25 bg-cinnabar/[0.06] px-2.5 py-0.5 text-[11px] leading-5 text-cinnabar">
              <span className="h-1.5 w-1.5 rounded-full bg-cinnabar/70" aria-hidden="true" />
              计划中
            </span>
          }
          description={
            <p>
              以下方向已在计划里，会分批接入；顺序与范围可能随使用反馈调整，这里列出的是预期，而不是承诺的时间表。
            </p>
          }
        />

        <Card>
          <CardHeader>
            <CardTitle>计划中的能力</CardTitle>
            <CardDescription>按「更贴近日常使用」到「更长远」的顺序排列。</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-4">
              {ROADMAP_ENTRIES.map((entry) => {
                const Icon = entry.icon;
                return (
                  <li key={entry.title} className="flex items-start gap-3">
                    <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-muted/40 text-cinnabar">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="font-serif text-sm font-semibold tracking-wide text-ink">
                        {entry.title}
                      </p>
                      <p className="mt-0.5 text-xs leading-6 text-ink-soft">{entry.description}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <p className="rounded-md border border-dashed border-border/80 bg-paper/50 px-3.5 py-3 text-xs leading-6 text-ink-soft/75">
          计划内容以每次发布的更新说明为准；未列出的想法也可能在后续版本中出现。
        </p>
      </AboutPageShell>
    </div>
  );
}
