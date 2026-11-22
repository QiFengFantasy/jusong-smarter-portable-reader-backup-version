/** 通用工具：ID、文本归一化、slug、封面色。供 core 内部使用。 */

/** 书封底色：纸墨与朱红系，按书名散列稳定取色。 */
const COVER_PALETTE = ["#8c2f1b", "#a34430", "#6b4f3a", "#455c52", "#2f4858", "#7a5c3e"];

/** 去掉零宽字符、统一空白；章节正文与检索文本都走这一套规则。 */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\[\[n:\d+\]\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 生成书籍/知识条目 id。
 * crypto.randomUUID 只在安全上下文可用（旧版 WebView 可能没有），退回 getRandomValues 手写 v4。
 */
export function newId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

/** 由标题生成书籍 id 基底：保留中日韩文字与字母数字，其余压成连字符。 */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** 在已有 id 集合中取唯一 id：同一本书重复导入时追加 -2、-3。 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = base || "book";
  if (!taken.has(root)) return root;
  let counter = 2;
  while (taken.has(root + "-" + counter)) counter += 1;
  return root + "-" + counter;
}

/** 稳定散列取色：同一书名永远同色，不随排序变化。 */
export function coverColorFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return COVER_PALETTE[hash % COVER_PALETTE.length] ?? "#8c2f1b";
}
