import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BookmarkPlus,
  BookOpen,
  CalendarArrowDown,
  CalendarArrowUp,
  GripVertical,
  ListOrdered,
  Pencil,
  Quote,
  Search,
  SlidersHorizontal,
  Square,
  SquareCheck,
  StickyNote,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Bookmark, BookmarkOrder, BookmarkPatch } from "@jusong/core";

import { cn, formatDateTime, getErrorMessage } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/** 书签排序方式：手动排序 / 时间倒序 / 时间正序 / 章节顺序（管理模式下循环切换）。 */
export type BookmarkSort = "manual" | "newest" | "oldest" | "chapter";

const SORT_CYCLE: readonly BookmarkSort[] = ["manual", "newest", "oldest", "chapter"];

interface SortMeta {
  label: string;
  icon: LucideIcon;
  hint: string;
}

const SORT_META: Record<BookmarkSort, SortMeta> = {
  manual: { label: "手动排序", icon: ListOrdered, hint: "拖拽卡片右侧手柄调整顺序" },
  newest: { label: "时间倒序", icon: CalendarArrowDown, hint: "最新创建的在前" },
  oldest: { label: "时间正序", icon: CalendarArrowUp, hint: "最早创建的在前" },
  chapter: { label: "章节顺序", icon: BookOpen, hint: "按目录章节顺序排列" },
};

function nextSort(sort: BookmarkSort): BookmarkSort {
  const index = SORT_CYCLE.indexOf(sort);
  return SORT_CYCLE[(index + 1) % SORT_CYCLE.length];
}

/** 顶部内栏的圆形纯色图标按钮（管理操作）。 */
const circleButtonClassName =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cinnabar text-paper-soft shadow-sm transition-colors hover:bg-cinnabar/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40 focus-visible:ring-offset-1 focus-visible:ring-offset-paper disabled:pointer-events-none disabled:bg-ink-soft/25 disabled:text-paper-soft/70";

/** 轻提示：创建/管理操作的结果（显示在底部操作栏上方，2~3 秒后自动消失）。 */
export interface BookmarkNotice {
  text: string;
  tone: "success" | "error";
}

/** ReaderPage 传给 LeftRail → BookmarkPanel 的书签能力集合（数据 + 阅读器侧动作）。 */
export interface BookmarkPanelBindings {
  items: Bookmark[];
  loading: boolean;
  error: string | null;
  notice: BookmarkNotice | null;
  /** 刚刚新增的书签 id：列表项短暂高亮。 */
  highlightId: string | null;
  /** chapterId → 目录顺序，用于「章节顺序」排序。 */
  chapterOrder: ReadonlyMap<string, number>;
  /** 正在保存（禁用「添加书签」避免重复提交）。 */
  creating: boolean;
  /** 当前是否可创建（章节已载入）。 */
  canCreate: boolean;
  onReload: () => void;
  onAdd: () => void;
  onOpen: (bookmark: Bookmark) => void;
  onUpdate: (id: string, patch: BookmarkPatch) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /**
   * 批量删除（一次写盘）。缺省时回退为逐条 `onDelete`，保证 ReaderPage 未接线前也能用。
   * lead 接线：`onDeleteMany: (ids) => bookmarkStore.removeMany(ids)`。
   */
  onDeleteMany?: (ids: string[]) => Promise<void>;
  /**
   * 批量写入手动排序（一次写盘）。缺省时回退为逐条 `onUpdate(id, { order })`。
   * lead 接线：`onUpdateOrders: (orders) => bookmarkStore.updateOrders(orders)`。
   */
  onUpdateOrders?: (orders: BookmarkOrder[]) => Promise<void>;
}

interface BookmarkPanelProps extends BookmarkPanelBindings {
  className?: string;
}

type BookmarkDialog =
  | { kind: "rename"; bookmark: Bookmark; value: string }
  | { kind: "note"; bookmark: Bookmark; value: string }
  | { kind: "delete"; ids: string[]; titles: string[] };

/** 拖拽排序状态：beforeId=null 表示拖到列表末尾。 */
interface DragState {
  id: string;
  beforeId: string | null;
  moved: boolean;
  pointerId: number;
}

/** 书签在列表里的匹配文本（搜索：标题/备注/章节/选中文字）。 */
function matchesQuery(bookmark: Bookmark, query: string): boolean {
  if (!query) return true;
  return [bookmark.title, bookmark.note, bookmark.chapterTitle, bookmark.quote].some(
    (value) => typeof value === "string" && value.toLowerCase().includes(query),
  );
}

function compareCreatedAt(a: Bookmark, b: Bookmark): number {
  const diff = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  return diff !== 0 ? diff : a.id.localeCompare(b.id);
}

/**
 * 手动排序：`order` 缺省时回退 createdAt；有 order 的排在无 order 的前面。
 * pendingOrders 是拖拽后的乐观覆盖，优先级高于后端返回值。
 */
function manualSort(
  items: Bookmark[],
  pendingOrders: Record<string, number> | null,
): Bookmark[] {
  const orderOf = (bookmark: Bookmark) => pendingOrders?.[bookmark.id] ?? bookmark.order;
  return [...items].sort((a, b) => {
    const orderA = orderOf(a);
    const orderB = orderOf(b);
    if (orderA !== undefined && orderB !== undefined) {
      if (orderA !== orderB) return orderA - orderB;
      return compareCreatedAt(a, b);
    }
    if (orderA !== undefined) return -1;
    if (orderB !== undefined) return 1;
    return compareCreatedAt(a, b);
  });
}

/**
 * 阅读器左栏「书签」面板。
 *
 * - 常规模式：卡片点击跳转，无右侧 ⋯ 菜单；底部「添加书签 / 管理书签」。
 * - 管理模式：点卡片=切换选中（不跳转）；顶部内栏一行圆形纯色图标按钮
 *   （排序循环 / 全选 / 重命名 / 删除 / 退出），搜索框保留；manual 排序下卡片右侧
 *   有 GripVertical 拖拽手柄，拖拽后批量写 `order`（乐观更新，失败回滚）。
 * - 重命名仅选中 1 条可用；删除支持多选 + 二次确认（批量一次写盘）。
 * - 进入管理默认手动排序；退出管理清空搜索、选中与拖拽状态。
 *
 * 面板本身不直接读写书库：数据与写操作由 ReaderPage 通过 bindings 注入，
 * 这样中间面板的划词创建和这里「添加书签」共用同一份列表与提示状态。
 */
export function BookmarkPanel({
  items,
  loading,
  error,
  notice,
  highlightId,
  chapterOrder,
  creating,
  canCreate,
  onReload,
  onAdd,
  onOpen,
  onUpdate,
  onDelete,
  onDeleteMany,
  onUpdateOrders,
  className,
}: BookmarkPanelProps) {
  const [manage, setManage] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<BookmarkSort>("newest");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [dialog, setDialog] = useState<BookmarkDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingOrders, setPendingOrders] = useState<Record<string, number> | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const dragStartYRef = useRef(0);

  const closeDialog = useCallback(() => {
    if (dialogBusy) return;
    setDialog(null);
    setDialogError(null);
  }, [dialogBusy]);

  const openDialog = useCallback((next: BookmarkDialog) => {
    setDialogError(null);
    setDialog(next);
  }, []);

  const exitManage = useCallback(() => {
    setManage(false);
    setSearch("");
    setSort("newest");
    setSelectedIds(new Set());
    setPendingOrders(null);
    setDrag(null);
    setActionError(null);
    setDialog(null);
    setDialogError(null);
  }, []);

  const enterManage = useCallback(() => {
    setManage(true);
    setSort("manual");
    setSearch("");
    setSelectedIds(new Set());
    setActionError(null);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    // 搜索条件变化后旧选中可能被筛掉：直接清空，避免误删看不见的条目。
    setSelectedIds(new Set());
  }, []);

  const visible = useMemo(() => {
    const query = search.replace(/\s+/g, " ").trim().toLowerCase();
    const filtered = query ? items.filter((item) => matchesQuery(item, query)) : items;
    if (sort === "manual") return manualSort(filtered, pendingOrders);
    const ordered = [...filtered];
    ordered.sort((a, b) => {
      if (sort === "chapter") {
        const orderA = chapterOrder.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER;
        const orderB = chapterOrder.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        const byScroll = (a.scrollTop ?? 0) - (b.scrollTop ?? 0);
        if (byScroll !== 0) return byScroll;
        return compareCreatedAt(a, b);
      }
      return sort === "newest" ? compareCreatedAt(b, a) : compareCreatedAt(a, b);
    });
    return ordered;
  }, [items, search, sort, chapterOrder, pendingOrders]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  );
  const allVisibleSelected =
    visible.length > 0 && visible.every((item) => selectedIds.has(item.id));
  const renameTarget = selectedItems.length === 1 ? selectedItems[0] : null;

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const everyVisibleSelected =
        visible.length > 0 && visible.every((item) => next.has(item.id));
      if (everyVisibleSelected) {
        visible.forEach((item) => next.delete(item.id));
      } else {
        visible.forEach((item) => next.add(item.id));
      }
      return next;
    });
  }, [visible]);

  const cycleSort = useCallback(() => setSort((current) => nextSort(current)), []);

  const openRenameDialog = useCallback(() => {
    if (selectedItems.length !== 1) return;
    const target = selectedItems[0];
    openDialog({ kind: "rename", bookmark: target, value: target.title });
  }, [selectedItems, openDialog]);

  const openNoteDialog = useCallback(() => {
    if (selectedItems.length !== 1) return;
    const target = selectedItems[0];
    openDialog({ kind: "note", bookmark: target, value: target.note ?? "" });
  }, [selectedItems, openDialog]);

  const openDeleteDialog = useCallback(() => {
    if (selectedItems.length === 0) return;
    openDialog({
      kind: "delete",
      ids: selectedItems.map((item) => item.id),
      titles: selectedItems.map((item) => item.title),
    });
  }, [selectedItems, openDialog]);

  const saveRename = useCallback(async () => {
    if (dialog?.kind !== "rename") return;
    const title = dialog.value.trim();
    if (!title) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await onUpdate(dialog.bookmark.id, { title });
      setDialog(null);
    } catch (reason: unknown) {
      setDialogError(getErrorMessage(reason));
    } finally {
      setDialogBusy(false);
    }
  }, [dialog, onUpdate]);

  const saveNote = useCallback(async () => {
    if (dialog?.kind !== "note") return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      // 空字符串表示清除备注（Rust 端按字段写入）。
      await onUpdate(dialog.bookmark.id, { note: dialog.value.trim() });
      setDialog(null);
    } catch (reason: unknown) {
      setDialogError(getErrorMessage(reason));
    } finally {
      setDialogBusy(false);
    }
  }, [dialog, onUpdate]);

  const confirmDelete = useCallback(async () => {    if (dialog?.kind !== "delete") return;
    const ids = dialog.ids;
    const removed = new Set(ids);
    setDialogBusy(true);
    setDialogError(null);
    try {
      if (onDeleteMany) {
        await onDeleteMany(ids);
      } else {
        for (const id of ids) await onDelete(id);
      }
      setDialog(null);
      setSelectedIds((current) => {
        const next = new Set(current);
        removed.forEach((id) => next.delete(id));
        return next;
      });
      setActionError(null);
    } catch (reason: unknown) {
      setDialogError(getErrorMessage(reason));
    } finally {
      setDialogBusy(false);
    }
  }, [dialog, onDelete, onDeleteMany]);

  /** 拖拽落点提交：把拖拽项插到 beforeId 前（null=末尾），批量写全量 order。 */
  const commitOrder = useCallback(
    async (draggedId: string, beforeId: string | null) => {
      const ordered = manualSort(items, pendingOrders);
      const dragged = ordered.find((item) => item.id === draggedId);
      if (!dragged) return;
      const rest = ordered.filter((item) => item.id !== draggedId);
      const targetIndex = beforeId ? rest.findIndex((item) => item.id === beforeId) : -1;
      const next = [...rest];
      next.splice(targetIndex >= 0 ? targetIndex : next.length, 0, dragged);
      const changed = next.some((item, index) => ordered[index]?.id !== item.id);
      if (!changed) {
        setPendingOrders(null);
        return;
      }
      const orders: BookmarkOrder[] = next.map((item, index) => ({
        id: item.id,
        order: index,
      }));
      // 乐观更新：先按新顺序渲染，再等后端写盘结果。
      setPendingOrders(Object.fromEntries(orders.map((entry) => [entry.id, entry.order])));
      setActionError(null);
      try {
        if (onUpdateOrders) {
          await onUpdateOrders(orders);
        } else {
          for (const entry of orders) await onUpdate(entry.id, { order: entry.order });
        }
        setPendingOrders(null);
      } catch (reason: unknown) {
        setPendingOrders(null);
        setActionError(`排序保存失败：${getErrorMessage(reason)}`);
      }
    },
    [items, pendingOrders, onUpdate, onUpdateOrders],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, bookmarkId: string) => {
      if (!manage || sort !== "manual") return;
      event.preventDefault();
      event.stopPropagation();
      dragStartYRef.current = event.clientY;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ id: bookmarkId, beforeId: null, moved: false, pointerId: event.pointerId });
    },
    [manage, sort],
  );

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const cards = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>("[data-bookmark-item]") ?? [],
      );
      let beforeId: string | null = null;
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        if (event.clientY < rect.top + rect.height / 2) {
          beforeId = card.dataset.bookmarkItem ?? null;
          break;
        }
      }
      const moved = drag.moved || Math.abs(event.clientY - dragStartYRef.current) > 4;
      if (moved === drag.moved && beforeId === drag.beforeId) return;
      setDrag({ ...drag, moved, beforeId });
    },
    [drag],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // 指针已被系统取消时 release 会抛错：忽略，状态仍会清空。
      }
      const { id, beforeId, moved } = drag;
      setDrag(null);
      if (moved && beforeId !== id) void commitOrder(id, beforeId);
    },
    [drag, commitOrder],
  );

  const cancelDrag = useCallback(() => setDrag(null), []);

  // 列表增删后修剪已不存在的选中项（避免批量操作带上幽灵 id）。
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const existing = new Set(items.map((item) => item.id));
      let changed = false;
      const next = new Set<string>();
      current.forEach((id) => {
        if (existing.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : current;
    });
  }, [items]);

  // 正在编辑/删除的条目被外部删除时关掉弹窗，避免停留在陈旧记录上。
  useEffect(() => {
    if (!dialog || dialogBusy) return;
    const existing = new Set(items.map((item) => item.id));
    if (dialog.kind === "delete") {
      if (!dialog.ids.some((id) => existing.has(id))) {
        setDialog(null);
        setDialogError(null);
      }
      return;
    }
    if (!existing.has(dialog.bookmark.id)) {
      setDialog(null);
      setDialogError(null);
    }
  }, [items, dialog, dialogBusy]);

  const noticeTone = notice?.tone === "error" ? "text-red-700" : "text-cinnabar";
  const sortMeta = SORT_META[sort];
  const nextSortMeta = SORT_META[nextSort(sort)];
  const sortTitle = `排序：${sortMeta.label}（${sortMeta.hint}）；点击切换为${nextSortMeta.label}`;
  const SortIcon = sortMeta.icon;
  const canDrag = manage && sort === "manual";

  return (
    <div data-bookmark-panel="true" className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-baseline justify-between gap-2 px-4 pb-1 pt-3">
        <h2 className="font-serif text-sm font-semibold tracking-[0.28em] text-ink-soft">书签</h2>
        <span className="text-[11px] text-ink-soft/60">共 {items.length} 条</span>
      </div>

      {/* 顶部内栏：管理模式下固定显示（搜索 + 一行圆形纯色图标按钮）。 */}
      {manage ? (
        <div
          data-bookmark-manage="true"
          className="shrink-0 border-b border-border/70 bg-paper-soft/70 px-2 py-2"
        >
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-soft/50"
                aria-hidden="true"
              />
              <Input
                data-bookmark-search="true"
                aria-label="搜索书签"
                placeholder="搜索标题 / 备注 / 章节 / 文字"
                value={search}
                onChange={(event) => handleSearchChange(event.target.value)}
                className="h-8 pl-7 pr-2 text-xs"
              />
            </div>
            <button
              type="button"
              data-bookmark-manage-exit="true"
              aria-label="退出管理"
              title="退出管理（清空搜索与选中）"
              onClick={exitManage}
              className={cn(circleButtonClassName, "bg-ink-soft/80 hover:bg-ink-soft")}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          <div role="toolbar" aria-label="书签管理操作" className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              data-bookmark-sort-cycle={sort}
              aria-label={sortTitle}
              title={sortTitle}
              onClick={cycleSort}
              className={circleButtonClassName}
            >
              <SortIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-bookmark-select-all="true"
              aria-pressed={allVisibleSelected}
              aria-label={allVisibleSelected ? "取消全选当前筛选结果" : "全选当前筛选结果"}
              title={
                allVisibleSelected
                  ? `取消全选当前筛选结果（${visible.length} 条）`
                  : `全选当前筛选结果（${visible.length} 条）`
              }
              onClick={toggleSelectAll}
              disabled={visible.length === 0}
              className={circleButtonClassName}
            >
              {allVisibleSelected ? (
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <SquareCheck className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              data-bookmark-rename="true"
              aria-label="重命名选中的书签"
              title={
                renameTarget
                  ? `重命名「${renameTarget.title}」`
                  : "先选中 1 条书签再重命名"
              }
              onClick={openRenameDialog}
              disabled={!renameTarget}
              className={circleButtonClassName}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-bookmark-note="true"
              aria-label="编辑选中书签的备注"
              title={
                renameTarget
                  ? renameTarget.note
                    ? `编辑「${renameTarget.title}」的备注`
                    : `为「${renameTarget.title}」添加备注`
                  : "先选中 1 条书签再编辑备注"
              }
              onClick={openNoteDialog}
              disabled={!renameTarget}
              className={circleButtonClassName}
            >
              <StickyNote className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-bookmark-delete="true"
              aria-label="删除选中的书签"
              title={
                selectedItems.length > 0
                  ? `删除选中的 ${selectedItems.length} 条书签`
                  : "先选中书签再删除"
              }
              onClick={openDeleteDialog}
              disabled={selectedItems.length === 0}
              className={cn(circleButtonClassName, "bg-red-700 hover:bg-red-700/90")}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <span className="ml-auto text-[10px] text-ink-soft/70">
              已选 {selectedItems.length}/{visible.length}
            </span>
          </div>

          {actionError ? (
            <p role="alert" className="mt-1.5 text-[11px] leading-5 text-red-700">
              {actionError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        ref={listRef}
        data-bookmark-list="true"
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1"
      >
        {loading ? (
          <p className="px-1 py-8 text-center text-xs text-ink-soft">正在加载书签…</p>
        ) : null}

        {!loading && error ? (
          <div className="mx-1 my-3 rounded-md border border-dashed border-border bg-paper-soft/50 px-4 py-6 text-center text-xs leading-6 text-ink-soft">
            <p className="text-red-700">读取书签失败：{error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              data-bookmark-retry="true"
              onClick={onReload}
            >
              重新读取
            </Button>
          </div>
        ) : null}

        {!loading && !error && visible.length === 0 ? (
          <div className="mx-1 my-3 rounded-md border border-dashed border-border/80 px-4 py-8 text-center text-xs leading-6 text-ink-soft">
            {search.trim() ? (
              <span>没有匹配的书签。</span>
            ) : (
              <span>
                还没有书签。
                <br />
                阅读时点左下角「创建书签」，或点下方「添加书签」。
              </span>
            )}
          </div>
        ) : null}

        {!loading && !error
          ? visible.map((bookmark) => {
              const selected = manage && selectedIds.has(bookmark.id);
              const highlighted = !manage && bookmark.id === highlightId;
              const dropBefore =
                drag?.moved && drag.id !== bookmark.id && drag.beforeId === bookmark.id;
              const dragging = drag?.id === bookmark.id && drag.moved;
              return (
                <div
                  key={bookmark.id}
                  role="button"
                  tabIndex={0}
                  data-bookmark-item={bookmark.id}
                  data-bookmark-kind={bookmark.quote ? "text" : "page"}
                  data-bookmark-selected={manage ? (selected ? "true" : "false") : undefined}
                  data-bookmark-dragging={dragging ? "true" : undefined}
                  aria-pressed={manage ? selected : undefined}
                  aria-label={
                    manage ? `选择书签：${bookmark.title}` : `书签：${bookmark.title}`
                  }
                  onClick={() => {
                    if (manage) toggleSelect(bookmark.id);
                    else onOpen(bookmark);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    if (manage) toggleSelect(bookmark.id);
                    else onOpen(bookmark);
                  }}
                  className={cn(
                    "group relative mb-2 w-full cursor-pointer rounded-md border bg-paper/70 p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30",
                    canDrag ? "pr-10" : "pr-3",
                    selected
                      ? "border-cinnabar/70 bg-cinnabar/10 ring-1 ring-cinnabar/40"
                      : "border-border/80 hover:border-cinnabar/40 hover:bg-paper-soft",
                    highlighted && "border-cinnabar/60 bg-cinnabar/5 ring-1 ring-cinnabar/30",
                    dragging && "opacity-60",
                  )}
                >
                  {dropBefore ? (
                    <span
                      className="pointer-events-none absolute -top-1 left-1 right-1 h-0.5 rounded-full bg-cinnabar"
                      aria-hidden="true"
                    />
                  ) : null}

                  <p className="truncate font-serif text-sm font-semibold tracking-wide text-ink">
                    {bookmark.title}
                  </p>

                  {bookmark.note ? (
                    <p className="mt-1 line-clamp-2 break-words text-[11px] leading-5 text-ink-soft">
                      备注：{bookmark.note}
                    </p>
                  ) : null}

                  {bookmark.quote ? (
                    <p className="mt-1.5 line-clamp-2 break-words border-l-2 border-cinnabar/40 pl-2 text-[11px] leading-5 text-ink-soft/85">
                      <Quote className="mr-0.5 inline h-2.5 w-2.5 align-[-1px]" aria-hidden="true" />
                      {bookmark.quote}
                    </p>
                  ) : null}

                  <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-ink-soft/70">
                    <span className="max-w-full truncate">
                      {bookmark.chapterTitle ?? "未知章节"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="shrink-0">{formatDateTime(bookmark.createdAt)}</span>
                    <span className="ml-auto shrink-0 rounded-sm border border-border/70 px-1 py-px text-[9px] tracking-wider text-ink-soft/70">
                      {bookmark.quote ? "文字" : "页面"}
                    </span>
                  </p>

                  {canDrag ? (
                    <button
                      type="button"
                      data-bookmark-handle={bookmark.id}
                      aria-label="拖拽调整书签顺序"
                      title="按住拖动调整顺序"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => startDrag(event, bookmark.id)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={cancelDrag}
                      className="absolute right-1.5 top-1/2 inline-flex h-8 w-7 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-md text-ink-soft/60 transition-colors hover:bg-muted/70 hover:text-ink active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/40"
                    >
                      <GripVertical className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              );
            })
          : null}

        {!loading && !error && drag?.moved && drag.beforeId === null ? (
          <div
            data-bookmark-drop-end="true"
            className="mx-1 mb-2 h-0.5 rounded-full bg-cinnabar"
            aria-hidden="true"
          />
        ) : null}
      </div>

      {notice ? (
        <p
          role="status"
          data-bookmark-notice={notice.tone}
          className={cn(
            "shrink-0 border-t border-border/60 bg-paper px-3 py-1 text-[11px] leading-5",
            noticeTone,
          )}
        >
          {notice.text}
        </p>
      ) : null}

      {/* 底部固定操作栏：常规模式「添加书签 / 管理书签」；管理模式的操作在顶部内栏。 */}
      {!manage ? (
        <div
          data-bookmark-actions="true"
          className="flex shrink-0 items-center gap-1.5 border-t border-border/70 bg-paper-soft/70 p-2"
        >
          <Button
            type="button"
            size="sm"
            data-bookmark-add="true"
            onClick={onAdd}
            disabled={creating || !canCreate}
            title={canCreate ? "把当前阅读位置保存为书签" : "章节载入后可添加书签"}
            className="h-8 flex-1 text-xs"
          >
            <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
            {creating ? "保存中…" : "添加书签"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-bookmark-manage-toggle="true"
            onClick={enterManage}
            className="h-8 shrink-0 text-xs"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            管理书签
          </Button>
        </div>
      ) : null}

      {/* 编辑备注（仅单条选中） */}
      <Dialog
        open={dialog?.kind === "note"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent data-bookmark-dialog="note" className="max-w-sm">
          <DialogHeader>
            <DialogTitle>编辑备注</DialogTitle>
            <DialogDescription>写下这条书签的说明或待办；留空可清除备注。</DialogDescription>
          </DialogHeader>
          <textarea
            aria-label="书签备注"
            rows={4}
            value={dialog?.kind === "note" ? dialog.value : ""}
            onChange={(event) => {
              if (dialog?.kind !== "note") return;
              setDialog({ ...dialog, value: event.target.value });
            }}
            autoFocus
            className="flex w-full resize-y rounded-md border border-border bg-paper-soft px-3 py-2 text-sm text-ink shadow-sm transition-colors placeholder:text-ink-soft/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cinnabar/30 focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          />
          {dialogError ? <p className="text-xs text-red-700">{dialogError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={dialogBusy}>
              取消
            </Button>
            <Button type="button" onClick={() => void saveNote()} disabled={dialogBusy}>
              {dialogBusy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名（仅单条选中） */}
      <Dialog
        open={dialog?.kind === "rename"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent data-bookmark-dialog="rename" className="max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名书签</DialogTitle>
            <DialogDescription>修改书签的标题，备注与选中文字不受影响。</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="书签标题"
            value={dialog?.kind === "rename" ? dialog.value : ""}
            onChange={(event) => {
              if (dialog?.kind !== "rename") return;
              setDialog({ ...dialog, value: event.target.value });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveRename();
              }
            }}
            autoFocus
          />
          {dialogError ? <p className="text-xs text-red-700">{dialogError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={dialogBusy}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void saveRename()}
              disabled={dialogBusy || dialog?.kind !== "rename" || !dialog.value.trim()}
            >
              {dialogBusy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认（支持多选批量） */}
      <Dialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent data-bookmark-dialog="delete" className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "delete" && dialog.ids.length > 1
                ? `删除 ${dialog.ids.length} 条书签？`
                : "删除书签？"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.kind === "delete"
                ? dialog.ids.length > 1
                  ? `已选中 ${dialog.ids.length} 条书签，删除后无法恢复。`
                  : `书签「${dialog.titles[0] ?? ""}」删除后无法恢复。`
                : "删除后无法恢复。"}
            </DialogDescription>
          </DialogHeader>
          {dialog?.kind === "delete" && dialog.titles.length > 1 ? (
            <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-border/70 bg-paper-soft/60 px-3 py-2 text-[11px] leading-5 text-ink-soft">
              {dialog.titles.slice(0, 6).map((title, index) => (
                <li key={`${index}-${title}`} className="truncate">
                  · {title}
                </li>
              ))}
              {dialog.titles.length > 6 ? <li>…等 {dialog.titles.length} 条</li> : null}
            </ul>
          ) : null}
          {dialogError ? <p className="text-xs text-red-700">{dialogError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={dialogBusy}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-bookmark-delete-confirm="true"
              onClick={() => void confirmDelete()}
              disabled={dialogBusy}
            >
              {dialogBusy ? "删除中…" : "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
