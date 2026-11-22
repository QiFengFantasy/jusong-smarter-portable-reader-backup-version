import { useEffect } from "react";
import { Bookmark, BookMarked, List, ScrollText, StickyNote } from "lucide-react";
import type { BookMeta, TocNode } from "@jusong/core";

import type { ChapterNote } from "../../lib/notes";
import { READER_PANE_TITLES } from "../../lib/paneResize";
import { useSettings } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { BookmarkPanel, type BookmarkPanelBindings } from "./BookmarkPanel";
import { ChapterSummaryPanel } from "./ChapterSummaryPanel";
import { KnowledgeSearchPanel } from "./KnowledgeSearchPanel";
import { NotesPanel } from "./NotesPanel";
import { ReaderTabBar, type ReaderTabItem } from "./ReaderTabBar";
import { TocPanel } from "./TocPanel";

export type LeftTab = "toc" | "summary" | "notes" | "knowledge" | "bookmarks";

interface LeftRailProps {
  book: BookMeta | null;
  toc: TocNode[];
  currentChapterId?: string;
  loading: boolean;
  bookId: string;
  chapterId?: string;
  chapterTitle?: string;
  /** 当前标签，由 ReaderPage 控制（注释标号点击需要程序化切换）。 */
  tab: LeftTab;
  onTabChange: (tab: LeftTab) => void;
  onNavigate?: () => void;
  /** 从知识库档案跳到对应章节（导航由 ReaderPage 负责）。 */
  onOpenChapter?: (chapterId: string) => void;
  /** 跳回正文指定块（段落）并显示「回到阅读位置」按钮。 */
  onJumpToBlock?: (blockId: string) => void;
  /** 本章注释（打开注释栏时使用）。 */
  notes: ChapterNote[];
  /** 文内标号点击后要突出显示的注释序号。 */
  activeNoteNumber?: number | null;
  /** 点击注释卡片：跳到引用该注释的正文位置。 */
  onOpenNote?: (note: ChapterNote) => void;
  /** 书签面板数据与动作（由 ReaderPage 注入，与中间面板划词创建共用）。 */
  bookmarks: BookmarkPanelBindings;
  className?: string;
}

/**
 * 阅读器左栏：目录 / 书签 / 摘要 /（注释）/ 知识库。
 *
 * - 目录：卷/节/章树；
 * - 书签：阅读现场列表（页面/文字），底部操作栏负责创建、管理与检索排序；
 * - 摘要：当前章节的一句话概括、历史背景、路线地点与参考来源，可打开原始档案；
 * - 注释：注释栏开关打开时出现，按序号列出本章注释；
 * - 知识库：全书档案检索与列表，点击档案跳到该章摘要。
 */
export function LeftRail({
  book,
  toc,
  currentChapterId,
  loading,
  bookId,
  chapterId,
  chapterTitle,
  tab,
  onTabChange,
  onNavigate,
  onOpenChapter,
  onJumpToBlock,
  notes,
  activeNoteNumber,
  onOpenNote,
  bookmarks,
  className,
}: LeftRailProps) {
  const { settings } = useSettings();
  const notesPanelEnabled = settings.notesPanelEnabled;

  // 注释栏开关关闭时，若当前停在注释标签则退回目录。
  useEffect(() => {
    if (!notesPanelEnabled && tab === "notes") onTabChange("toc");
  }, [notesPanelEnabled, tab, onTabChange]);

  const tabs: ReaderTabItem<LeftTab>[] = [
    { id: "toc", label: "目录", icon: List },
    // 书签紧跟目录：用户确认的顺序为 目录 → 书签 → 摘要 →（注释）→ 知识库。
    { id: "bookmarks" as const, label: "书签", icon: Bookmark },
    { id: "summary", label: "摘要", icon: ScrollText },
    ...(notesPanelEnabled
      ? [{ id: "notes" as const, label: "注释", icon: StickyNote }]
      : []),
    { id: "knowledge" as const, label: "知识库", icon: BookMarked },
  ];

  const openChapterFromKnowledge = (nextChapterId: string) => {
    onTabChange("summary");
    onNavigate?.();
    onOpenChapter?.(nextChapterId);
  };

  const openNote = (note: ChapterNote) => {
    onNavigate?.();
    onOpenNote?.(note);
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <ReaderTabBar<LeftTab>
        ariaLabel={READER_PANE_TITLES.left}
        tabs={tabs}
        active={tab}
        onChange={onTabChange}
        minTabWidth={settings.readerLeftTabMinWidth}
        toolbarSide="left"
      />

      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === "toc" ? (
          <TocPanel
            book={book}
            toc={toc}
            currentChapterId={currentChapterId}
            loading={loading}
            onNavigate={onNavigate}
            className="h-full"
            showHeader={false}
          />
        ) : null}

        {tab === "summary" ? (
          <ChapterSummaryPanel
            bookId={bookId}
            chapterId={chapterId}
            chapterTitle={chapterTitle}
            onJumpToBlock={onJumpToBlock}
          />
        ) : null}

        {tab === "notes" && notesPanelEnabled ? (
          <NotesPanel
            notes={notes}
            chapterTitle={chapterTitle}
            activeNoteNumber={activeNoteNumber}
            onOpenNote={openNote}
          />
        ) : null}

        {tab === "knowledge" ? (
          <KnowledgeSearchPanel
            bookId={bookId}
            bookTitle={book?.title}
            onOpenChapter={openChapterFromKnowledge}
          />
        ) : null}

        {tab === "bookmarks" ? <BookmarkPanel {...bookmarks} /> : null}
      </div>
    </div>
  );
}
