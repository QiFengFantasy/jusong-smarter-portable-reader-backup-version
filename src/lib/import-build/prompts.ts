import type { Chapter } from "@jusong/core";

/**
 * 导入第二流程「AGENT 团队」的提示词（契约 §3.1）。
 *
 * 说明：
 * - Rust 的 `agent_chat` 会自行在消息前注入本应用的 system prompt，因此这里**不再**传
 *   `role:"system"` 消息；角色指令放在唯一一条 user 文本开头，避免两个 system 冲突。
 * - 所有角色都要求「严格 JSON、不要 markdown 代码围栏、不要解释文字」；
 *   orchestrator.ts 的解析器仍会额外去掉围栏与前后说明，做容错。
 * - 批次章节正文每章截取约 4000 字符（保留开头 + 小标题 + 结尾），由 `chapterExcerpt` 完成。
 */

/** 每章正文进入提示词的字符上限。 */
export const CHAPTER_EXCERPT_CHARS = 4000;

/** 少于该长度时整章直接送入，不做首尾截取。 */
const SHORT_CHAPTER_CHARS = 120;

function clipText(text: string, max: number): string {
  const normalized = text.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** 从开头累计整段，最后一段超长时截断并标记。 */
function takeHead(parts: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const part of parts) {
    if (used >= budget) break;
    const remaining = budget - used;
    if (part.length <= remaining) {
      out.push(part);
      used += part.length + 1;
    } else {
      out.push(`${part.slice(0, Math.max(1, remaining)).trimEnd()}…`);
      used = budget;
      break;
    }
  }
  return out;
}

/** 从结尾累计整段（保持原顺序），最后一段超长时截断并标记。 */
function takeTail(parts: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (used >= budget) break;
    const part = parts[index];
    const remaining = budget - used;
    if (part.length <= remaining) {
      out.unshift(part);
      used += part.length + 1;
    } else {
      out.unshift(`…${part.slice(part.length - Math.max(1, remaining)).trimStart()}`);
      used = budget;
      break;
    }
  }
  return out;
}

/**
 * 章节正文摘录：完整章节较短时原样返回；过长时保留开头 ~45%、结尾 ~45%，
 * 中间放小标题清单（约 10%），帮助模型把握结构而不必读全文。
 * 标题块以「【标题】」形式保留在正文中。
 */
export function chapterExcerpt(
  chapter: Chapter,
  maxChars: number = CHAPTER_EXCERPT_CHARS,
): string {
  const budget = Math.max(SHORT_CHAPTER_CHARS, Math.floor(maxChars));
  const parts: string[] = [];
  const headings: string[] = [];

  for (const block of chapter.blocks ?? []) {
    const text = (block.text ?? "").trim();
    if (!text) continue;
    if (block.kind === "heading") {
      headings.push(text);
      parts.push(`【${text}】`);
      continue;
    }
    parts.push(text);
  }

  if (parts.length === 0) return "";
  const fullText = parts.join("\n");
  if (fullText.length <= budget) return fullText;

  const headBudget = Math.floor(budget * 0.45);
  const tailBudget = Math.floor(budget * 0.45);
  const middleBudget = Math.max(0, budget - headBudget - tailBudget);

  const middle = headings.length > 0 ? `小标题：${headings.join(" / ")}` : "";
  const middleText = clipText(middle, middleBudget);

  const composed = [
    ...takeHead(parts, headBudget),
    "……",
    middleText,
    "……",
    ...takeTail(parts, tailBudget),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return composed.length > budget ? `${composed.slice(0, budget - 1)}…` : composed;
}

// ---------------------------------------------------------------------------
// 角色提示词
// ---------------------------------------------------------------------------

/** 团队每次被调用都共享的硬性输出要求。 */
const STRICT_JSON_RULE =
  "硬性要求：只输出一个 JSON 对象；不要 markdown 代码围栏（如 ```json）；不要输出任何解释、前言或后记；" +
  "无法确定的内容用空字符串/空数组表示，不要编造。";

/** Lead：分批计划 + 最终终审（同一角色，按输入 mode 输出不同 JSON）。 */
export const LEAD_PROMPT = `你是「导入知识构建」团队的 Lead（统筹者）。团队有研究员（分析章节）、撰写（产出内容）、审查（校验质量）三个角色，你只负责计划与终审，不直接写内容。
根据输入 mode 输出其中一种 JSON：
1) mode="plan"：为整本书制定分批构建计划：
{"strategy":"一句话总体策略","batchFocus":["第 1 批关注点","第 2 批关注点"],"warnings":["全局注意事项"]}
2) mode="final"：对已完成的分批结果做终审：
{"pass":true,"issues":["需要说明的问题"]}
要求：batchFocus 按批次顺序给出，数量与输入 batchCount 一致；终审 pass 为 false 时 issues 必须给出具体、可执行的问题（最多 5 条），pass 为 true 时 issues 为空数组；只依据输入信息判断，不编造。
${STRICT_JSON_RULE}`;

/** 研究员：阅读批次章节片段，输出可供撰写使用的结构化笔记。 */
export const RESEARCHER_PROMPT = `你是「研究员」。阅读输入给出的章节片段，提取可用于构建知识库的素材，供撰写角色使用。
输出 JSON 格式：
{"chapters":[{"chapterId":"章节 id","gist":"本章主旨，2-3 句","keyPoints":["要点 1","要点 2"],"people":["人物"],"places":[{"name":"地名","note":"文中线索"}],"events":[{"date":"YYYY-MM-DD 或空字符串","title":"事件标题","summary":"一句话"}],"quotes":["可复核的原文短句"]}],"batchThemes":["主题"],"warnings":["不确定或缺失的信息"]}
要求：
- chapters 覆盖输入的每一章，chapterId 原样返回；
- 只依据片段内容，不要引入片段之外的知识；日期、地名不确定时留空并写入 warnings；
- 每章 keyPoints 不超过 6 条，quotes 只摘录原文短句。
${STRICT_JSON_RULE}`;

/** 撰写输出 JSON 的结构说明（与 orchestrator 解析器保持一致）。 */
export const WRITER_OUTPUT_SCHEMA = `{
  "digests": [{"chapterId":"章节 id","summary":"120-200 字摘要","keyPoints":[{"section":"overview|background|argument|significance","title":"可选小标题","text":"要点"}],"themes":["主题"],"writing":{"date":"YYYY-MM-DD 或空字符串","placeName":"写成地点或空字符串"}}],
  "archives": [{"chapterId":"章节 id","title":"档案标题","body":"200-400 字档案正文"}],
  "places": [{"id":"小写英文/拼音短 id（不含 place- 前缀，如 yanan）","name":"地名","lon":116.4,"lat":39.9,"description":"一句话说明","chapterIds":["章节 id"]}],
  "events": [{"id":"ev-YYYYMMDD-简短名","date":"YYYY-MM-DD","title":"事件标题","summary":"一句话","chapterIds":["章节 id"],"placeIds":["地点 id"],"importance":3}]
}`;

/** 撰写：把研究员笔记整理成最终要落库的 JSON。 */
export const WRITER_PROMPT = `你是「撰写」。根据研究员笔记与输入信息，产出本批要写入知识库的最终内容。
只输出一个 JSON 对象，结构如下：
${WRITER_OUTPUT_SCHEMA}
要求：
- 只输出输入 requiredItems 要求的字段（requiredItems 取值 digest/archive/place/timeline 依次对应输出字段 digests/archives/places/events）；未要求的字段给空数组 []；
- digests 必须覆盖输入 chapters 的每一章，chapterId 原样返回；
- archives 每章最多 1 条，body 只写章节片段能支撑的内容；
- places 的 lon/lat 必须是真实经纬度（经度 -180~180、纬度 -90~90），不确定就不要输出该地点；chapterIds 只填本书输入过的章节 id；
- events 的日期尽量精确到 YYYY-MM-DD，不确定就不要输出该事件；importance 为 1-5 的整数；
- 只依据输入中的章节片段与研究员笔记，不要编造人名、地名、日期。
${STRICT_JSON_RULE}`;

/** 审查：只判定本轮撰写结果是否可落库，不重写内容。 */
export const REVIEWER_PROMPT = `你是「审查」。核对撰写结果是否满足落库要求：JSON 结构是否合法、digests/archives 是否覆盖本批输入的每一章、是否出现明显编造或与片段冲突的内容。
只输出一个 JSON 对象：
{"pass":true,"issues":["具体问题"]}
判定口径：
- 章节摘要/档案必须覆盖本批每一章；缺失才判失败。
- places/events 是可选抽取项：片段没有可靠地点/日期时允许为空数组，不得因为「requiredItems 包含 place/timeline」就强制非空。
- 地点经纬度允许使用公认的地理常识；不要求原文片段直接写出坐标。日期允许 YYYY、YYYY-MM 或 YYYY-MM-DD，不要求精确到日。
- 只拒绝明显编造原文引文、与片段直接冲突、坐标越界、JSON 结构错误或章节覆盖缺失。
- 不要把“requiredItems 名称”当作 JSON 字段名；时间线数据在撰写结果里的字段名是 events。
- pass 为 true 时 issues 必须是空数组；pass 为 false 时 issues 给 1-3 条可执行的修改意见（每条一句话），不要给出重写后的全文。
- 只做审查，不要输出其他内容。
${STRICT_JSON_RULE}`;

/** 批次输入的固定提醒：写作目标、覆盖章节（供 reviewer / writer 复用）。 */
export function buildBatchRules(requiredItemTitles: readonly string[]): string {
  const items = requiredItemTitles.length > 0 ? requiredItemTitles.join("、") : "（无）";
  return `本批目标条目：${items}。只输出 JSON。`;
}
