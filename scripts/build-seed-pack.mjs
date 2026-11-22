#!/usr/bin/env node
// 构建期：把种子书打包成单个 dist/seed/seed-pack.json。
// Android 没有可读的 resource 目录（resource_dir 是 asset://localhost/），
// 因此把种子内容嵌入前端资产，由 Rust 用 asset_resolver 读取后写入用户库。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const booksRoot = path.join(root, "data", "books");
const distRoot = path.join(root, "dist");
const targetDir = path.join(distRoot, "seed");

if (!fs.existsSync(booksRoot)) {
  console.error(`[seed-pack] 内容源不存在：${booksRoot}`);
  process.exit(1);
}
if (!fs.existsSync(distRoot)) {
  console.error("[seed-pack] dist 不存在：请先执行前端构建（pnpm build）");
  process.exit(1);
}

const readJson = (file) => {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

const index = readJson(path.join(booksRoot, "index.json"));
const seedEntries = (index?.books ?? []).filter((book) => book.format === "seed");
const packs = [];
for (const meta of seedEntries) {
  const bookDir = path.join(booksRoot, meta.id);
  const book = readJson(path.join(bookDir, "book.json"));
  if (!book) {
    console.warn(`[seed-pack] 跳过缺少 book.json 的种子：${meta.id}`);
    continue;
  }
  const chapterIds = book.chapterIds ?? [];
  const chapters = [];
  for (const chapterId of chapterIds) {
    const chapterDir = path.join(bookDir, "chapters", chapterId);
    const chapter = readJson(path.join(chapterDir, "chapter.json"));
    if (!chapter) continue;
    chapters.push({
      chapter,
      digest: readJson(path.join(chapterDir, "digest.json")),
      map: readJson(path.join(chapterDir, "map.json")),
    });
  }
  const archives = readJson(path.join(bookDir, "shared", "archives.json"));
  // 封面：Android 无 resource 目录，随 seed-pack 以 base64 分发，Rust 写入用户库。
  let cover = null;
  if (typeof book.coverFile === "string" && book.coverFile) {
    const coverPath = path.join(bookDir, book.coverFile);
    if (fs.existsSync(coverPath)) {
      cover = {
        mime: typeof book.coverMime === "string" && book.coverMime ? book.coverMime : "image/jpeg",
        base64: fs.readFileSync(coverPath).toString("base64"),
      };
    }
  }
  packs.push({
    id: meta.id,
    book,
    toc: readJson(path.join(bookDir, "toc.json")) ?? [],
    chapters,
    knowledge: archives?.entries ?? [],
    cover,
    topics: {
      map: readJson(path.join(bookDir, "shared", "topics", "map.json")),
      timeline: readJson(path.join(bookDir, "shared", "topics", "timeline.json")),
    },
  });
}

if (packs.length === 0) {
  console.error("[seed-pack] 没有可打包的种子书");
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
const output = path.join(targetDir, "seed-pack.json");
fs.writeFileSync(
  output,
  JSON.stringify({ schemaVersion: 2, books: packs }),
  "utf8",
);
const size = (fs.statSync(output).size / (1024 * 1024)).toFixed(2);
console.log(`[seed-pack] ${packs.length} 本种子书 → dist/seed/seed-pack.json（${size} MB）`);
