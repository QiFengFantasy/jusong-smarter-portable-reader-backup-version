import JSZip from "jszip";

import type { ParsedCover } from "./cover";
import {
  COVER_SOURCE_MAX_BYTES,
  extractFirstImageHref,
  findCoverTarget,
  guessImageMime,
  resolveHref,
  safeDecode,
} from "./epub-cover";
import type { Block, BlockKind, Chapter, TocNode } from "./types";
import { normalizeText } from "./util";

/**
 * EPUB 解析（JSZip + DOMParser）。
 *
 * 目录优先级：EPUB3 nav（properties="nav"）→ NCX → spine 顺序。
 * 每章正文按块提取：h1-h6 → heading，p/列表单元格 → paragraph，
 * blockquote → quote，脚注/尾注 → note，其余容器下钻递归。
 * 解析结果不含 bookId：由导入方确定书 id 后补齐（避免为了取标题先建书）。
 */

/** 解析阶段的章节：bookId 由导入方补上。 */
export type ParsedChapter = Omit<Chapter, "bookId">;

export interface ParsedEpub {
  title: string;
  author?: string;
  publisher?: string;
  description?: string;
  toc: TocNode[];
  chapters: ParsedChapter[];
  warnings: string[];
  /** 内嵌封面（EPUB3 cover-image / EPUB2 meta cover / guide cover 页）；没有则缺省。 */
  cover?: ParsedCover;
}

interface ManifestItem {
  id: string;
  /** 相对 ZIP 根解析后的路径（不含 fragment）。 */
  path: string;
  mediaType: string;
  properties: string[];
}

interface TocEntry {
  title: string;
  href?: string;
  children: TocEntry[];
}

interface DraftBlock {
  kind: BlockKind;
  text: string;
  noteNumber?: number;
}

type XmlRoot = Document | Element;

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** 遇到这些元素先结束当前行内文本，再按语义处理。 */
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** 这些元素不是正文：脚本/样式/页眉导航/多媒体一律跳过。 */
const SKIP_TAGS = new Set([
  "audio",
  "head",
  "iframe",
  "link",
  "meta",
  "nav",
  "script",
  "style",
  "svg",
  "title",
  "video",
]);

const CONTENT_PATH_PATTERN = /\.x?html?$/i;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localNameOf(element: Element): string {
  return (element.localName || element.tagName || "").toLowerCase();
}

function elements(root: XmlRoot, name: string): Element[] {
  const target = name.toLowerCase();
  return Array.from(root.getElementsByTagName("*")).filter(
    element => localNameOf(element) === target,
  );
}

function allElements(root: XmlRoot): Element[] {
  return Array.from(root.getElementsByTagName("*"));
}

function childElements(root: XmlRoot): Element[] {
  return Array.from(root.children ?? []);
}

function directChild(root: XmlRoot, name: string): Element | undefined {
  const target = name.toLowerCase();
  return childElements(root).find(element => localNameOf(element) === target);
}

/** EPUB 命名空间的 epub:type；XML 与 HTML 解析路径都能读到。 */
function getEpubType(element: Element): string {
  const namespaced = element.getAttributeNS("http://www.idpf.org/2007/ops", "type");
  const plain = element.getAttribute("epub:type");
  return (namespaced ?? plain ?? "").toLowerCase();
}

interface ZipLookup {
  get(path: string): JSZip.JSZipObject | null;
}

/** ZIP 内路径大小写/百分号编码不一定规范：精确、解码、忽略大小写依次尝试。 */
function createZipLookup(zip: JSZip): ZipLookup {
  const lowerCasePaths = new Map<string, string>();
  for (const [path, object] of Object.entries(zip.files)) {
    if (!object.dir) lowerCasePaths.set(path.toLowerCase(), path);
  }

  return {
    get(path: string): JSZip.JSZipObject | null {
      for (const candidate of [path, safeDecode(path)]) {
        const exact = zip.file(candidate);
        if (exact) return exact;
        const mapped = lowerCasePaths.get(candidate.toLowerCase());
        if (mapped) {
          const found = zip.file(mapped);
          if (found) return found;
        }
      }
      return null;
    },
  };
}

async function readZipText(lookup: ZipLookup, path: string): Promise<string | null> {
  const entry = lookup.get(path);
  if (!entry) return null;
  try {
    return await entry.async("string");
  } catch {
    return null;
  }
}

/**
 * XHTML 按 XML 解析；大量 EPUB 实际不合法（未定义实体、标签不闭合），
 * 解析失败时退回 HTML 解析器，保证能读出正文。
 */
function parseMarkup(markup: string): Document {
  const parser = new DOMParser();
  const xmlDocument = parser.parseFromString(markup, "application/xhtml+xml");
  if (xmlDocument.getElementsByTagName("parsererror").length === 0) return xmlDocument;
  return parser.parseFromString(markup, "text/html");
}

function metadataValue(root: XmlRoot, localNames: readonly string[]): string {
  const wanted = new Set(localNames.map(name => name.toLowerCase()));
  for (const element of allElements(root)) {
    if (!wanted.has(localNameOf(element))) continue;
    const text = normalizeText(element.textContent);
    if (text) return text;
  }
  return "";
}

function basenameWithoutExtension(path: string): string {
  const name = path.split("/").pop() ?? path;
  return normalizeText(safeDecode(name).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
}

export function isContentPath(path: string): boolean {
  return CONTENT_PATH_PATTERN.test(path);
}

function isContentDocument(item: ManifestItem): boolean {
  if (item.mediaType === "application/xhtml+xml" || item.mediaType === "text/html") return true;
  return isContentPath(item.path);
}

function parseOrderedList(list: Element, basePath: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const item of childElements(list)) {
    if (localNameOf(item) !== "li") continue;

    const children = childElements(item);
    const anchor = children.find(child => {
      const tag = localNameOf(child);
      return tag === "a" || tag === "span";
    });
    const nested = children.find(child => {
      const tag = localNameOf(child);
      return tag === "ol" || tag === "ul";
    });

    const label = normalizeText(anchor?.textContent ?? "");
    const rawHref = anchor && localNameOf(anchor) === "a" ? anchor.getAttribute("href") : null;
    const href = rawHref ? resolveHref(basePath, rawHref) : "";
    const childEntries = nested ? parseOrderedList(nested, basePath) : [];

    if (!label && childEntries.length === 0) continue;
    const entry: TocEntry = { title: label, children: childEntries };
    if (href) entry.href = href;
    entries.push(entry);
  }
  return entries;
}

function parseNav(markup: string, navPath: string): TocEntry[] {
  const document = parseMarkup(markup);
  const navElements = elements(document, "nav");
  const tocNav =
    navElements.find(navElement => /(^|\s)toc(\s|$)/.test(getEpubType(navElement))) ??
    navElements[0];
  const root: XmlRoot = tocNav ?? document;
  const list = directChild(root, "ol") ?? elements(root, "ol")[0];
  if (!list) return [];
  return parseOrderedList(list, navPath);
}

function parseNavPoints(parent: Element, basePath: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const point of childElements(parent)) {
    if (localNameOf(point) !== "navpoint") continue;

    const labelElement = directChild(point, "navlabel");
    const textElement = labelElement ? directChild(labelElement, "text") : undefined;
    const contentElement = directChild(point, "content");
    const title = normalizeText(textElement?.textContent ?? "");
    const rawSrc = contentElement?.getAttribute("src") ?? "";
    const href = rawSrc ? resolveHref(basePath, rawSrc) : "";
    const children = parseNavPoints(point, basePath);

    if (!title && children.length === 0) continue;
    const entry: TocEntry = { title, children };
    if (href) entry.href = href;
    entries.push(entry);
  }
  return entries;
}

function parseNcx(markup: string, ncxPath: string): TocEntry[] {
  const document = parseMarkup(markup);
  const navMap = elements(document, "navmap")[0];
  if (!navMap) return [];
  return parseNavPoints(navMap, ncxPath);
}

function isFootnoteContainer(element: Element): boolean {
  const type = getEpubType(element);
  const classes = (element.getAttribute("class") ?? "").toLowerCase();
  return (
    /(^|\s)(footnotes|endnotes|rearnotes)(\s|$)/.test(type) ||
    /(^|[\s_-])(footnotes|endnotes|rearnotes)([\s_-]|$)/.test(classes)
  );
}

/** 脚注判定：epub:type、role，或常见 class/id 命名。 */
function isFootnote(element: Element): boolean {
  const type = getEpubType(element);
  const role = (element.getAttribute("role") ?? "").toLowerCase();
  const classes = (element.getAttribute("class") ?? "").toLowerCase();
  const id = (element.getAttribute("id") ?? "").toLowerCase();

  if (/(^|\s)(footnote|endnote|rearnote)(\s|$)/.test(type)) return true;
  if (role === "doc-footnote" || role === "doc-endnote") return true;
  if (/(^|[\s_-])(footnote|endnote|rearnote)([\s_-]|$)/.test(classes)) return true;
  if (/(^|[\s_-])(fn|note)(\d+)([\s_-]|$)/.test(classes)) return true;
  if (/^(fn|note|footnote|endnote)[-_]?\d+$/.test(id)) return true;
  return false;
}

function pushText(drafts: DraftBlock[], kind: BlockKind, element: Element): void {
  const text = normalizeText(element.textContent);
  if (text) drafts.push({ kind, text });
}

function pushQuote(blockquote: Element, drafts: DraftBlock[]): void {
  const paragraphs = childElements(blockquote).filter(
    element => localNameOf(element) === "p",
  );
  if (paragraphs.length > 0) {
    for (const paragraph of paragraphs) pushText(drafts, "quote", paragraph);
    return;
  }
  pushText(drafts, "quote", blockquote);
}

/** 表格没有对应的 Block 类型：按行压成 "单元格 | 单元格" 的段落，至少不丢内容。 */
function pushTable(table: Element, drafts: DraftBlock[]): void {
  const rows = elements(table, "tr");
  if (rows.length === 0) {
    pushText(drafts, "paragraph", table);
    return;
  }
  for (const row of rows) {
    const cells = childElements(row).filter(cell => {
      const tag = localNameOf(cell);
      return tag === "td" || tag === "th";
    });
    const text = cells
      .map(cell => normalizeText(cell.textContent))
      .filter(Boolean)
      .join(" | ");
    if (text) drafts.push({ kind: "paragraph", text });
  }
}

function pushNote(element: Element, drafts: DraftBlock[], state: { noteCount: number }): void {
  const text = normalizeText(element.textContent);
  if (!text) return;

  state.noteCount += 1;
  const idMatch = /(?:^|[-_])(\d+)$/.exec(element.getAttribute("id") ?? "");
  const textMatch = /^(\d+)[.、)）\s]/.exec(text);
  const fromId = idMatch?.[1];
  const fromText = textMatch?.[1];
  const noteNumber = Number(fromId ?? fromText ?? state.noteCount);

  drafts.push({ kind: "note", text, noteNumber });
}

function walkBlocks(
  container: Element,
  drafts: DraftBlock[],
  state: { noteCount: number },
): void {
  let inlineBuffer = "";

  const flush = (): void => {
    const text = normalizeText(inlineBuffer);
    inlineBuffer = "";
    if (text) drafts.push({ kind: "paragraph", text });
  };

  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      inlineBuffer += child.textContent ?? "";
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const element = child as Element;
    const tag = localNameOf(element);

    if (tag === "br") {
      inlineBuffer += " ";
      continue;
    }
    if (SKIP_TAGS.has(tag)) continue;
    if (!BLOCK_TAGS.has(tag)) {
      // 行内元素（span/em/a/img…）并入当前段落；文本节点保留原有空白。
      inlineBuffer += element.textContent ?? "";
      continue;
    }

    flush();

    if (isFootnoteContainer(element)) {
      walkBlocks(element, drafts, state);
      continue;
    }
    if (isFootnote(element)) {
      pushNote(element, drafts, state);
      continue;
    }
    if (HEADING_TAGS.has(tag)) {
      pushText(drafts, "heading", element);
      continue;
    }
    if (tag === "p") {
      pushText(drafts, "paragraph", element);
      continue;
    }
    if (tag === "blockquote") {
      pushQuote(element, drafts);
      continue;
    }
    if (tag === "table") {
      pushTable(element, drafts);
      continue;
    }

    // div/section/article/li/ul/ol/td… 继续下钻，让子块按自身语义归档。
    walkBlocks(element, drafts, state);
  }

  flush();
}

function extractBlocks(document: Document): Block[] {
  const body = elements(document, "body")[0] ?? document.documentElement;
  const drafts: DraftBlock[] = [];
  if (body) walkBlocks(body, drafts, { noteCount: 0 });

  const blocks: Block[] = [];
  for (const draft of drafts) {
    if (!draft.text) continue;
    const block: Block = {
      id: "p" + String(blocks.length + 1).padStart(4, "0"),
      kind: draft.kind,
      text: draft.text,
    };
    if (draft.noteNumber !== undefined) block.noteNumber = draft.noteNumber;
    blocks.push(block);
  }
  return blocks;
}

function firstHeadingTitle(blocks: readonly Block[]): string {
  for (const block of blocks) {
    if (block.kind === "heading") return block.text;
  }
  return "";
}

function documentTitle(document: Document): string {
  return normalizeText(elements(document, "title")[0]?.textContent ?? "");
}

/** EPUB2 metadata 的 `<meta name="cover" content="manifest-id"/>`。 */
function findEpub2CoverId(metadataRoot: XmlRoot): string {
  for (const element of elements(metadataRoot, "meta")) {
    const name = (element.getAttribute("name") ?? "").trim().toLowerCase();
    if (name !== "cover") continue;
    const content = (element.getAttribute("content") ?? "").trim();
    if (content) return content;
  }
  return "";
}

/** guide 中 `type="cover"`（含 cover-page 等变体）的 reference 指向的 ZIP 内路径。 */
function findGuideCoverPath(packageDocument: XmlRoot, packagePath: string): string {
  for (const element of elements(packageDocument, "reference")) {
    const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
    if (!type.startsWith("cover")) continue;
    const href = element.getAttribute("href") ?? "";
    if (!href) continue;
    const path = resolveHref(packagePath, href);
    if (path) return path;
  }
  return "";
}

/** 读取封面图片原始字节；不存在/不是图片/超过大小上限都返回 null（不报错）。 */
async function readCoverImage(
  lookup: ZipLookup,
  path: string,
  declaredMediaType: string,
  warn: (message: string) => void,
): Promise<ParsedCover | null> {
  const mediaType = declaredMediaType || "";
  const mime = guessImageMime(path, mediaType);
  if (!mime) return null;

  const entry = lookup.get(path);
  if (!entry) {
    warn("封面候选文件不在 ZIP 中：" + path);
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = await entry.async("uint8array");
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  if (bytes.byteLength > COVER_SOURCE_MAX_BYTES) {
    warn(
      "封面图片超过 " +
        String(Math.round(COVER_SOURCE_MAX_BYTES / (1024 * 1024))) +
        "MB，已跳过：" +
        path,
    );
    return null;
  }
  return { bytes, mime };
}

interface CoverExtractionContext {
  packageDocument: Document;
  packagePath: string;
  manifest: ReadonlyMap<string, ManifestItem>;
  lookup: ZipLookup;
  warn: (message: string) => void;
}

/**
 * 提取内嵌封面：EPUB3 cover-image → EPUB2 meta cover → guide cover 页（取页内第一张图）
 * → manifest 文件名兜底。任何一步失败都折算成“没有封面”，不影响导入。
 */
async function extractEmbeddedCover(
  context: CoverExtractionContext,
): Promise<ParsedCover | undefined> {
  const { packageDocument, packagePath, manifest, lookup, warn } = context;

  const metadataRoot = elements(packageDocument, "metadata")[0] ?? packageDocument;
  const target = findCoverTarget({
    manifest: Array.from(manifest.values()),
    metaCoverId: findEpub2CoverId(metadataRoot),
    guideCoverPath: findGuideCoverPath(packageDocument, packagePath),
  });
  if (!target) return undefined;

  if (target.kind === "image") {
    return (await readCoverImage(lookup, target.path, target.mediaType, warn)) ?? undefined;
  }

  // guide 封面页：读 XHTML，取第一张 <img> / <svg><image>。
  const markup = await readZipText(lookup, target.path);
  if (!markup) {
    warn("封面页不存在：" + target.path);
    return undefined;
  }
  const rawHref = extractFirstImageHref(markup);
  if (!rawHref) {
    warn("封面页中未找到图片：" + target.path);
    return undefined;
  }
  const imagePath = resolveHref(target.path, rawHref);
  if (!imagePath) return undefined;

  const manifestItem = Array.from(manifest.values()).find(item => item.path === imagePath);
  return (await readCoverImage(lookup, imagePath, manifestItem?.mediaType ?? "", warn)) ?? undefined;
}

/**
 * 解析 EPUB，返回目录树与章节正文（不含 bookId）。
 * 解析失败抛出可读错误；可容忍的问题写入 warnings。
 */
export async function parseEpub(input: {
  name: string;
  buffer: ArrayBuffer;
}): Promise<ParsedEpub> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input.buffer);
  } catch (error) {
    throw new Error(
      "EPUB 解析失败：" + input.name + " 不是有效的 ZIP/EPUB 文件（" + describeError(error) + "）",
    );
  }

  const lookup = createZipLookup(zip);
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const containerXml = await readZipText(lookup, "META-INF/container.xml");
  if (!containerXml) {
    throw new Error("EPUB 解析失败：" + input.name + " 缺少 META-INF/container.xml");
  }

  const containerDocument = parseMarkup(containerXml);
  const rootfile = elements(containerDocument, "rootfile")[0];
  let packagePath = rootfile?.getAttribute("full-path") ?? "";
  if (!packagePath) {
    packagePath = Object.keys(zip.files).find(path => /\.opf$/i.test(path)) ?? "";
  }
  if (!packagePath) {
    throw new Error("EPUB 解析失败：" + input.name + " 的 container.xml 没有指向 OPF 包文件");
  }

  const packageXml = await readZipText(lookup, packagePath);
  if (!packageXml) {
    throw new Error("EPUB 解析失败：" + input.name + " 缺少 OPF 包文件：" + packagePath);
  }
  const packageDocument = parseMarkup(packageXml);

  const metadataRoot = elements(packageDocument, "metadata")[0] ?? packageDocument;
  const title =
    normalizeText(metadataValue(metadataRoot, ["title"])) ||
    input.name.replace(/\.epub$/i, "") ||
    "未命名书籍";
  const author = normalizeText(metadataValue(metadataRoot, ["creator"]));
  const publisher = normalizeText(metadataValue(metadataRoot, ["publisher"]));
  const description = normalizeText(metadataValue(metadataRoot, ["description"]));

  const manifest = new Map<string, ManifestItem>();
  for (const item of elements(packageDocument, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      path: resolveHref(packagePath, href),
      mediaType: (item.getAttribute("media-type") ?? "").toLowerCase(),
      properties: (item.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean),
    });
  }
  if (manifest.size === 0) {
    throw new Error("EPUB 解析失败：" + input.name + " 的 OPF 没有 manifest 项");
  }

  // 内嵌封面（可选）：解析失败不阻塞导入，仅在 warnings 里留痕。
  let cover: ParsedCover | undefined;
  try {
    cover = await extractEmbeddedCover({
      packageDocument,
      packagePath,
      manifest,
      lookup,
      warn,
    });
  } catch {
    cover = undefined;
  }

  const spineElement = elements(packageDocument, "spine")[0];
  const spineItems: Array<{ idref: string; linear: boolean }> = [];
  if (spineElement) {
    for (const itemref of childElements(spineElement)) {
      if (localNameOf(itemref) !== "itemref") continue;
      const idref = itemref.getAttribute("idref");
      if (!idref) continue;
      spineItems.push({
        idref,
        linear: (itemref.getAttribute("linear") ?? "yes").toLowerCase() !== "no",
      });
    }
  }
  if (spineItems.length === 0) {
    warn("EPUB 的 spine 为空，将按目录或 ZIP 中的 XHTML 文件顺序建章");
  }

  // 1) EPUB3 nav；2) NCX；3) spine。nav/NCX 文件本身不是正文，记入 excludedPaths。
  const excludedPaths = new Set<string>();
  let tocEntries: TocEntry[] = [];
  const navItem = Array.from(manifest.values()).find(item => item.properties.includes("nav"));
  if (navItem) {
    excludedPaths.add(navItem.path);
    const navXml = await readZipText(lookup, navItem.path);
    if (navXml) {
      tocEntries = parseNav(navXml, navItem.path);
    } else {
      warn("EPUB3 nav 文件不存在：" + navItem.path);
    }
  } else if (spineElement) {
    const ncxId = spineElement.getAttribute("toc") ?? "";
    const ncxItem =
      manifest.get(ncxId) ??
      Array.from(manifest.values()).find(item => item.mediaType === "application/x-dtbncx+xml");
    if (ncxItem) {
      excludedPaths.add(ncxItem.path);
      const ncxXml = await readZipText(lookup, ncxItem.path);
      if (ncxXml) tocEntries = parseNcx(ncxXml, ncxItem.path);
    }
  }

  const chapters: ParsedChapter[] = [];
  const chapterByPath = new Map<string, ParsedChapter>();
  const usedPaths = new Set<string>();
  const documentCache = new Map<string, Document | null>();
  let chapterSequence = 0;
  let volumeSequence = 0;
  let sectionSequence = 0;

  async function loadDocument(path: string): Promise<Document | null> {
    const cached = documentCache.get(path);
    if (cached !== undefined) return cached;
    const markup = await readZipText(lookup, path);
    if (!markup) {
      documentCache.set(path, null);
      warn("目录或 spine 引用的文件不存在：" + path);
      return null;
    }
    const document = parseMarkup(markup);
    documentCache.set(path, document);
    return document;
  }

  async function ensureChapter(
    path: string,
    fallbackTitle: string,
  ): Promise<ParsedChapter | null> {
    const existing = chapterByPath.get(path);
    if (existing) return existing;

    const document = await loadDocument(path);
    if (!document) return null;

    chapterSequence += 1;
    const blocks = extractBlocks(document);
    const chapterTitle =
      normalizeText(fallbackTitle) ||
      firstHeadingTitle(blocks) ||
      documentTitle(document) ||
      basenameWithoutExtension(path) ||
      "未命名章节";

    const chapter: ParsedChapter = {
      id: "ch_" + String(chapterSequence).padStart(4, "0"),
      title: chapterTitle,
      blocks,
      sourceHref: path,
    };
    chapters.push(chapter);
    chapterByPath.set(path, chapter);
    usedPaths.add(path);
    return chapter;
  }

  async function buildTocNodes(
    entries: readonly TocEntry[],
    depth: number,
    ancestors: { volumeId?: string; sectionId?: string },
  ): Promise<TocNode[]> {
    const nodes: TocNode[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;

      if (entry.children.length > 0) {
        if (depth === 0) {
          volumeSequence += 1;
          const id = "vol_" + String(volumeSequence).padStart(2, "0");
          const children = await buildTocNodes(entry.children, depth + 1, { volumeId: id });
          nodes.push({
            id,
            type: "volume",
            title: entry.title || "第 " + volumeSequence + " 卷",
            order: index,
            children,
          });
        } else {
          sectionSequence += 1;
          const id = "sec_" + String(sectionSequence).padStart(2, "0");
          const children = await buildTocNodes(entry.children, depth + 1, {
            volumeId: ancestors.volumeId,
            sectionId: id,
          });
          nodes.push({
            id,
            type: "section",
            title: entry.title || "第 " + sectionSequence + " 节",
            order: index,
            children,
          });
        }
        continue;
      }

      if (!entry.href) continue;
      const chapter = await ensureChapter(entry.href, entry.title);
      if (!chapter) continue;

      // 同一章只归属第一次出现的卷/节，避免目录重复引用时来回覆盖。
      if (ancestors.volumeId && !chapter.volumeId) chapter.volumeId = ancestors.volumeId;
      if (ancestors.sectionId && !chapter.sectionId) chapter.sectionId = ancestors.sectionId;

      nodes.push({
        id: chapter.id,
        type: "chapter",
        title: entry.title || chapter.title,
        order: index,
        chapterId: chapter.id,
      });
    }

    return nodes;
  }

  const toc: TocNode[] = tocEntries.length > 0 ? await buildTocNodes(tocEntries, 0, {}) : [];

  // 目录没覆盖到的 spine 文档也要能读：追加为顶层章节。
  for (const spineItem of spineItems) {
    if (!spineItem.linear) continue;
    const item = manifest.get(spineItem.idref);
    if (!item) {
      warn("spine 引用了不存在的 manifest 项：" + spineItem.idref);
      continue;
    }
    if (!isContentDocument(item)) continue;
    if (usedPaths.has(item.path) || excludedPaths.has(item.path)) continue;

    const chapter = await ensureChapter(item.path, "");
    if (!chapter) continue;
    toc.push({
      id: chapter.id,
      type: "chapter",
      title: chapter.title,
      order: toc.length,
      chapterId: chapter.id,
    });
  }

  // 目录与 spine 都没给出正文（损坏的 EPUB）：扫描 ZIP 内所有 XHTML，按路径顺序兜底。
  if (chapters.length === 0) {
    const candidates = Object.keys(zip.files)
      .filter(path => !zip.files[path]?.dir && isContentPath(path))
      .sort();
    for (const path of candidates) {
      if (excludedPaths.has(path)) continue;
      const chapter = await ensureChapter(path, "");
      if (!chapter) continue;
      toc.push({
        id: chapter.id,
        type: "chapter",
        title: chapter.title,
        order: toc.length,
        chapterId: chapter.id,
      });
    }
    if (chapters.length === 0) {
      throw new Error("EPUB 解析失败：" + input.name + " 中没有可读的 XHTML 正文");
    }
    warn("EPUB 缺少可用目录，已按 ZIP 内 XHTML 文件顺序建章");
  }

  const parsed: ParsedEpub = {
    title,
    author: author || undefined,
    publisher: publisher || undefined,
    description: description || undefined,
    toc,
    chapters,
    warnings,
  };
  if (cover) parsed.cover = cover;
  return parsed;
}
