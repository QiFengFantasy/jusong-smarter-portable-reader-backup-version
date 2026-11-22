#!/usr/bin/env node
/**
 * 验证脚本：EPUB 内嵌封面定位。
 *
 * 用真实 EPUB + 合成 OPF 数据验证 packages/core/src/epub-cover.ts 的纯选择逻辑，
 * 并直接读取真实封面的字节/尺寸/类型。不依赖 DOM，因此 Node 可直接跑：
 *   node scripts/verify-epub-cover.mjs <path-to.epub>
 *
 * 输出即证据；断言失败退出码 1。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import {
  COVER_SOURCE_MAX_BYTES,
  extractFirstImageHref,
  extensionImageMime,
  findCoverTarget,
  guessImageMime,
  isSvgMime,
  resolveHref,
} from "../packages/core/src/epub-cover.ts";
import {
  COVER_JPEG_QUALITY,
  COVER_MAX_DECODED_BYTES,
  COVER_TARGET_MAX_WIDTH,
  prepareCoverImage,
} from "../packages/core/src/cover.ts";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const JSZip = requireFromCore("jszip");

const epubPath = process.argv[2];
if (!epubPath) {
  console.error("用法：node scripts/verify-epub-cover.mjs <path-to.epub>");
  process.exit(1);
}

let failures = 0;
const pass = (name, detail = "") => console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
const fail = (name, detail = "") => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(name, a);
  else fail(name, `actual=${a} expected=${e}`);
};

function expect(name, condition, detail = "") {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function parseAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(/([a-zA-Z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function section(xml, tag) {
  const start = xml.indexOf("<" + tag);
  if (start < 0) return "";
  const end = xml.indexOf("</" + tag + ">", start);
  return end < 0 ? xml.slice(start) : xml.slice(start, end);
}

/** 仅用于脚本：把真实 OPF（无 DOM）解析成 epub-cover 需要的纯数据结构。 */
function parseOpfForCover(opfXml, packagePath) {
  const metadata = section(opfXml, "metadata");
  let metaCoverId = "";
  for (const match of metadata.matchAll(/<meta\b([^>]*?)\/?>/gi)) {
    const attrs = parseAttributes(match[1]);
    if ((attrs.get("name") ?? "").toLowerCase() === "cover") {
      metaCoverId = attrs.get("content") ?? "";
      break;
    }
  }

  const manifestSection = section(opfXml, "manifest");
  const manifest = [];
  for (const match of manifestSection.matchAll(/<item\b([^>]*?)\/?>/gi)) {
    const attrs = parseAttributes(match[1]);
    const id = attrs.get("id");
    const href = attrs.get("href");
    if (!id || !href) continue;
    manifest.push({
      id,
      path: resolveHref(packagePath, href),
      mediaType: (attrs.get("media-type") ?? "").toLowerCase(),
      properties: (attrs.get("properties") ?? "").split(/\s+/).filter(Boolean),
    });
  }

  const guideSection = section(opfXml, "guide");
  let guideCoverPath = "";
  for (const match of guideSection.matchAll(/<reference\b([^>]*?)\/?>/gi)) {
    const attrs = parseAttributes(match[1]);
    if (!(attrs.get("type") ?? "").toLowerCase().startsWith("cover")) continue;
    const href = attrs.get("href") ?? "";
    if (!href) continue;
    guideCoverPath = resolveHref(packagePath, href);
    break;
  }

  return { manifest, metaCoverId, guideCoverPath };
}

/** 从 JPEG 字节读 SOF 尺寸（只用于报告原始尺寸）。 */
function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 7 >= bytes.length) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return { width, height };
    }
    offset += length;
  }
  return null;
}

function imageTarget(source) {
  return { kind: "image", path: source.path, mediaType: source.mediaType, source: source.source };
}

console.log("== 常量 ==");
check("COVER_SOURCE_MAX_BYTES", COVER_SOURCE_MAX_BYTES, 8 * 1024 * 1024);

console.log("\n== 纯函数：resolveHref ==");
check("相对 OPF 目录", resolveHref("OEBPS/content.opf", "Images/cover.jpg"), "OEBPS/Images/cover.jpg");
check(
  "封面页里的 ../",
  resolveHref("OEBPS/Text/Cover.xhtml", "../Images/cover.jpg"),
  "OEBPS/Images/cover.jpg",
);
check("OPF 在根目录", resolveHref("content.opf", "cover.jpg"), "cover.jpg");
check("绝对路径", resolveHref("OEBPS/content.opf", "/Images/cover.jpg"), "Images/cover.jpg");
check("丢弃 fragment/query", resolveHref("OEBPS/content.opf", "a/b.jpg#x?y"), "OEBPS/a/b.jpg");
check("百分号编码", resolveHref("OEBPS/content.opf", "Images/%E5%B0%81%E9%9D%A2.jpg"), "OEBPS/Images/封面.jpg");
check("反斜杠", resolveHref("OEBPS/content.opf", "Images\\cover.jpg"), "OEBPS/Images/cover.jpg");

console.log("\n== 纯函数：MIME ==");
check("jpg 扩展名", extensionImageMime("a/b/cover.jpg"), "image/jpeg");
check("png 扩展名", extensionImageMime("cover.PNG"), "image/png");
check("svg 扩展名", extensionImageMime("cover.svg"), "image/svg+xml");
check("非图片", extensionImageMime("toc.ncx"), null);
check("manifest 声明优先", guessImageMime("cover.bin", "image/png"), "image/png");
check("声明非图片时退回扩展名", guessImageMime("cover.jpeg", "application/octet-stream"), "image/jpeg");
check("isSvgMime", [isSvgMime("image/svg+xml"), isSvgMime("image/jpeg")], [true, false]);

console.log("\n== 纯函数：封面页取第一张图 ==");
const coverPageSample = `<?xml version="1.0"?><html><body><div><svg xmlns="http://www.w3.org/2000/svg">
<image height="800" width="560" xlink:href="../Images/cover.jpg"/></svg></div></body></html>`;
check("svg image xlink:href", extractFirstImageHref(coverPageSample), "../Images/cover.jpg");
check(
  "img src（属性顺序/单引号）",
  extractFirstImageHref("<div><img alt='cover' src='img/a.jpg'></div>"),
  "img/a.jpg",
);
check(
  "data-src 不误判",
  extractFirstImageHref('<img data-src="lazy.jpg" src="real.jpg">'),
  "real.jpg",
);
check("XML 实体", extractFirstImageHref('<img src="a&amp;b.jpg">'), "a&b.jpg");
check(
  "跳过注释里的图",
  extractFirstImageHref('<!-- <img src="old.jpg"> --><img src="new.jpg">'),
  "new.jpg",
);
check("无图片", extractFirstImageHref("<p>cover text only</p>"), null);

console.log("\n== 纯函数：选择优先级（合成数据） ==");
const manifest3 = [
  { id: "nav", path: "OEBPS/nav.xhtml", mediaType: "application/xhtml+xml", properties: ["nav"] },
  { id: "cover-img", path: "OEBPS/img/cover.jpg", mediaType: "image/jpeg", properties: ["cover-image"] },
];
check(
  "EPUB3 cover-image 优先",
  findCoverTarget({ manifest: manifest3, metaCoverId: "other", guideCoverPath: "OEBPS/cover.xhtml" }),
  imageTarget({ kind: "image", path: "OEBPS/img/cover.jpg", mediaType: "image/jpeg", source: "epub3-cover-image" }),
);

const manifest3Svg = [
  { id: "cover-a", path: "OEBPS/img/cover.svg", mediaType: "image/svg+xml", properties: ["cover-image"] },
  { id: "cover-b", path: "OEBPS/img/cover.jpeg", mediaType: "image/jpeg", properties: ["cover-image"] },
];
check(
  "EPUB3 多项时优先非 SVG",
  findCoverTarget({ manifest: manifest3Svg }),
  imageTarget({ kind: "image", path: "OEBPS/img/cover.jpeg", mediaType: "image/jpeg", source: "epub3-cover-image" }),
);

const manifest2 = [
  { id: "cover.jpg", path: "OEBPS/Images/cover.jpg", mediaType: "image/jpeg", properties: [] },
  { id: "Cover.xhtml", path: "OEBPS/Text/Cover.xhtml", mediaType: "application/xhtml+xml", properties: [] },
];
check(
  "EPUB2 meta cover 命中（id）",
  findCoverTarget({ manifest: manifest2, metaCoverId: "cover.jpg" }),
  imageTarget({ kind: "image", path: "OEBPS/Images/cover.jpg", mediaType: "image/jpeg", source: "epub2-meta-cover" }),
);
check(
  "EPUB2 meta cover（填文件名也能匹配）",
  findCoverTarget({ manifest: manifest2, metaCoverId: "Images/cover.jpg" }),
  imageTarget({ kind: "image", path: "OEBPS/Images/cover.jpg", mediaType: "image/jpeg", source: "epub2-meta-cover" }),
);
check(
  "EPUB2 meta 指向封面页时返回 page",
  findCoverTarget({ manifest: manifest2, metaCoverId: "Cover.xhtml" }),
  { kind: "page", path: "OEBPS/Text/Cover.xhtml", source: "epub2-meta-cover" },
);
check(
  "guide cover 页（无 meta 时）",
  findCoverTarget({ manifest: manifest2, guideCoverPath: "OEBPS/Text/Cover.xhtml" }),
  { kind: "page", path: "OEBPS/Text/Cover.xhtml", source: "guide" },
);
check(
  "guide 直接指向图片",
  findCoverTarget({ manifest: [], guideCoverPath: "OEBPS/Images/cover.jpg" }),
  imageTarget({ kind: "image", path: "OEBPS/Images/cover.jpg", mediaType: "image/jpeg", source: "guide" }),
);
check(
  "文件名兜底",
  findCoverTarget({
    manifest: [{ id: "cover-image", path: "OEBPS/pics/cover.png", mediaType: "", properties: [] }],
  }),
  imageTarget({ kind: "image", path: "OEBPS/pics/cover.png", mediaType: "image/png", source: "filename" }),
);
check(
  "找不到封面返回 null",
  findCoverTarget({
    manifest: [
      { id: "nav", path: "OEBPS/nav.xhtml", mediaType: "application/xhtml+xml", properties: ["nav"] },
      { id: "img1", path: "OEBPS/pics/zz.jpg", mediaType: "image/jpeg", properties: [] },
    ],
  }),
  null,
);

const realEpubPath = resolve(epubPath);
console.log("\n== 真实 EPUB ==");
console.log("  文件:", realEpubPath);
console.log("  大小:", readFileSync(realEpubPath).byteLength, "字节");

const zip = await JSZip.loadAsync(readFileSync(realEpubPath));
const containerPath = "META-INF/container.xml";
const containerXml = await zip.file(containerPath).async("string");
const rootfileMatch = /<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(containerXml);
if (!rootfileMatch) throw new Error("container.xml 没有 rootfile");
const packagePath = rootfileMatch[1];
console.log("  OPF:", packagePath);

const opfXml = await zip.file(packagePath).async("string");
const parsedOpf = parseOpfForCover(opfXml, packagePath);
console.log("  manifest 项:", parsedOpf.manifest.length, "| meta cover:", JSON.stringify(parsedOpf.metaCoverId), "| guide cover:", JSON.stringify(parsedOpf.guideCoverPath));

const target = findCoverTarget(parsedOpf);
console.log("  选中候选:", JSON.stringify(target));
check(
  "真实 OPF：meta cover 优先且路径正确",
  target,
  imageTarget({ kind: "image", path: "OEBPS/Images/cover.jpg", mediaType: "image/jpeg", source: "epub2-meta-cover" }),
);

if (target && target.kind === "image") {
  const bytes = new Uint8Array(await zip.file(target.path).async("uint8array"));
  const size = jpegSize(bytes);
  console.log(
    `  封面路径: ${target.path} | 原始 MIME: ${target.mediaType} | 字节: ${bytes.byteLength} | 尺寸: ${
      size ? size.width + "×" + size.height : "未知"
    }`,
  );
  expect("原始封面 ≤ 8MB（不会被跳过）", bytes.byteLength > 0 && bytes.byteLength <= COVER_SOURCE_MAX_BYTES, `${bytes.byteLength} B`);
  expect("封面是 JPEG", bytes[0] === 0xff && bytes[1] === 0xd8, "SOI 标记");
  check("封面尺寸 560×800", size, { width: 560, height: 800 });
  check("封面字节数符合 lead 实测", bytes.byteLength, 111089);
}

// guide 兜底路径：去掉 meta 后应选 cover 页，且页内第一张图能解析回同一封面。
const guideOnly = findCoverTarget({ ...parsedOpf, metaCoverId: "" });
check(
  "真实 OPF：无 meta 时 guide 选封面页",
  guideOnly,
  { kind: "page", path: "OEBPS/Text/Cover.xhtml", source: "guide" },
);
if (guideOnly && guideOnly.kind === "page") {
  const pageXml = await zip.file(guideOnly.path).async("string");
  const rawHref = extractFirstImageHref(pageXml);
  console.log("  guide 页内首图 href:", JSON.stringify(rawHref));
  const pageImagePath = rawHref ? resolveHref(guideOnly.path, rawHref) : "";
  check("guide 页首图解析回真实封面", pageImagePath, "OEBPS/Images/cover.jpg");
  expect("guide 页首图存在于 ZIP", Boolean(zip.file(pageImagePath)));
}

// 文件名兜底也能在真实 manifest 上命中同一张图。
const fallbackOnly = findCoverTarget({ manifest: parsedOpf.manifest });
console.log("  文件名兜底候选:", JSON.stringify(fallbackOnly));
check(
  "真实 OPF：文件名兜底命中封面图",
  fallbackOnly,
  imageTarget({ kind: "image", path: "OEBPS/Images/cover.jpg", mediaType: "image/jpeg", source: "filename" }),
);

console.log("\n== prepareCoverImage（mock DOM/Canvas：缩放/白底/降质量/分块 base64）==");

function fakeJpegBlob(size) {
  const bytes = new Uint8Array(size);
  bytes.fill(0x41);
  return new Blob([bytes], { type: "image/jpeg" });
}

function installFakeBrowser({ sourceWidth = 560, sourceHeight = 800, blobSizes = [1024], failToBlob = false } = {}) {
  const calls = {
    qualities: [],
    canvasSize: null,
    contextType: null,
    fillRect: null,
    fillStyle: "",
    drawImage: null,
    smoothing: null,
    blobType: null,
    closed: false,
    decoded: false,
    elementTag: null,
  };
  let blobIndex = 0;
  globalThis.createImageBitmap = async () => {
    calls.decoded = true;
    return {
      width: sourceWidth,
      height: sourceHeight,
      close() {
        calls.closed = true;
      },
    };
  };
  const context = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillRect(...args) {
      calls.fillRect = args;
      calls.fillStyle = context.fillStyle;
    },
    drawImage(...args) {
      calls.drawImage = args;
      calls.smoothing = {
        enabled: context.imageSmoothingEnabled,
        quality: context.imageSmoothingQuality,
      };
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext(type) {
      calls.contextType = type;
      calls.canvasSize = { width: canvas.width, height: canvas.height };
      return context;
    },
    toBlob(callback, type, quality) {
      calls.blobType = type;
      calls.qualities.push(quality);
      if (failToBlob) {
        callback(null);
        return;
      }
      const size = blobSizes[Math.min(blobIndex, blobSizes.length - 1)];
      blobIndex += 1;
      callback(fakeJpegBlob(size));
    },
  };
  globalThis.document = {
    createElement(tag) {
      calls.elementTag = tag;
      return canvas;
    },
  };
  return calls;
}

function removeFakeBrowser() {
  delete globalThis.createImageBitmap;
  delete globalThis.document;
}

const jpegSource = (mime = "image/jpeg") => ({ bytes: new Uint8Array(111089).fill(0x42), mime });

let calls = installFakeBrowser({ blobSizes: [3 * 1024 * 1024, 1024 * 1024] });
let prepared = await prepareCoverImage(jpegSource());
check("宽度缩到 480、高度等比", calls.canvasSize, {
  width: COVER_TARGET_MAX_WIDTH,
  height: 686,
});
check("canvas 2d + 白底", [calls.contextType, calls.fillStyle, calls.fillRect], [
  "2d",
  "#ffffff",
  [0, 0, 480, 686],
]);
check("drawImage 用目标尺寸", calls.drawImage?.slice(1), [0, 0, 480, 686]);
check("高质量平滑", calls.smoothing, { enabled: true, quality: "high" });
check("首轮 >2MB 后逐级降质量", calls.qualities, [COVER_JPEG_QUALITY, 0.7]);
check("输出 MIME", prepared?.mime, "image/jpeg");
check("toBlob 使用 image/jpeg", calls.blobType, "image/jpeg");
const decodedCover = prepared ? Buffer.from(prepared.base64, "base64") : null;
check("base64 分块编码字节数正确", decodedCover?.byteLength, 1024 * 1024);
expect(
  "base64 内容首尾正确",
  Boolean(decodedCover) && decodedCover[0] === 0x41 && decodedCover.at(-1) === 0x41,
);
expect("bitmap.close 释放解码内存", calls.closed);

calls = installFakeBrowser({ blobSizes: [3 * 1024 * 1024] });
prepared = await prepareCoverImage(jpegSource());
check("所有质量档都超限时返回 null", prepared, null);
check("降质量完整阶梯", calls.qualities, [COVER_JPEG_QUALITY, 0.7, 0.55, 0.4]);

calls = installFakeBrowser({ sourceWidth: 300, sourceHeight: 400 });
prepared = await prepareCoverImage(jpegSource());
check("小图不放大", calls.canvasSize, { width: 300, height: 400 });
check("小图一次编码成功", calls.qualities, [COVER_JPEG_QUALITY]);
expect("小图返回结果", Boolean(prepared));

calls = installFakeBrowser();
prepared = await prepareCoverImage(jpegSource("image/svg+xml"));
check("SVG 返回 null 且不解码", [prepared, calls.decoded], [null, false]);

calls = installFakeBrowser();
calls.decodeError = false;
globalThis.createImageBitmap = async () => {
  throw new Error("decode failed");
};
prepared = await prepareCoverImage(jpegSource());
check("解码失败返回 null", prepared, null);

calls = installFakeBrowser({ failToBlob: true });
prepared = await prepareCoverImage(jpegSource());
check("toBlob 失败返回 null", prepared, null);

calls = installFakeBrowser();
prepared = await prepareCoverImage({ bytes: new Uint8Array(0), mime: "image/jpeg" });
check("空字节返回 null", prepared, null);

removeFakeBrowser();
prepared = await prepareCoverImage(jpegSource());
check("无 DOM 环境返回 null", prepared, null);

globalThis.document = { createElement: () => ({}) };
delete globalThis.createImageBitmap;
prepared = await prepareCoverImage(jpegSource());
check("无 createImageBitmap 返回 null", prepared, null);
removeFakeBrowser();

calls = installFakeBrowser({ blobSizes: [COVER_MAX_DECODED_BYTES] });
prepared = await prepareCoverImage(jpegSource());
expect("恰好 2MB 上限可通过（≤ 上限）", Boolean(prepared));

console.log("\n== 结果 ==");
if (failures === 0) {
  console.log("ALL CHECKS PASSED");
} else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exitCode = 1;
}
