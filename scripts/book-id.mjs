// 书籍唯一 id：标题拼音 slug + 内容短哈希。导入 API 与静态重解析脚本共用同一规则。
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { pinyin } from "pinyin-pro";

const SLUG_MAX_LENGTH = 32;
const HASH_LENGTH = 8;

export function pinyinSlug(title, maxLength = SLUG_MAX_LENGTH) {
  const raw = pinyin(title, { toneType: "none", type: "array" }).join("").toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
  return slug || "book";
}

export function shortHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, HASH_LENGTH);
}

export function bookIdFrom(title, hashHex) {
  const hash = String(hashHex ?? "").toLowerCase().slice(0, HASH_LENGTH);
  return hash ? `${pinyinSlug(title)}-${hash}` : pinyinSlug(title);
}

function runCli() {
  const args = process.argv.slice(2);
  const read = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const id = bookIdFrom(read("--title") ?? "", read("--hash") ?? "");
  process.stdout.write(id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
