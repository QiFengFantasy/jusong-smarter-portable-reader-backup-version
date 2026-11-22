/**
 * EPUB 内嵌封面定位 + ZIP 路径解析（纯函数，不依赖 DOM/JSZip）。
 *
 * 选择顺序（与产品需求一致）：
 * 1. EPUB3：manifest item 的 properties 含 `cover-image`；
 * 2. EPUB2：metadata `<meta name="cover" content="<manifest id>">`；
 * 3. guide：`<reference type="cover" href>` 指向封面页 → 再取页内第一张图；
 * 4. 兜底：manifest 中 media-type 是图片、且 id/href 含 cover 的项。
 *
 * 这里只做“选哪个文件”的纯决策，读 ZIP 字节与错误容忍由 epub.ts 负责；
 * 纯函数便于用 Node 脚本针对真实 EPUB 的 OPF 数据验证选择逻辑。
 */

/** 原始封面文件大小上限（字节）；超过则跳过，避免把超大图读进内存。 */
export const COVER_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

/** 百分号解码失败时保留原串（EPUB 里存在不规范编码）。 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 把 OPF/NCX/nav 中的相对 href 解析成 ZIP 内绝对路径；丢弃 fragment 与 query。
 * 放在本模块是为了能用 Node 脚本直接验证真实 EPUB 的封面路径解析（无 DOM 依赖）。
 */
export function resolveHref(basePath: string, href: string): string {
  const withoutFragment = href.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  const decoded = safeDecode(withoutQuery).replace(/\\/g, "/");
  if (!decoded) return "";

  const isAbsolute = decoded.startsWith("/");
  const baseDirectory = isAbsolute
    ? ""
    : basePath.slice(0, Math.max(basePath.lastIndexOf("/") + 1, 0));
  const combined = (isAbsolute ? decoded.slice(1) : baseDirectory + decoded).split("/");

  const stack: string[] = [];
  for (const segment of combined) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

/** epub.ts 里 manifest map 的最小视图。 */
export interface CoverManifestEntry {
  id: string;
  /** 相对 ZIP 根解析后的路径（不含 fragment）。 */
  path: string;
  /** manifest media-type（可能为空或大小写不规范）。 */
  mediaType: string;
  properties: readonly string[];
}

export type CoverSource = "epub3-cover-image" | "epub2-meta-cover" | "guide" | "filename";

/** 封面候选：直接是图片，或是需要再解析的封面页（xhtml/html）。 */
export type CoverTarget =
  | { kind: "image"; path: string; mediaType: string; source: CoverSource }
  | { kind: "page"; path: string; source: CoverSource };

export interface CoverSearchInput {
  manifest: readonly CoverManifestEntry[];
  /** EPUB2 metadata `<meta name="cover" content="...">` 的值（manifest id）。 */
  metaCoverId?: string | null;
  /** guide `<reference type="cover" href>` 解析后的 ZIP 内路径。 */
  guideCoverPath?: string | null;
}

/** 只按扩展名推断图片 MIME；不是图片返回 null。 */
const IMAGE_EXTENSION_MIME: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpe: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  svg: "image/svg+xml",
  svgz: "image/svg+xml",
};

const PAGE_PATH_PATTERN = /\.x?html?$/i;

function pathBasename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** 扩展名 → 图片 MIME；无法判断时返回 null。 */
export function extensionImageMime(path: string): string | null {
  const withoutQuery = (path.split("?")[0] ?? path).split("#")[0] ?? path;
  const match = /\.([a-z0-9]+)$/i.exec(withoutQuery);
  if (!match) return null;
  return IMAGE_EXTENSION_MIME[(match[1] ?? "").toLowerCase()] ?? null;
}

/**
 * manifest 声明的 media-type 优先；声明缺失/非图片时退回扩展名。
 * 返回实际可用的图片 MIME，非图片返回 null。
 */
export function guessImageMime(
  path: string,
  mediaType?: string | null,
): string | null {
  const declared = (mediaType ?? "").trim().toLowerCase();
  if (declared.startsWith("image/")) return declared;
  return extensionImageMime(path);
}

export function isSvgMime(mime: string | null | undefined): boolean {
  return (mime ?? "").toLowerCase() === "image/svg+xml";
}

function isPagePath(path: string): boolean {
  return PAGE_PATH_PATTERN.test(path.split("#")[0] ?? path);
}

function isPageMediaType(mediaType: string): boolean {
  const declared = (mediaType ?? "").trim().toLowerCase();
  return declared === "application/xhtml+xml" || declared === "text/html";
}

function looksLikeCoverName(entry: CoverManifestEntry): boolean {
  return (
    entry.id.toLowerCase().includes("cover") ||
    pathBasename(entry.path).toLowerCase().includes("cover")
  );
}

/** 同一批候选里优先非 SVG（createImageBitmap 对 SVG 支持不可靠），SVG 作为最后选择。 */
function pickPreferredImage(entries: readonly CoverManifestEntry[]): CoverManifestEntry | null {
  const images = entries.filter(entry => guessImageMime(entry.path, entry.mediaType) !== null);
  const raster = images.find(entry => !isSvgMime(guessImageMime(entry.path, entry.mediaType)));
  return raster ?? images[0] ?? null;
}

function toImageTarget(entry: CoverManifestEntry, source: CoverSource): CoverTarget | null {
  const mime = guessImageMime(entry.path, entry.mediaType);
  if (!mime) return null;
  return { kind: "image", path: entry.path, mediaType: mime, source };
}

/** EPUB2 meta content 正常是 manifest id；少数书填的是文件名，按 id → 路径尾部 → 文件名兜底匹配。 */
function findManifestByMetaRef(
  manifest: readonly CoverManifestEntry[],
  reference: string,
): CoverManifestEntry | null {
  const direct = manifest.find(entry => entry.id === reference);
  if (direct) return direct;

  const normalized = reference.replace(/\\/g, "/").replace(/^\.\//, "");
  const byPath = manifest.find(
    entry => entry.path === normalized || entry.path.endsWith("/" + normalized),
  );
  if (byPath) return byPath;

  const wantedName = pathBasename(normalized).toLowerCase();
  if (!wantedName) return null;
  return (
    manifest.find(entry => pathBasename(entry.path).toLowerCase() === wantedName) ?? null
  );
}

/**
 * 在 manifest/EPUB2 metadata/guide 信息中按优先级挑选封面候选。
 * 返回 null 表示没有可用封面（导入时按无封面处理，不报错）。
 */
export function findCoverTarget(input: CoverSearchInput): CoverTarget | null {
  const { manifest } = input;

  // 1) EPUB3 cover-image
  const epub3Items = manifest.filter(entry =>
    entry.properties.some(property => property.toLowerCase() === "cover-image"),
  );
  const epub3Image = pickPreferredImage(epub3Items);
  if (epub3Image) return toImageTarget(epub3Image, "epub3-cover-image");

  // 2) EPUB2 meta name="cover" → content 是 manifest id（通常是图片，少数指向封面页）
  const metaReference = (input.metaCoverId ?? "").trim();
  if (metaReference) {
    const metaEntry = findManifestByMetaRef(manifest, metaReference);
    if (metaEntry) {
      const imageTarget = toImageTarget(metaEntry, "epub2-meta-cover");
      if (imageTarget) return imageTarget;
      // meta 指向封面页：也值得读，页内通常有唯一一张封面图。
      if (isPagePath(metaEntry.path) || isPageMediaType(metaEntry.mediaType)) {
        return { kind: "page", path: metaEntry.path, source: "epub2-meta-cover" };
      }
    }
  }

  // 3) guide cover 页 / 直接指向图片
  const guidePath = (input.guideCoverPath ?? "").trim();
  if (guidePath) {
    if (isPagePath(guidePath)) {
      return { kind: "page", path: guidePath, source: "guide" };
    }
    const mime = guessImageMime(guidePath, "");
    if (mime) {
      return { kind: "image", path: guidePath, mediaType: mime, source: "guide" };
    }
  }

  // 4) 文件名兜底：manifest 中 id/文件名含 cover 的图片项（优先非 SVG）
  const fallbackImage = pickPreferredImage(manifest.filter(looksLikeCoverName));
  if (fallbackImage) return toImageTarget(fallbackImage, "filename");

  return null;
}

const IMAGE_TAG_PATTERN = /<(?:[a-zA-Z_][\w.-]*:)?(img|image)\b([^>]*)>/gi;
const ATTRIBUTE_PATTERN = /([a-zA-Z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16) || 0),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10) || 0),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? "";
    if (name && !attributes.has(name)) attributes.set(name, decodeXmlEntities(value).trim());
  }
  return attributes;
}

/**
 * 从封面页 XHTML 中取第一张图片的原始 href：
 * - `<img src="...">`
 * - `<svg><image xlink:href="...">`（也兼容 `href`；命名空间前缀任意）
 * 返回原始 href（未解析相对路径），由调用方用 resolveHref 转成 ZIP 内路径。
 */
export function extractFirstImageHref(markup: string): string | null {
  // 先去掉注释，避免被注释掉的旧图/占位图抢中。
  const withoutComments = markup.replace(/<!--[\s\S]*?-->/g, "");
  for (const match of withoutComments.matchAll(IMAGE_TAG_PATTERN)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attributes = readAttributes(match[2] ?? "");
    const href =
      tag === "img" ? attributes.get("src") : attributes.get("xlink:href") ?? attributes.get("href");
    if (href) return href;
  }
  return null;
}
