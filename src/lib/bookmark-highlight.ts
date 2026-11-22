/**
 * 书签文字高亮与正文选区偏移工具。
 *
 * ## 偏移口径（与 CONTRACTS 2.1 / lead 接线约定一致）
 *
 * `quoteStart` / `quoteEnd` 是相对 **原始 `block.text`** 的 UTF-16 code unit 偏移，
 * 也就是相对数据层文本（含 `[[n:1]]` 脚注占位符），**不是**渲染后 DOM 文本的偏移。
 * 因为 InlineText 会把 `[[n:1]]` 渲染成更短的 `[1]`（长度可能不同），若用 DOM 文本偏移
 * 去切 block.text，偏移会错位。所以这里：
 *
 * - `readArticleSelection`：从 DOM Range 反推出「渲染文本偏移」，再按脚注占位符展开
 *   校正成原始 block.text 偏移；
 * - `resolveHighlightRange`：在原始 block.text 上定位区间（优先用偏移，越界/缺失时
 *   回退到 quote 首次出现）；
 * - `ChapterView` 用这个区间切 block.text，把区间交给 `InlineText` 只包选中文字。
 *
 * ## lead 在 ReaderPage 的接线方式（建议）
 *
 * ```ts
 * // 1) 读取正文选区（替换现有的 readArticleSelection）：
 * const article = getScrollViewport()?.querySelector<HTMLElement>(".prose-reading") ?? null;
 * const selected = readArticleSelection(article); // { text, blockId?, start?, end? }
 *
 * // 2) 创建文字书签时把偏移写进 quoteStart/quoteEnd：
 * const input: BookmarkInput = {
 *   ...,
 *   ...(selected?.blockId ? { blockId: selected.blockId } : {}),
 *   ...(selected?.text ? { quote: selected.text } : {}),
 *   ...(selected?.start !== undefined ? { quoteStart: selected.start } : {}),
 *   ...(selected?.end !== undefined ? { quoteEnd: selected.end } : {}),
 * };
 *
 * // 3) 跳转书签时构造 highlight 传给 ChapterView，2.5s 后清空：
 * setBookmarkJumpHighlight({
 *   blockId: bookmark.blockId!,
 *   quote: bookmark.quote ?? "",
 *   start: bookmark.quoteStart,
 *   end: bookmark.quoteEnd,
 *   nonce: Date.now(),
 * });
 * window.setTimeout(() => setBookmarkJumpHighlight(null), 2500);
 * ```
 *
 * `<ChapterView highlight={bookmarkJumpHighlight} />`；组件只按 prop 渲染，不自己计时。
 */

/** 跳转书签时传给 ChapterView 的一次性高亮描述。 */
export interface BookmarkJumpHighlight {
  /** 正文块 data-block-id。 */
  blockId: string;
  /** 选中文字（偏移缺失时的回退定位依据）。 */
  quote: string;
  /** 相对原始 block.text 的起始偏移（UTF-16）；旧书签缺省。 */
  start?: number;
  /** 相对原始 block.text 的结束偏移（UTF-16）；旧书签缺省。 */
  end?: number;
  /** 变化标记：同一书签再次跳转时让调用方/组件能区分新旧高亮。 */
  nonce: number;
}

/** 原始 block.text 上的高亮区间 [start, end)。 */
export interface BookmarkHighlightRange {
  start: number;
  end: number;
}

/**
 * 正文选区结果。
 *
 * - `text`：选区文本（空白归一化、最多 2000 字），可直接作为书签 title/quote 的来源；
 * - `blockId`：选区起始所在正文块的 data-block-id（选区跨块时取起始块）；
 * - `start`/`end`：相对起始块 **原始 block.text** 的 UTF-16 偏移；
 *   只在选区完整落在同一块内时给出，跨块/无块时缺省。
 */
export interface ArticleSelection {
  text: string;
  blockId?: string;
  start?: number;
  end?: number;
}

const NOTE_MARKER_RE = /\[\[n:(\d+)\]\]/g;
const STICKY_NOTE_MARKER_RE = /\[\[n:(\d+)\]\]/y;
const MAX_TEXT_LENGTH = 2000;

function isElement(node: Node | null | undefined): node is Element {
  return node !== null && node !== undefined && node.nodeType === Node.ELEMENT_NODE;
}

function parentElementOf(node: Node): HTMLElement | null {
  const element = isElement(node)
    ? node
    : node.parentElement ?? null;
  return element instanceof HTMLElement ? element : null;
}

/** 找到节点所属的正文块（[data-block-id]），并确认仍在正文根内。 */
function closestBlock(
  element: Element | null,
  article: HTMLElement,
): HTMLElement | null {
  const block = element?.closest<HTMLElement>("[data-block-id]") ?? null;
  return block && article.contains(block) ? block : null;
}

/**
 * 把「渲染后 DOM 文本」展开回原始 block.text：
 * InlineText 里脚注占位符 `[[n:1]]` 渲染为 `[1]`，其余文本与源文本一一对应。
 */
function reconstructBlockSourceText(block: HTMLElement): string {
  let source = "";
  const walk = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      source += (node as Text).data;
      return;
    }
    if (!isElement(node)) return;
    const element = node as HTMLElement;
    const noteNumber = element.dataset.noteMarker;
    if (noteNumber) {
      // InlineText 渲染的脚注标号：还原成原始占位符，长度与数据层一致。
      source += `[[n:${noteNumber}]]`;
      return;
    }
    element.childNodes.forEach(walk);
  };
  block.childNodes.forEach(walk);
  return source;
}

/**
 * 计算 Range 边界点在原始 block.text 中的偏移。
 *
 * 做法：先量出「块起点 → 边界点」在 DOM 里的渲染长度，再把落在 Range 内的脚注标号
 * 从渲染长度 `[n]` 校正回源长度 `[[n:n]]`。边界点落在标号内部时按整块标号近似处理。
 */
function sourceOffsetAt(
  block: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  if (container !== block && !block.contains(container)) return null;
  const range = document.createRange();
  try {
    range.setStart(block, 0);
    range.setEnd(container, offset);
  } catch {
    // 边界点不合法（例如 offset 越界）：交给调用方回退到 quote 定位。
    return null;
  }
  let sourceLength = range.toString().length;
  const markers = block.querySelectorAll<HTMLElement>("[data-note-marker]");
  markers.forEach((marker) => {
    if (!range.intersectsNode(marker)) return;
    const noteNumber = marker.dataset.noteMarker ?? "";
    const renderedLength = `[${noteNumber}]`.length;
    const sourceLengthWithMarker = `[[n:${noteNumber}]]`.length;
    sourceLength += sourceLengthWithMarker - renderedLength;
  });
  return sourceLength;
}

interface RenderMap {
  /** 原始文本按 InlineText 规则渲染后的文字。 */
  rendered: string;
  /** rendered[i] 对应的原始 block.text 偏移。 */
  toSource: number[];
}

/** 构造「渲染文本 → 原始文本」逐字符映射，用于 quote 回退定位时跨越脚注占位符。 */
function buildRenderMap(source: string): RenderMap {
  let rendered = "";
  const toSource: number[] = [];
  let index = 0;
  while (index < source.length) {
    STICKY_NOTE_MARKER_RE.lastIndex = index;
    const match = STICKY_NOTE_MARKER_RE.exec(source);
    if (match) {
      const token = `[${match[1]}]`;
      for (const character of token) {
        rendered += character;
        toSource.push(index);
      }
      index += match[0].length;
      continue;
    }
    rendered += source[index];
    toSource.push(index);
    index += 1;
  }
  return { rendered, toSource };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 在原始 block.text 中查找 quote：先直接匹配，再按「空白折叠 + 脚注标号渲染」的
 * 宽松匹配（兼容旧书签只有 quote、且 quote 跨过脚注标号的情况）。
 */
export function findQuoteRange(text: string, quote: string): BookmarkHighlightRange | null {
  const needle = quote.trim();
  if (!needle || !text) return null;
  const direct = text.indexOf(needle);
  if (direct >= 0) return { start: direct, end: direct + needle.length };

  const { rendered, toSource } = buildRenderMap(text);
  const pattern = needle.split(/\s+/).map(escapeRegExp).join("\\s+");
  const match = new RegExp(pattern).exec(rendered);
  if (!match || toSource.length === 0) return null;
  const start = toSource[match.index] ?? 0;
  const lastRenderedIndex = Math.min(match.index + match[0].length - 1, toSource.length - 1);
  const lastSourceIndex = toSource[lastRenderedIndex] ?? start;
  const end = lastSourceIndex + 1;
  return { start, end: Math.max(start + 1, end) };
}

/**
 * 把书签高亮解析成原始 block.text 上的区间。
 *
 * 优先使用 `start/end`（越界时夹取，落在脚注占位符内部时吸附到占位符边界）；
 * 偏移缺失或无效时回退到 quote 首次出现，再不行返回 null
 * （调用方不渲染 mark，仍可正常滚动到块）。
 */
export function resolveHighlightRange(
  text: string,
  highlight: Pick<BookmarkJumpHighlight, "quote" | "start" | "end">,
): BookmarkHighlightRange | null {
  const { start, end } = highlight;
  if (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isFinite(start) &&
    Number.isFinite(end)
  ) {
    const safeStart = Math.max(0, Math.min(Math.floor(start), text.length));
    const safeEnd = Math.max(0, Math.min(Math.floor(end), text.length));
    if (safeEnd > safeStart) {
      const range = snapMarkerBoundaries(text, { start: safeStart, end: safeEnd });
      if (range) return range;
    }
  }
  return findQuoteRange(text, highlight.quote);
}

/** 脚注占位符 [start, end) 列表（`[[n:1]]` 在渲染时是一个整体标号）。 */
function noteMarkerSpans(text: string): BookmarkHighlightRange[] {
  const spans: BookmarkHighlightRange[] = [];
  const pattern = /\[\[n:\d+\]\]/g;
  let match = pattern.exec(text);
  while (match) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  return spans;
}

/**
 * 选中区间的边界若落在脚注占位符内部，吸附到占位符边界：
 * 起点往后吸附到占位符之后，终点往前吸附到占位符之前，避免高亮半个 `[[n:1]]`。
 */
function snapMarkerBoundaries(
  text: string,
  range: BookmarkHighlightRange,
): BookmarkHighlightRange | null {
  let { start, end } = range;
  for (const span of noteMarkerSpans(text)) {
    if (start > span.start && start < span.end) start = span.end;
    if (end > span.start && end < span.end) end = span.start;
  }
  return end > start ? { start, end } : null;
}

/**
 * 从正文根元素读取当前选区（相对原始 block.text 的偏移）。
 *
 * 说明：选区必须落在正文根 `.prose-reading` 内；没有有效选区返回 undefined。
 * 选区跨块时只返回起始块 blockId 与归一化文本，不给偏移（避免跨块高亮错位）。
 */
export function readArticleSelection(
  article: HTMLElement | null | undefined,
): ArticleSelection | undefined {
  if (!article || typeof window === "undefined") return undefined;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const startElement = parentElementOf(range.startContainer);
  const endElement = parentElementOf(range.endContainer);
  if (!startElement || !article.contains(startElement)) return undefined;

  const text = selection
    .toString()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
  if (!text) return undefined;

  const startBlock = closestBlock(startElement, article);
  const endBlock = closestBlock(endElement, article);
  const blockId = startBlock?.dataset.blockId || undefined;
  if (!startBlock || !blockId || !endBlock || endBlock !== startBlock) {
    return blockId ? { text, blockId } : { text };
  }

  const sourceText = reconstructBlockSourceText(startBlock);
  const rawStart = sourceOffsetAt(startBlock, range.startContainer, range.startOffset);
  const rawEnd = sourceOffsetAt(startBlock, range.endContainer, range.endOffset);
  if (rawStart === null || rawEnd === null) return { text, blockId };

  let start = Math.max(0, Math.min(rawStart, sourceText.length));
  let end = Math.max(0, Math.min(rawEnd, sourceText.length));
  if (end < start) [start, end] = [end, start];
  // 去掉选区首尾空白，偏移仍指向原始文本字符。
  while (start < end && /\s/.test(sourceText[start])) start += 1;
  while (end > start && /\s/.test(sourceText[end - 1])) end -= 1;
  if (end <= start) return { text, blockId };
  return { text, blockId, start, end };
}

/** 供测试/调试：原始 block.text → InlineText 渲染文本。 */
export function renderInlineText(text: string): string {
  return text.replace(NOTE_MARKER_RE, (_match, noteNumber: string) => `[${noteNumber}]`);
}
