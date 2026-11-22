import type { TocNode } from "@jusong/core";

export interface FlatChapter {
  chapterId: string;
  title: string;
  volumeTitle?: string;
  sectionTitle?: string;
}

function lastTitleOfType(nodes: TocNode[], type: TocNode["type"]): string | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.type === type) return node.title;
  }
  return undefined;
}

/** Depth-first list of every readable chapter inside a volume/section tree. */
export function flattenChapters(nodes: TocNode[], ancestors: TocNode[] = []): FlatChapter[] {
  const chapters: FlatChapter[] = [];
  for (const node of nodes) {
    const trail = [...ancestors, node];
    if (node.type === "chapter" && node.chapterId) {
      chapters.push({
        chapterId: node.chapterId,
        title: node.title,
        volumeTitle: lastTitleOfType(trail, "volume"),
        sectionTitle: lastTitleOfType(trail, "section"),
      });
    }
    if (node.children && node.children.length > 0) {
      chapters.push(...flattenChapters(node.children, trail));
    }
  }
  return chapters;
}

/** Ancestor trail (volume → section → chapter) for the chapter being read. */
export function findChapterTrail(
  nodes: TocNode[],
  chapterId: string,
  ancestors: TocNode[] = [],
): TocNode[] | null {
  for (const node of nodes) {
    const trail = [...ancestors, node];
    if (node.type === "chapter" && node.chapterId === chapterId) {
      return trail;
    }
    if (node.children && node.children.length > 0) {
      const found = findChapterTrail(node.children, chapterId, trail);
      if (found) return found;
    }
  }
  return null;
}

export function countChapters(nodes: TocNode[]): number {
  return flattenChapters(nodes).length;
}
