import type { Block, Chapter } from "@jusong/core";

/** 本章注释与文内标号之间的映射工具。 */

export interface ChapterNote {
  /** 注释块的 block id（如 p0102）。 */
  blockId: string;
  /** 语料自带的注释序号：0 为无编号的「说明」，1..N 与文内 [[n:N]] 对应。 */
  noteNumber: number;
  /** 显示用编号：noteNumber > 0 时为 "注N"，0 时为 "说明"。 */
  label: string;
  text: string;
}

function noteLabel(noteNumber: number): string {
  return noteNumber > 0 ? "注" + noteNumber : "说明";
}

/** 按文档顺序列出本章注释（含无编号的说明）。 */
export function chapterNotes(chapter: Chapter | null | undefined): ChapterNote[] {
  if (!chapter) return [];
  return chapter.blocks
    .filter((block) => block.kind === "note")
    .map((block) => {
      const noteNumber = typeof block.noteNumber === "number" ? block.noteNumber : 0;
      return {
        blockId: block.id,
        noteNumber,
        label: noteLabel(noteNumber),
        text: block.text,
      };
    });
}

/** 文内引用某条注释的块（第一个包含 [[n:N]] 的块）。 */
export function findNoteMarkerBlock(
  chapter: Chapter | null | undefined,
  noteNumber: number,
): Block | null {
  if (!chapter || noteNumber <= 0) return null;
  const marker = "[[n:" + noteNumber + "]]";
  return chapter.blocks.find((block) => block.text.includes(marker)) ?? null;
}

/** 「注 释」这类小节标题（仅注释栏展示时整节连同注释一起隐藏）。 */
export function isNotesSectionHeading(block: Block): boolean {
  return block.kind !== "note" && /^注\s*释$/.test(block.text.trim());
}
