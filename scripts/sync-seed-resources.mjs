#!/usr/bin/env node
// 构建期：把内容源里 format=seed 的书复制到 src-tauri/resources/seed/，随安装包分发。
// 生成物已 gitignore；只复制种子书，不复制 seed.json 派生缓存与用户数据。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(root, "data", "books");
const targetRoot = path.join(root, "src-tauri", "resources", "seed");

if (!fs.existsSync(sourceRoot)) {
  console.error(`[seed] 内容源不存在：${sourceRoot}`);
  process.exit(1);
}

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });

const index = JSON.parse(fs.readFileSync(path.join(sourceRoot, "index.json"), "utf8"));
const seedBooks = [];
for (const book of index.books ?? []) {
  if (book.format !== "seed") continue;
  const from = path.join(sourceRoot, book.id);
  if (!fs.existsSync(path.join(from, "book.json"))) {
    console.warn(`[seed] 跳过缺少 book.json 的条目：${book.id}`);
    continue;
  }
  const to = path.join(targetRoot, book.id);
  fs.cpSync(from, to, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(from, entry);
      const top = relative.split(path.sep)[0];
      // 派生缓存与用户导入原文件都不随安装包分发。
      return top !== "source" && path.basename(entry) !== "seed.json";
    },
  });
  seedBooks.push(book);
}

if (seedBooks.length === 0) {
  console.error("[seed] 没有找到 format=seed 的书，安装包会缺少种子内容");
  process.exit(1);
}

fs.writeFileSync(
  path.join(targetRoot, "index.json"),
  JSON.stringify({ schemaVersion: 2, books: seedBooks }, null, 2) + "\n",
  "utf8",
);
console.log(`[seed] 已同步 ${seedBooks.length} 本种子书 → ${path.relative(root, targetRoot)}`);
