/** 书库核心类型：UI 与各端存储适配器共用。 */

export type BookFormat = "epub" | "pdf" | "txt" | "mobi" | "seed";
export type TocNodeType = "volume" | "section" | "chapter";
export type BlockKind = "heading" | "paragraph" | "quote" | "note";
export type KnowledgeType =
  | "legacy-article"
  | "legacy-topic"
  | "search"
  | "note"
  | "place"
  | "timeline";

export interface BookMeta {
  id: string;
  title: string;
  author?: string;
  publisher?: string;
  format: BookFormat;
  sourceName?: string;
  importedAt: string;
  volumeCount: number;
  chapterCount: number;
  description?: string;
  coverColor?: string;
  /** 用户库内封面文件名（相对书籍目录，如 "cover.jpg"）；没有封面时缺省。 */
  coverFile?: string;
  /** 封面 MIME（如 "image/jpeg"）；与 coverFile 成对出现。 */
  coverMime?: string;
  /** 解析状态：EPUB 解析书为 parsed；mobi/pdf/txt 原始文件书为 pending（无章节，待后续解析）。 */
  parseState?: "parsed" | "pending";
  /** 原文件字节数（存在 source/ 时记录）。 */
  sourceSize?: number;
}

export interface TocNode {
  id: string;
  type: TocNodeType;
  title: string;
  order: number;
  chapterId?: string;
  children?: TocNode[];
}

export interface Block {
  id: string;
  kind: BlockKind;
  text: string;
  noteNumber?: number;
}

export interface Chapter {
  id: string;
  bookId: string;
  title: string;
  volumeId?: string;
  sectionId?: string;
  blocks: Block[];
  sourceHref?: string;
}

export interface KnowledgeEntry {
  id: string;
  bookId: string;
  chapterId?: string;
  type: KnowledgeType;
  title: string;
  body: string;
  createdAt: string;
  payload?: unknown;
}

export interface SearchHit {
  bookId: string;
  chapterId: string;
  chapterTitle: string;
  snippet: string;
  score?: number;
}

/** 全局检索选项：requestId 用于进度事件过滤与取消；limit 默认 100、夹在 1..=200。 */
export interface SearchOptions {
  requestId: string;
  limit?: number;
  /**
   * 本次覆盖的书籍集合（有序 bookId）。
   * 缺省表示全库；高级检索会按「最近阅读优先」逐步扩大这个集合。
   */
  bookIds?: string[];
  /** 是否同时做书名/作者的全库检索（默认 true；查找更多时置 false，避免重复全库扫描）。 */
  includeBookLevel?: boolean;
  /** 只检索知识库（档案 + 摘要），跳过章节正文（知识库检索专用）。 */
  knowledgeOnly?: boolean;
}

/** 全局检索命中：书名 / 作者 / 正文章节 / 知识库档案（含章节摘要）。 */
export type GlobalSearchKind = "book" | "author" | "chapter" | "knowledge";

export interface GlobalSearchHit {
  kind: GlobalSearchKind;
  bookId: string;
  bookTitle: string;
  /** 作者命中时返回被匹配的作者名。 */
  author?: string;
  chapterId?: string;
  chapterTitle?: string;
  entryId?: string;
  title: string;
  snippet: string;
}

/** 最近阅读条目（颗粒度为书籍，按 openedAt 倒序）。 */
export interface RecentBook {
  bookId: string;
  title: string;
  author?: string;
  /** ISO 时间戳。 */
  openedAt: string;
}

/** 书签记录的面板现场：恢复时还原左右面板开合与当前 tab。 */
export interface BookmarkPanels {
  leftOpen: boolean;
  rightOpen: boolean;
  /** 知识（左）面板当前 tab：toc / summary / notes / knowledge / bookmarks。 */
  leftTab: string;
  /** 探索（右）面板当前 tab：map / timeline / agent。 */
  rightTab: string;
}

/**
 * 阅读书签：页面级（滚动位置）或文字段级（blockId + 选中文字）。
 * 存用户库 `bookmarks.json`（Rust 原子写）；首页知识统计计入书签数，
 * 但不作为知识库条目出现，阅读器知识面板也不显示。
 */
export interface Bookmark {
  id: string;
  bookId: string;
  bookTitle?: string;
  chapterId: string;
  chapterTitle?: string;
  /** 章节内滚动位置（px）。 */
  scrollTop: number;
  /** 正文块 id（从选中文字创建时记录）。 */
  blockId?: string;
  /** 选中文字（文字段书签）；页面级书签缺省。 */
  quote?: string;
  /** 选中文字在 block 纯文本中的起始偏移（UTF-16 code unit）；旧书签缺省。 */
  quoteStart?: number;
  /** 选中文字在 block 纯文本中的结束偏移（UTF-16 code unit）；旧书签缺省。 */
  quoteEnd?: number;
  /** 手动排序序号；缺省表示未参与手动排序（回退 createdAt）。 */
  order?: number;
  title: string;
  note?: string;
  panels: BookmarkPanels;
  createdAt: string;
  updatedAt: string;
}

export type BookmarkInput = Omit<Bookmark, "id" | "createdAt" | "updatedAt">;

export interface BookmarkPatch {
  title?: string;
  note?: string;
  /** 手动排序序号（拖拽排序时批量写入）。 */
  order?: number;
}

/** 书签手动排序项：id + 目标序号。 */
export interface BookmarkOrder {
  id: string;
  order: number;
}

/** 单章探索数据：地图/时间线的章节投影（事实源仍是 shared/topics）。 */
export interface ChapterExploreFocus {
  lon: number;
  lat: number;
  zoom?: number;
}

export interface ChapterExploreMap {
  placeIds: string[];
  routeIds: string[];
  themeIds: string[];
  focus: ChapterExploreFocus | null;
}

export interface ChapterExplore {
  schemaVersion: 1;
  bookId: string;
  chapterId: string;
  map: ChapterExploreMap | null;
  timeline: { eventIds: string[] } | null;
}

/** 书籍导出统计：导入/导出页展示用。 */
export interface BookTransferInfo {
  bookId: string;
  title: string;
  author?: string;
  publisher?: string;
  format: string;
  sourceName?: string;
  sourceSize: number;
  /** 解析包（zip）预计字节数。 */
  packageSize: number;
  chapterCount: number;
  archiveCount: number;
  digestCount: number;
  parseState?: "parsed" | "pending";
}

export interface ExportResult {
  files: Array<{ path: string; bytes: number }>;
}

/** 导入/导出进度事件 payload（Tauri 事件 `library-transfer-progress`）。 */
export interface TransferProgress {
  requestId: string;
  direction: "import" | "export";
  phase: "copy" | "zip" | "unzip" | "validate" | "encrypt" | "decrypt";
  current: number;
  total: number;
  message: string;
}

export interface DigestCitation {
  paragraphId: string;
  quote: string;
  section?: string;
}

export interface DigestPoint {
  section: string;
  title?: string;
  text: string;
  citations: DigestCitation[];
}

/**
 * 章节分析摘要：后续按节动态分析的最小输入。
 * 存档在 knowledge/digests/，避免每次把整章正文发送给模型。
 */
export interface ChapterDigest {
  schemaVersion: 1;
  bookId: string;
  chapterId: string;
  title: string;
  generatedAt: string;
  source: "legacy-analysis" | "import-structure" | "dynamic-analysis";
  stats: {
    charCount: number;
    paragraphCount: number;
    headingCount: number;
    noteCount: number;
  };
  headings: string[];
  opening: string;
  closing: string;
  keyPoints: DigestPoint[];
  writing?: { date?: string; placeName?: string; placeIds?: string[] };
  themes?: string[];
  map?: { placeIds?: string[]; routeIds?: string[] };
  note?: string;
}

/** 章节资产标记：用于判断某章哪些数据尚未生成。 */
export interface ChapterAssets {
  hasContent: boolean;
  hasDigest: boolean;
  hasDossier: boolean;
  hasMap: boolean;
  hasNotes: boolean;
}

/** 整书专题数据（地图/时间线），由存储实现读取原始 JSON。 */
export interface BookTopics {
  map: unknown | null;
  timeline: unknown | null;
}

/** AGENT 构建写入的单章探索投影（合并到 `chapters/<id>/explore.json`）。 */
export interface AgentExploreWrite {
  chapterId: string;
  map?: {
    placeIds: string[];
    routeIds: string[];
    themeIds: string[];
    focus: { lon: number; lat: number; zoom?: number } | null;
  } | null;
  timeline?: { eventIds: string[] } | null;
}

/** AGENT 构建写入的整书专题：map/timeline 为 `shared/topics/*.json` 形态，可为 null。 */
export interface AgentKnowledgeWrite {
  map?: unknown | null;
  timeline?: unknown | null;
  explores: AgentExploreWrite[];
}

/** `applyAgentKnowledge` 写入结果：新增地点数 / 事件数 / 写入的探索章节数。 */
export interface AgentKnowledgeWriteResult {
  places: number;
  events: number;
  explores: number;
}

export interface Library {
  init(): Promise<void>;
  listBooks(): Promise<BookMeta[]>;
  getBook(bookId: string): Promise<BookMeta | null>;
  getToc(bookId: string): Promise<TocNode[]>;
  getChapter(bookId: string, chapterId: string): Promise<Chapter | null>;
  importEpub(input: { name: string; buffer: ArrayBuffer; path?: string }): Promise<BookMeta>;
  search(bookId: string, query: string, limit?: number): Promise<SearchHit[]>;
  /**
   * 全局检索：Rust 每次请求现扫用户库磁盘（不建索引）；同一 requestId 可取消。
   * 进度经 `library-search-progress` 事件回报（payload 含 requestId/scanned/total/done）。
   */
  searchAll(query: string, options: SearchOptions): Promise<GlobalSearchHit[]>;
  /**
   * 知识库检索（独立调度接口）：只扫档案与章节摘要，不扫章节正文。
   * 分组、分档扩大与取消语义与 searchAll 一致。
   */
  searchKnowledge(query: string, options: SearchOptions): Promise<GlobalSearchHit[]>;
  /** 取消进行中的检索（Rust 在下一个章节/档案条目后停止并返回已收集结果）。 */
  cancelSearch(requestId: string): Promise<void>;
  /** 最近阅读清单（按最近打开时间倒序；书籍颗粒度）。 */
  getRecentBooks(): Promise<RecentBook[]>;
  /** 记录一次阅读（打开阅读器时调用；Rust 原子写用户库 recent.json）。 */
  recordRecentBook(bookId: string): Promise<void>;
  /** 书籍封面图片二进制；没有封面时返回 null。 */
  getBookCover(bookId: string): Promise<ArrayBuffer | null>;
  /** 书签列表：传 bookId 时只返回该书；缺省返回全部（首页统计用）。 */
  listBookmarks(bookId?: string): Promise<Bookmark[]>;
  /** 新增书签（id/时间由 Rust 生成）。 */
  addBookmark(input: BookmarkInput): Promise<Bookmark>;
  /** 更新书签标题/备注。 */
  updateBookmark(id: string, patch: BookmarkPatch): Promise<Bookmark>;
  /** 删除书签。 */
  deleteBookmark(id: string): Promise<void>;
  /** 批量删除书签（一次写盘、幂等）。 */
  deleteBookmarks(ids: string[]): Promise<void>;
  /** 批量写入手动排序序号（一次写盘）。 */
  updateBookmarkOrders(bookId: string, orders: BookmarkOrder[]): Promise<void>;
  /** 单章探索数据（地图地点/路线、时间线事件引用）；缺失返回 null。 */
  getChapterExplore(bookId: string, chapterId: string): Promise<ChapterExplore | null>;
  /** 导入原始文件（mobi/pdf/txt 不解析，建最小书籍目录并标 pending）。 */
  importOriginalBook(path: string): Promise<BookMeta>;
  /** 导入解析包（zip，包含 book.json 与书籍目录）。 */
  importPackage(path: string): Promise<BookMeta>;
  /** 导出统计：原文件大小、解析包预计大小、章节/档案/摘要数。 */
  getBookTransferInfo(bookId: string): Promise<BookTransferInfo>;
  /** 导出原文件 / 解析包 / 全部（原文件+解析包两个文件）。 */
  exportBook(
    bookId: string,
    mode: "original" | "package" | "all",
    destination: string,
  ): Promise<ExportResult>;
  addKnowledge(entry: Omit<KnowledgeEntry, "id" | "createdAt">): Promise<KnowledgeEntry>;
  /**
   * AGENT 构建写入：合并整书地图/时间线专题与各章探索投影（Rust 原子写、按 id 去重）。
   * place/timeline 知识条目仍走 `addKnowledge`。
   */
  applyAgentKnowledge(
    bookId: string,
    payload: AgentKnowledgeWrite,
  ): Promise<AgentKnowledgeWriteResult>;
  listKnowledge(bookId: string, chapterId?: string): Promise<KnowledgeEntry[]>;
  getKnowledge(bookId: string, entryId: string): Promise<KnowledgeEntry | null>;
  /** 章节分析摘要：优先读存档；没有时由实现惰性生成。 */
  getChapterDigest(bookId: string, chapterId: string): Promise<ChapterDigest | null>;
  listChapterDigests(bookId: string): Promise<ChapterDigest[]>;
  saveChapterDigest(digest: ChapterDigest): Promise<void>;
  /** 可选：当前章节已有/缺失的数据，用于空态提示与「生成」入口。 */
  getChapterAssets?(bookId: string, chapterId: string): Promise<ChapterAssets>;
  /** 可选：整书专题数据；Tauri 运行时由 Rust Content API 读取。 */
  getBookTopics?(bookId: string): Promise<BookTopics>;
  /** 可选：运行期能力信息（检索模式、索引章节数等）。 */
  getCapabilities?(): Promise<LibraryCapabilities>;
}

/** 全文检索模式：FTS5（构建支持时）或普通表 + LIKE 降级。 */
export type SearchMode = "fts5" | "like";

/**
 * 运行期诊断信息：不属于 Library 核心契约，供调试/设置页显示。
 */
export interface LibraryCapabilities {
  searchMode: SearchMode;
  fts5Available: boolean;
  /** 已建立检索索引的章节数（全部书籍合计）。 */
  indexedChapters: number;
}
