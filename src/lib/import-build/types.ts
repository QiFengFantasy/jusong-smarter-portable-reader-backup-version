import type { BookMeta, Library } from "@jusong/core";

/**
 * 导入第二流程「AGENT 构建」的公共类型。
 *
 * 这里只放 UI 与编排层共享的数据结构；模型返回的 JSON 形状在 prompts.ts 中约束、
 * 由 orchestrator.ts 做容错解析与归一化，不进入公共 API。
 */

/** 可选构建条目：摘要 / 档案 / 地图地点 / 时间线。 */
export type BuildItemId = "digest" | "archive" | "place" | "timeline";

/** 构建阶段角色；Lead 负责计划与终审，研究员分析、撰写产出、审查校验。 */
export type BuildAgentRole = "lead" | "researcher" | "writer" | "reviewer";

/** 状态消息语气：普通 / 成功 / 错误 / 审查意见。 */
export type BuildMessageTone = "normal" | "success" | "error" | "review";

/**
 * 构建页角色对话的一条消息。
 * `text` 只能是简短的进度状态（不输出模型原文），完整模型输出不进入 UI。
 */
export interface BuildMessage {
  id: string;
  role: BuildAgentRole;
  text: string;
  tone?: BuildMessageTone;
}

/** 选择页实时估算（不显示金额）。 */
export interface BuildEstimate {
  chapterCount: number;
  batchCount: number;
  callsMin: number;
  callsMax: number;
  tokensMin: number;
  tokensMax: number;
  minutesMin: number;
  minutesMax: number;
}

/** 每批结束后的进度快照。 */
export interface BuildProgress {
  /** 已完成批数（0 表示尚未完成任何批）。 */
  batchIndex: number;
  batchCount: number;
  savedDigests: number;
  savedArchives: number;
  savedPlaces: number;
  savedEvents: number;
}

/** 首次失败（或取消）的批次；`index` 从 0 开始。 */
export interface BuildFailedBatch {
  index: number;
  reason: string;
}

/** 构建结果：`completed=false` 时保留已写入的计数，并给出失败批次。 */
export interface BuildResult {
  completed: boolean;
  savedDigests: number;
  savedArchives: number;
  savedPlaces: number;
  savedEvents: number;
  failedBatch?: BuildFailedBatch;
}

/** `runImportBuild` 的入参。 */
export interface RunImportBuildOptions {
  library: Library;
  book: BookMeta;
  selected: BuildItemId[];
  onMessage: (message: BuildMessage) => void;
  onProgress: (progress: BuildProgress) => void;
  signal?: AbortSignal;
}

/** 构建条目元数据（选择页卡片文案）。 */
export interface BuildItemMeta {
  id: BuildItemId;
  title: string;
  description: string;
}

/** 选择页展示顺序：摘要 → 档案 → 地图地点 → 时间线。 */
export const BUILD_ITEMS: BuildItemMeta[] = [
  {
    id: "digest",
    title: "章节摘要",
    description: "按批生成每章摘要，写入阅读器摘要面板。",
  },
  {
    id: "archive",
    title: "章节档案",
    description: "整理每章档案，作为 AGENT 笔记存入知识库。",
  },
  {
    id: "place",
    title: "地图地点",
    description: "提取书中地点与坐标，写入地图与章节探索数据。",
  },
  {
    id: "timeline",
    title: "时间线",
    description: "提取与本章相关的事件，写入时间线与章节探索数据。",
  },
];

const BUILD_ITEM_IDS: BuildItemId[] = BUILD_ITEMS.map((item) => item.id);

/** 判断任意值是否为合法构建条目 id（用于外部输入归一化）。 */
export function isBuildItemId(value: unknown): value is BuildItemId {
  return typeof value === "string" && (BUILD_ITEM_IDS as string[]).includes(value);
}

/** 条目展示名（日志/消息用）。 */
export function buildItemTitle(id: BuildItemId): string {
  return BUILD_ITEMS.find((item) => item.id === id)?.title ?? id;
}
