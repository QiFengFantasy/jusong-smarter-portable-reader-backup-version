/**
 * 导入第二流程「AGENT 知识构建」的公共入口。
 *
 * 契约：公共类型见 types.ts，编排见 orchestrator.ts。
 * UI 只需要：
 * - `estimateImportBuild` 在选择页展示调用/token/用时范围；
 * - `runImportBuild` 在构建页执行真实 AGENT 团队调用并落库；
 * - `BuildItemId` / `BUILD_ITEMS` / `BuildMessage` 等类型。
 */

export {
  BUILD_ITEMS,
  buildItemTitle,
  isBuildItemId,
  type BuildAgentRole,
  type BuildEstimate,
  type BuildFailedBatch,
  type BuildItemId,
  type BuildItemMeta,
  type BuildMessage,
  type BuildMessageTone,
  type BuildProgress,
  type BuildResult,
  type RunImportBuildOptions,
} from "./types";

export { BATCH_SIZE, estimateImportBuild } from "./estimate";

export { runImportBuild } from "./orchestrator";
