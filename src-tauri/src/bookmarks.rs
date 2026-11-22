//! 阅读书签：用户库 `bookmarks.json`（Rust 原子写）。
//!
//! 书签记录阅读现场：bookId/chapterId、章节内滚动位置、可选 blockId/选中文字，
//! 以及左右面板开合与当前 tab；供阅读器跳转恢复。首页知识统计计入书签数，
//! 但书签不是 KnowledgeEntry，不进入 archives.json，也不在阅读器知识面板显示。
//!
//! 存储：`dataDir/bookmarks.json` = `{ schemaVersion: 1, bookmarks: Bookmark[] }`；
//! 字段 camelCase，与 `@jusong/core` 的 `Bookmark` 契约一致。文件缺失时读取返回空
//! 列表，写入走 `write_json`（tmp → rename）并由全局写锁串行化；父目录缺失时自动创建。
//!
//! 校验：bookId 必须合法且 `books/<bookId>/book.json` 存在（schemaVersion 2 且含章节；
//! 书签只挂在有章节的正式书上——`parseState: "pending"` 的原始文件书无章节，不能加书签）；
//! chapterId 必须属于该书 chapterIds；title trim 后 1–200 字符；
//! note ≤ 2000、quote ≤ 4000；panels 的 bool 与 tab 白名单必须合法。
//! 任一项非法返回 INVALID_INPUT（新书签不会落盘）。可选新字段：
//! `order`（0..=1e9，手动排序）、`quoteStart`/`quoteEnd`（0..=1e6 且 start<=end，
//! 文字高亮偏移；必须成对出现）。
//!
//! update 找不到 id 返回 NOT_FOUND；delete 采用**幂等**语义：删除不存在的 id 也返回
//! `{ ok: true }`（重复点击/并发删除不报错），且不会为了幂等而创建空 bookmarks.json。
//! 批量命令 `library_delete_bookmarks` / `library_update_bookmark_orders` 都是
//! **一次读-改-写**；错误（非法 id、id 不属于该书）在任何落盘之前返回，不会半批生效。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::library::{
    data_dir, debug_log, now_millis, read_json_opt, run, valid_book_id, write_guard, write_json,
    ApiError,
};
use crate::util::{load_valid_book, now_rfc3339, rfc3339_from_millis, valid_chapter_id};

/// `bookmarks.json` 顶层版本；与 `Bookmark` 契约同步演进。
const BOOKMARKS_SCHEMA_VERSION: u64 = 1;
/// 书签 id：`bm-<毫秒>-<4位计数>`。
const BOOKMARK_ID_PREFIX: &str = "bm";
const BOOKMARK_ID_MAX_CHARS: usize = 128;
const TITLE_MAX_CHARS: usize = 200;
const NOTE_MAX_CHARS: usize = 2_000;
const QUOTE_MAX_CHARS: usize = 4_000;
/// 手动排序序号上限（前端拖拽按 0..n 赋值，1e9 足够大且可防脏数据）。
const ORDER_MAX: u64 = 1_000_000_000;
/// 文字书签偏移上限（UTF-16 code unit；单块纯文本远小于此值）。
const QUOTE_OFFSET_MAX: u64 = 1_000_000;
/// 左（知识）面板 tab 白名单。
const LEFT_TABS: [&str; 5] = ["toc", "summary", "notes", "knowledge", "bookmarks"];
/// 右（探索）面板 tab 白名单。
const RIGHT_TABS: [&str; 3] = ["map", "timeline", "agent"];

fn bookmarks_path(data_root: &Path) -> PathBuf {
    data_root.join("bookmarks.json")
}

fn books_root(data_root: &Path) -> PathBuf {
    data_root.join("books")
}

// ---------------------------------------------------------------------------
// 时间与 id
// ---------------------------------------------------------------------------

/// 生成唯一书签 id：`bm-<毫秒>-<4位计数>`；与已有 id 冲突时计数递增。
fn next_bookmark_id(existing_ids: &HashSet<String>, millis: u128) -> String {
    for attempt in 0..100_000u32 {
        let candidate = format!("{BOOKMARK_ID_PREFIX}-{millis}-{attempt:04}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
    }
    format!("{BOOKMARK_ID_PREFIX}-{millis}-{}", now_millis())
}

// ---------------------------------------------------------------------------
// 校验与规范化
// ---------------------------------------------------------------------------

fn book_chapter_ids(book: &Value) -> Vec<&str> {
    book.get("chapterIds")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// 可选文本字段：缺省/null/空白 → None；非字符串 → INVALID_INPUT。
fn optional_text(value: Option<&Value>, field: &str) -> Result<Option<String>, ApiError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let text = text.trim();
            Ok(if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            })
        }
        Some(_) => Err(ApiError::invalid(format!("{field} 必须是字符串"))),
    }
}

/// 标题：必填字符串，trim 后 1–200 字符。
fn parse_title(value: Option<&Value>) -> Result<String, ApiError> {
    let Some(Value::String(text)) = value else {
        return Err(ApiError::invalid("title 必须是字符串"));
    };
    let title = text.trim();
    let chars = title.chars().count();
    if chars == 0 || chars > TITLE_MAX_CHARS {
        return Err(ApiError::invalid(format!(
            "标题长度需为 1–{TITLE_MAX_CHARS} 字符"
        )));
    }
    Ok(title.to_string())
}

/// 备注：可选；trim 后为空视为未填写（清除）；上限 2000 字符。
fn parse_note(value: Option<&Value>) -> Result<Option<String>, ApiError> {
    let note = optional_text(value, "note")?;
    if let Some(note) = &note {
        if note.chars().count() > NOTE_MAX_CHARS {
            return Err(ApiError::invalid(format!(
                "备注长度不能超过 {NOTE_MAX_CHARS} 字符"
            )));
        }
    }
    Ok(note)
}

/// 选中文字：可选；上限 4000 字符。
fn parse_quote(value: Option<&Value>) -> Result<Option<String>, ApiError> {
    let quote = optional_text(value, "quote")?;
    if let Some(quote) = &quote {
        if quote.chars().count() > QUOTE_MAX_CHARS {
            return Err(ApiError::invalid(format!(
                "选中文字长度不能超过 {QUOTE_MAX_CHARS} 字符"
            )));
        }
    }
    Ok(quote)
}

/// 可选非负整数：缺省/null → None；非整数/负数/超上限 → INVALID_INPUT。
fn parse_optional_u64(
    value: Option<&Value>,
    field: &str,
    max: u64,
) -> Result<Option<u64>, ApiError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let Some(number) = value.as_u64() else {
                return Err(ApiError::invalid(format!("{field} 必须是非负整数")));
            };
            if number > max {
                return Err(ApiError::invalid(format!(
                    "{field} 不能超过 {max}（当前 {number}）"
                )));
            }
            Ok(Some(number))
        }
    }
}

/// 文字书签偏移：`quoteStart`/`quoteEnd` 必须成对出现，且 start <= end。
/// 两者都缺省时返回 None（旧书签/页面级书签）；只给一侧视为非法输入。
fn parse_quote_offsets(object: &Map<String, Value>) -> Result<Option<(u64, u64)>, ApiError> {
    let start = parse_optional_u64(object.get("quoteStart"), "quoteStart", QUOTE_OFFSET_MAX)?;
    let end = parse_optional_u64(object.get("quoteEnd"), "quoteEnd", QUOTE_OFFSET_MAX)?;
    match (start, end) {
        (None, None) => Ok(None),
        (Some(start), Some(end)) => {
            if start > end {
                return Err(ApiError::invalid("quoteStart 不能大于 quoteEnd"));
            }
            Ok(Some((start, end)))
        }
        _ => Err(ApiError::invalid("quoteStart 与 quoteEnd 必须同时提供")),
    }
}

/// 面板现场：bool + tab 白名单；返回规范化对象。
fn parse_panels(value: &Value) -> Result<Value, ApiError> {
    let Some(object) = value.as_object() else {
        return Err(ApiError::invalid("panels 必须是 JSON 对象"));
    };
    let Some(left_open) = object.get("leftOpen").and_then(Value::as_bool) else {
        return Err(ApiError::invalid("panels.leftOpen 必须是布尔值"));
    };
    let Some(right_open) = object.get("rightOpen").and_then(Value::as_bool) else {
        return Err(ApiError::invalid("panels.rightOpen 必须是布尔值"));
    };
    let Some(left_tab) = object.get("leftTab").and_then(Value::as_str) else {
        return Err(ApiError::invalid("panels.leftTab 必须是字符串"));
    };
    let Some(right_tab) = object.get("rightTab").and_then(Value::as_str) else {
        return Err(ApiError::invalid("panels.rightTab 必须是字符串"));
    };
    if !LEFT_TABS.contains(&left_tab) {
        return Err(ApiError::invalid(format!(
            "不支持的知识面板 tab：{left_tab}（可选 {}）",
            LEFT_TABS.join(" / ")
        )));
    }
    if !RIGHT_TABS.contains(&right_tab) {
        return Err(ApiError::invalid(format!(
            "不支持的探索面板 tab：{right_tab}（可选 {}）",
            RIGHT_TABS.join(" / ")
        )));
    }
    Ok(json!({
        "leftOpen": left_open,
        "rightOpen": right_open,
        "leftTab": left_tab,
        "rightTab": right_tab,
    }))
}

fn insert_optional_text(object: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        object.insert(key.to_string(), json!(value));
    }
}

fn insert_optional_u64(object: &mut Map<String, Value>, key: &str, value: Option<u64>) {
    if let Some(value) = value {
        object.insert(key.to_string(), json!(value));
    }
}

/// 落盘记录里的可选 offset：缺省/非整数/超上限 → 丢弃（旧记录兼容，不整条过滤）。
fn stored_offset(object: &Map<String, Value>, key: &str) -> Option<u64> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value <= QUOTE_OFFSET_MAX)
}

/// 规范化落盘记录里的 `quoteStart`/`quoteEnd`：必须成对且 start <= end，否则视为缺省。
fn stored_quote_offsets(object: &Map<String, Value>) -> Option<(u64, u64)> {
    let start = stored_offset(object, "quoteStart")?;
    let end = stored_offset(object, "quoteEnd")?;
    (start <= end).then_some((start, end))
}

/// 把落盘条目规范化为契约对象；缺 id / 关键字段损坏的条目返回 None（列表时过滤）。
fn normalize_stored_bookmark(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let id = object.get("id")?.as_str()?.trim();
    if id.is_empty() || id.chars().count() > BOOKMARK_ID_MAX_CHARS {
        return None;
    }
    let book_id = object.get("bookId")?.as_str()?.trim();
    if !valid_book_id(book_id) {
        return None;
    }
    let chapter_id = object.get("chapterId")?.as_str()?;
    if !valid_chapter_id(chapter_id) {
        return None;
    }
    let scroll_top = object.get("scrollTop")?.as_f64()?;
    if !scroll_top.is_finite() || scroll_top < 0.0 {
        return None;
    }
    let title = object.get("title")?.as_str()?.trim();
    if title.is_empty() || title.chars().count() > TITLE_MAX_CHARS {
        return None;
    }
    let created_at = object.get("createdAt")?.as_str()?;
    if created_at.trim().is_empty() {
        return None;
    }
    let updated_at = object.get("updatedAt")?.as_str()?;
    if updated_at.trim().is_empty() {
        return None;
    }
    let panels = parse_panels(object.get("panels")?).ok()?;

    let mut normalized = Map::new();
    normalized.insert("id".to_string(), json!(id));
    normalized.insert("bookId".to_string(), json!(book_id));
    insert_optional_text(
        &mut normalized,
        "bookTitle",
        object
            .get("bookTitle")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_string),
    );
    normalized.insert("chapterId".to_string(), json!(chapter_id));
    insert_optional_text(
        &mut normalized,
        "chapterTitle",
        object
            .get("chapterTitle")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_string),
    );
    normalized.insert("scrollTop".to_string(), json!(scroll_top));
    // 新字段（order/quoteStart/quoteEnd）必须原样保留，否则读取会把旧记录的字段抹掉。
    insert_optional_u64(
        &mut normalized,
        "order",
        object
            .get("order")
            .and_then(Value::as_u64)
            .filter(|order| *order <= ORDER_MAX),
    );
    if let Some((start, end)) = stored_quote_offsets(object) {
        normalized.insert("quoteStart".to_string(), json!(start));
        normalized.insert("quoteEnd".to_string(), json!(end));
    }
    insert_optional_text(
        &mut normalized,
        "blockId",
        object
            .get("blockId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|block_id| !block_id.is_empty())
            .map(str::to_string),
    );
    insert_optional_text(
        &mut normalized,
        "quote",
        object
            .get("quote")
            .and_then(Value::as_str)
            .filter(|quote| !quote.is_empty())
            .map(str::to_string),
    );
    normalized.insert("title".to_string(), json!(title));
    insert_optional_text(
        &mut normalized,
        "note",
        object
            .get("note")
            .and_then(Value::as_str)
            .filter(|note| !note.is_empty())
            .map(str::to_string),
    );
    normalized.insert("panels".to_string(), panels);
    normalized.insert("createdAt".to_string(), json!(created_at));
    normalized.insert("updatedAt".to_string(), json!(updated_at));
    Some(Value::Object(normalized))
}

/// 由输入构造新书签（id/时间由 Rust 生成）；非法输入返回 INVALID_INPUT。
fn build_bookmark(
    data_root: &Path,
    input: &Value,
    id: String,
    timestamp: &str,
) -> Result<Value, ApiError> {
    let Some(input) = input.as_object() else {
        return Err(ApiError::invalid("bookmark 必须是 JSON 对象"));
    };
    let Some(Value::String(book_id)) = input.get("bookId") else {
        return Err(ApiError::invalid("bookId 必须是字符串"));
    };
    let book_id = book_id.trim();
    if !valid_book_id(book_id) {
        return Err(ApiError::invalid(format!("非法 bookId：{book_id}")));
    }
    // 书签只允许加在有章节的正式书籍上：pending 原始文件书（无章节）不能加书签。
    let Some(book) = load_valid_book(&books_root(data_root), book_id, false) else {
        return Err(ApiError::invalid(format!(
            "书籍不存在或不是当前数据格式：{book_id}"
        )));
    };
    let Some(Value::String(chapter_id)) = input.get("chapterId") else {
        return Err(ApiError::invalid("chapterId 必须是字符串"));
    };
    let chapter_id = chapter_id.trim();
    if !valid_chapter_id(chapter_id) {
        return Err(ApiError::invalid(format!("非法 chapterId：{chapter_id}")));
    }
    if !book_chapter_ids(&book).contains(&chapter_id) {
        return Err(ApiError::invalid(format!("章节不属于本书：{chapter_id}")));
    }
    let Some(scroll_top) = input.get("scrollTop").and_then(Value::as_f64) else {
        return Err(ApiError::invalid("scrollTop 必须是非负数字"));
    };
    if !scroll_top.is_finite() || scroll_top < 0.0 {
        return Err(ApiError::invalid("scrollTop 必须是非负数字"));
    }
    let title = parse_title(input.get("title"))?;
    let note = parse_note(input.get("note"))?;
    let quote = parse_quote(input.get("quote"))?;
    let panels = parse_panels(
        input
            .get("panels")
            .ok_or_else(|| ApiError::invalid("缺少 panels"))?,
    )?;
    let book_title = optional_text(input.get("bookTitle"), "bookTitle")?;
    let chapter_title = optional_text(input.get("chapterTitle"), "chapterTitle")?;
    let block_id = optional_text(input.get("blockId"), "blockId")?;
    let order = parse_optional_u64(input.get("order"), "order", ORDER_MAX)?;
    let quote_offsets = parse_quote_offsets(input)?;

    let mut bookmark = Map::new();
    bookmark.insert("id".to_string(), json!(id));
    bookmark.insert("bookId".to_string(), json!(book_id));
    insert_optional_text(&mut bookmark, "bookTitle", book_title);
    bookmark.insert("chapterId".to_string(), json!(chapter_id));
    insert_optional_text(&mut bookmark, "chapterTitle", chapter_title);
    bookmark.insert("scrollTop".to_string(), json!(scroll_top));
    insert_optional_text(&mut bookmark, "blockId", block_id);
    insert_optional_text(&mut bookmark, "quote", quote);
    if let Some((start, end)) = quote_offsets {
        bookmark.insert("quoteStart".to_string(), json!(start));
        bookmark.insert("quoteEnd".to_string(), json!(end));
    }
    insert_optional_u64(&mut bookmark, "order", order);
    bookmark.insert("title".to_string(), json!(title));
    insert_optional_text(&mut bookmark, "note", note);
    bookmark.insert("panels".to_string(), panels);
    bookmark.insert("createdAt".to_string(), json!(timestamp));
    bookmark.insert("updatedAt".to_string(), json!(timestamp));
    Ok(Value::Object(bookmark))
}

// ---------------------------------------------------------------------------
// 读取/写入（内部函数不依赖 Tauri runtime，便于单元测试）
// ---------------------------------------------------------------------------

/// 读取原始条目：文件缺失/顶层版本不匹配 → 空；丢弃非对象条目。
fn read_bookmark_entries(data_root: &Path) -> Result<Vec<Value>, ApiError> {
    let Some(value) = read_json_opt(&bookmarks_path(data_root))? else {
        return Ok(Vec::new());
    };
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(BOOKMARKS_SCHEMA_VERSION) {
        return Ok(Vec::new());
    }
    Ok(value
        .get("bookmarks")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| entry.is_object())
                .cloned()
                .collect()
        })
        .unwrap_or_default())
}

fn write_bookmark_entries(data_root: &Path, entries: &[Value]) -> Result<(), ApiError> {
    write_json(
        &bookmarks_path(data_root),
        &json!({ "schemaVersion": BOOKMARKS_SCHEMA_VERSION, "bookmarks": entries }),
    )
}

/// 列表：按 bookId 过滤（缺省全部），createdAt 倒序；过滤明显损坏的条目。
fn list_bookmarks_into(data_root: &Path, book_id: Option<&str>) -> Result<Vec<Value>, ApiError> {
    let book_filter = match book_id.map(str::trim).filter(|book_id| !book_id.is_empty()) {
        Some(book_id) => {
            if !valid_book_id(book_id) {
                return Err(ApiError::invalid(format!("非法 bookId：{book_id}")));
            }
            Some(book_id.to_string())
        }
        None => None,
    };
    let mut bookmarks: Vec<Value> = read_bookmark_entries(data_root)?
        .iter()
        .filter_map(normalize_stored_bookmark)
        .collect();
    if let Some(book_id) = book_filter {
        bookmarks.retain(|bookmark| {
            bookmark.get("bookId").and_then(Value::as_str) == Some(book_id.as_str())
        });
    }
    // createdAt 倒序（最新在前）；同毫秒时按 id 倒序（id 内含递增计数），保证稳定。
    bookmarks.sort_by(|left, right| {
        let left_created_at = left.get("createdAt").and_then(Value::as_str).unwrap_or("");
        let right_created_at = right.get("createdAt").and_then(Value::as_str).unwrap_or("");
        right_created_at.cmp(left_created_at).then_with(|| {
            let left_id = left.get("id").and_then(Value::as_str).unwrap_or("");
            let right_id = right.get("id").and_then(Value::as_str).unwrap_or("");
            right_id.cmp(left_id)
        })
    });
    Ok(bookmarks)
}

/// 新增书签（毫秒时间可注入，便于测试 id 冲突/排序）。
fn add_bookmark_at(data_root: &Path, input: &Value, millis: u128) -> Result<Value, ApiError> {
    let _guard = write_guard()?;
    let mut entries = read_bookmark_entries(data_root)?;
    let existing_ids: HashSet<String> = entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let id = next_bookmark_id(&existing_ids, millis);
    let bookmark = build_bookmark(data_root, input, id, &rfc3339_from_millis(millis))?;
    entries.push(bookmark.clone());
    write_bookmark_entries(data_root, &entries)?;
    Ok(bookmark)
}

fn add_bookmark_into(data_root: &Path, input: &Value) -> Result<Value, ApiError> {
    add_bookmark_at(data_root, input, now_millis())
}

/// 更新书签：只改 title/note（提供才改）并刷新 updatedAt；找不到返回 NOT_FOUND。
fn update_bookmark_into(data_root: &Path, id: &str, patch: &Value) -> Result<Value, ApiError> {
    let id = id.trim();
    if id.is_empty() || id.chars().count() > BOOKMARK_ID_MAX_CHARS {
        return Err(ApiError::invalid("书签 id 无效"));
    }
    let Some(patch) = patch.as_object() else {
        return Err(ApiError::invalid("patch 必须是 JSON 对象"));
    };
    let _guard = write_guard()?;
    let mut entries = read_bookmark_entries(data_root)?;
    let Some(index) = entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str).map(str::trim) == Some(id))
    else {
        return Err(ApiError::new("NOT_FOUND", format!("书签不存在：{id}")));
    };
    {
        let Some(object) = entries[index].as_object_mut() else {
            return Err(ApiError::new("CORRUPTED", "书签条目不是 JSON 对象"));
        };
        if let Some(title) = patch.get("title") {
            object.insert("title".to_string(), json!(parse_title(Some(title))?));
        }
        if let Some(note) = patch.get("note") {
            match parse_note(Some(note))? {
                Some(note) => {
                    object.insert("note".to_string(), json!(note));
                }
                None => {
                    object.remove("note");
                }
            }
        }
        // order：缺省不改；显式 null 表示退出手动排序（清除字段）。
        if let Some(order) = patch.get("order") {
            match parse_optional_u64(Some(order), "order", ORDER_MAX)? {
                Some(order) => {
                    object.insert("order".to_string(), json!(order));
                }
                None => {
                    object.remove("order");
                }
            }
        }
        // quoteStart/quoteEnd 及未知字段不属于 patch 白名单：保留原值、忽略输入，
        // 避免重命名/排序等操作把阅读现场字段冲掉。
        object.insert("updatedAt".to_string(), json!(now_rfc3339()));
    }
    let updated = entries[index].clone();
    write_bookmark_entries(data_root, &entries)?;
    Ok(updated)
}

/// 删除书签（幂等）：命中返回 true 并重写文件；未命中返回 false 且不写文件。
fn delete_bookmark_into(data_root: &Path, id: &str) -> Result<bool, ApiError> {
    let id = id.trim();
    if id.is_empty() || id.chars().count() > BOOKMARK_ID_MAX_CHARS {
        return Err(ApiError::invalid("书签 id 无效"));
    }
    let _guard = write_guard()?;
    let mut entries = read_bookmark_entries(data_root)?;
    let before = entries.len();
    entries.retain(|entry| entry.get("id").and_then(Value::as_str).map(str::trim) != Some(id));
    if entries.len() == before {
        return Ok(false);
    }
    write_bookmark_entries(data_root, &entries)?;
    Ok(true)
}

/// 批量删除（一次写盘、幂等）：先校验全部 id 再统一过滤；无命中不写文件。
fn delete_bookmarks_into(data_root: &Path, ids: &[String]) -> Result<u64, ApiError> {
    let mut wanted: HashSet<String> = HashSet::new();
    for id in ids {
        let id = id.trim();
        if id.is_empty() || id.chars().count() > BOOKMARK_ID_MAX_CHARS {
            return Err(ApiError::invalid("书签 id 无效"));
        }
        wanted.insert(id.to_string());
    }
    if wanted.is_empty() {
        return Ok(0);
    }
    let _guard = write_guard()?;
    let mut entries = read_bookmark_entries(data_root)?;
    let before = entries.len();
    entries.retain(|entry| {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        !wanted.contains(id)
    });
    let deleted = (before - entries.len()) as u64;
    if deleted == 0 {
        return Ok(0);
    }
    write_bookmark_entries(data_root, &entries)?;
    Ok(deleted)
}

/// 批量写入手动排序（一次写盘）：`orders` 每项为 `{ id, order }`；
/// 先整体校验（重复 id → INVALID_INPUT；id 不属于该书 → NOT_FOUND），全部合法才落盘，
/// 避免半批生效。返回应用条数（重复提交相同顺序是幂等的，不会重复写盘）。
fn update_bookmark_orders_into(
    data_root: &Path,
    book_id: &str,
    orders: &[Value],
) -> Result<u64, ApiError> {
    let book_id = book_id.trim();
    if !valid_book_id(book_id) {
        return Err(ApiError::invalid(format!("非法 bookId：{book_id}")));
    }
    let mut parsed: Vec<(String, u64)> = Vec::with_capacity(orders.len());
    let mut seen: HashSet<&str> = HashSet::new();
    for order in orders {
        let Some(object) = order.as_object() else {
            return Err(ApiError::invalid("order 项必须是 JSON 对象"));
        };
        let Some(Value::String(id)) = object.get("id") else {
            return Err(ApiError::invalid("order.id 必须是字符串"));
        };
        let id = id.trim();
        if id.is_empty() || id.chars().count() > BOOKMARK_ID_MAX_CHARS {
            return Err(ApiError::invalid("书签 id 无效"));
        }
        if !seen.insert(id) {
            return Err(ApiError::invalid(format!("重复的书签 id：{id}")));
        }
        let Some(value) = parse_optional_u64(object.get("order"), "order", ORDER_MAX)? else {
            return Err(ApiError::invalid(format!("order 项缺少 order：{id}")));
        };
        parsed.push((id.to_string(), value));
    }
    if parsed.is_empty() {
        return Ok(0);
    }
    let _guard = write_guard()?;
    let mut entries = read_bookmark_entries(data_root)?;
    let mut indexes: HashMap<&str, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.get("bookId").and_then(Value::as_str) != Some(book_id) {
            continue;
        }
        if let Some(id) = entry.get("id").and_then(Value::as_str).map(str::trim) {
            indexes.insert(id, index);
        }
    }
    let mut resolved: Vec<(usize, u64)> = Vec::with_capacity(parsed.len());
    for (id, order) in &parsed {
        let Some(index) = indexes.get(id.as_str()) else {
            return Err(ApiError::new(
                "NOT_FOUND",
                format!("书签不存在或不属于本书：{id}"),
            ));
        };
        resolved.push((*index, *order));
    }
    let mut changed = 0usize;
    for (index, order) in resolved {
        let Some(object) = entries[index].as_object_mut() else {
            continue;
        };
        if object.get("order").and_then(Value::as_u64) == Some(order) {
            continue;
        }
        object.insert("order".to_string(), json!(order));
        changed += 1;
    }
    if changed > 0 {
        write_bookmark_entries(data_root, &entries)?;
    }
    Ok(parsed.len() as u64)
}

// ---------------------------------------------------------------------------
// Tauri 命令（薄封装：解析 dataDir → 后台线程执行内部函数）
// ---------------------------------------------------------------------------

/// 书签列表；`book_id` 缺省时返回全部（首页统计用）。
#[tauri::command]
pub async fn library_list_bookmarks(
    app: AppHandle,
    book_id: Option<String>,
) -> Result<Value, ApiError> {
    debug_log("list_bookmarks");
    run(move || {
        let data = data_dir(&app)?;
        Ok(Value::Array(list_bookmarks_into(
            &data,
            book_id.as_deref(),
        )?))
    })
    .await
}

/// 新增书签（id/时间由 Rust 生成）。
#[tauri::command]
pub async fn library_add_bookmark(app: AppHandle, bookmark: Value) -> Result<Value, ApiError> {
    debug_log("add_bookmark");
    run(move || {
        let data = data_dir(&app)?;
        add_bookmark_into(&data, &bookmark)
    })
    .await
}

/// 更新书签标题/备注。
#[tauri::command]
pub async fn library_update_bookmark(
    app: AppHandle,
    id: String,
    patch: Value,
) -> Result<Value, ApiError> {
    debug_log("update_bookmark");
    run(move || {
        let data = data_dir(&app)?;
        update_bookmark_into(&data, &id, &patch)
    })
    .await
}

/// 删除书签（幂等：不存在也算成功）。
#[tauri::command]
pub async fn library_delete_bookmark(app: AppHandle, id: String) -> Result<Value, ApiError> {
    debug_log("delete_bookmark");
    run(move || {
        let data = data_dir(&app)?;
        delete_bookmark_into(&data, &id)?;
        Ok(json!({ "ok": true }))
    })
    .await
}

/// 批量删除书签（一次写盘、幂等）：不存在的 id 忽略；返回实际删除条数。
#[tauri::command]
pub async fn library_delete_bookmarks(app: AppHandle, ids: Vec<String>) -> Result<Value, ApiError> {
    debug_log("delete_bookmarks");
    run(move || {
        let data = data_dir(&app)?;
        let deleted = delete_bookmarks_into(&data, &ids)?;
        Ok(json!({ "ok": true, "deleted": deleted }))
    })
    .await
}

/// 批量写入手动排序（一次写盘）：`orders` = `[{ id, order }]`；
/// id 必须属于 `bookId`，否则返回 NOT_FOUND；返回应用条数。
#[tauri::command]
pub async fn library_update_bookmark_orders(
    app: AppHandle,
    book_id: String,
    orders: Vec<Value>,
) -> Result<Value, ApiError> {
    debug_log("update_bookmark_orders");
    run(move || {
        let data = data_dir(&app)?;
        let updated = update_bookmark_orders_into(&data, &book_id, &orders)?;
        Ok(json!({ "ok": true, "updated": updated }))
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::util::{now_rfc3339, rfc3339_from_millis};

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jusong-bookmarks-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_book(data_root: &Path, book_id: &str, chapter_ids: &[&str], schema_version: u64) {
        let directory = books_root(data_root).join(book_id);
        fs::create_dir_all(&directory).unwrap();
        write_json(
            &directory.join("book.json"),
            &json!({
                "id": book_id,
                "title": format!("书籍 {book_id}"),
                "schemaVersion": schema_version,
                "chapterIds": chapter_ids,
            }),
        )
        .unwrap();
    }

    fn sample_panels() -> Value {
        json!({
            "leftOpen": true,
            "rightOpen": false,
            "leftTab": "bookmarks",
            "rightTab": "map",
        })
    }

    fn sample_input(book_id: &str, chapter_id: &str) -> Value {
        json!({
            "bookId": book_id,
            "bookTitle": "甲书",
            "chapterId": chapter_id,
            "chapterTitle": "第一章",
            "scrollTop": 120.5,
            "blockId": "p1",
            "quote": "原文摘录",
            "title": "  我的书签  ",
            "note": "  备注  ",
            "panels": sample_panels(),
        })
    }

    fn stored_bookmark(id: &str, book_id: &str, chapter_id: &str, created_at: &str) -> Value {
        json!({
            "id": id,
            "bookId": book_id,
            "bookTitle": "书籍",
            "chapterId": chapter_id,
            "chapterTitle": "章节",
            "scrollTop": 0,
            "title": format!("书签 {id}"),
            "panels": sample_panels(),
            "createdAt": created_at,
            "updatedAt": created_at,
        })
    }

    fn temp_files(data_root: &Path) -> Vec<String> {
        let mut files: Vec<String> = fs::read_dir(data_root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("tmp"))
            .collect();
        files.sort();
        files
    }

    fn error_code<T>(result: Result<T, ApiError>) -> &'static str {
        match result {
            Ok(_) => panic!("预期返回错误，实际成功"),
            Err(error) => error.code,
        }
    }

    #[test]
    fn rfc3339_is_utc_millis() {
        assert_eq!(rfc3339_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            rfc3339_from_millis(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
        let now = now_rfc3339();
        assert!(now.ends_with('Z'));
        assert_eq!(now.len(), 24);
        assert!(now.contains('T'));
    }

    #[test]
    fn missing_file_reads_empty_and_write_creates_directory() {
        let root = temp_root("missing-file");
        let data = root.join("nested/library");
        // 目录与文件都不存在：读路径返回空且不创建任何东西。
        assert!(read_bookmark_entries(&data).unwrap().is_empty());
        assert!(!bookmarks_path(&data).exists());
        assert!(!data.exists());

        // 写路径自动创建父目录，并落 schemaVersion 1 + 空书签数组。
        write_bookmark_entries(&data, &[]).unwrap();
        assert!(bookmarks_path(&data).exists());
        let stored = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        assert_eq!(stored["schemaVersion"], json!(1));
        assert_eq!(stored["bookmarks"], json!([]));
        assert_eq!(temp_files(&data), Vec::<String>::new());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn add_then_list_roundtrip_and_atomic_write() {
        let root = temp_root("roundtrip");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001", "ch_0002"], 2);
        write_book(&data, "bm-book-b", &["ch_b1"], 2);

        // 文件缺失：返回空列表，且不自动创建文件。
        assert!(list_bookmarks_into(&data, None).unwrap().is_empty());
        assert!(!bookmarks_path(&data).exists());

        let added = add_bookmark_into(&data, &sample_input("bm-book-a", "ch_0001")).unwrap();
        let id = added["id"].as_str().unwrap().to_string();
        let id_parts: Vec<&str> = id.split('-').collect();
        assert_eq!(id_parts.len(), 3, "id 形态应为 bm-<毫秒>-<计数>：{id}");
        assert_eq!(id_parts[0], "bm");
        assert_eq!(id_parts[1].len(), 13);
        assert_eq!(id_parts[2].len(), 4);
        assert_eq!(added["bookId"], json!("bm-book-a"));
        assert_eq!(added["bookTitle"], json!("甲书"));
        assert_eq!(added["chapterId"], json!("ch_0001"));
        assert_eq!(added["chapterTitle"], json!("第一章"));
        assert_eq!(added["scrollTop"], json!(120.5));
        assert_eq!(added["blockId"], json!("p1"));
        assert_eq!(added["quote"], json!("原文摘录"));
        assert_eq!(added["title"], json!("我的书签"));
        assert_eq!(added["note"], json!("备注"));
        assert_eq!(added["panels"], sample_panels());
        let created_at = added["createdAt"].as_str().unwrap();
        assert!(created_at.ends_with('Z'), "createdAt 应为 RFC3339 UTC");
        assert_eq!(added["createdAt"], added["updatedAt"]);

        // 落盘结构：schemaVersion 1 + bookmarks 数组。
        let stored = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        assert_eq!(stored["schemaVersion"], json!(1));
        assert_eq!(stored["bookmarks"].as_array().unwrap().len(), 1);
        assert_eq!(stored["bookmarks"][0]["id"], json!(id));

        // 列表往返：缺省全部 / 按 bookId 过滤 / 过滤参数非法。
        let all = list_bookmarks_into(&data, None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["id"], json!(id));
        let filtered = list_bookmarks_into(&data, Some("bm-book-a")).unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["id"], json!(id));
        assert!(list_bookmarks_into(&data, Some("bm-book-b"))
            .unwrap()
            .is_empty());
        assert_eq!(
            error_code(list_bookmarks_into(&data, Some("../bad"))),
            "INVALID_INPUT"
        );

        // 原子写：无 tmp 残留。
        assert!(!bookmarks_path(&data).with_extension("json.tmp").exists());
        assert_eq!(temp_files(&data), Vec::<String>::new());

        // 可选字段缺省时不写入（前端契约里都是 optional）。
        let mut minimal = sample_input("bm-book-a", "ch_0002");
        {
            let object = minimal.as_object_mut().unwrap();
            for key in ["bookTitle", "chapterTitle", "blockId", "quote", "note"] {
                object.remove(key);
            }
        }
        let minimal = add_bookmark_into(&data, &minimal).unwrap();
        for key in ["bookTitle", "chapterTitle", "blockId", "quote", "note"] {
            assert!(minimal.get(key).is_none(), "缺省字段不应写入：{key}");
        }
        assert_eq!(
            list_bookmarks_into(&data, Some("bm-book-a")).unwrap().len(),
            2
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn add_rejects_invalid_input() {
        let root = temp_root("invalid");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);
        write_book(&data, "bm-book-old", &["ch_0001"], 1);

        let valid = sample_input("bm-book-a", "ch_0001");
        assert_eq!(
            error_code(add_bookmark_into(&data, &json!("x"))),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(add_bookmark_into(&data, &json!({}))),
            "INVALID_INPUT"
        );

        // bookId：非法格式 / 书不存在 / 旧存档（schemaVersion 1）。
        let mut invalid = valid.clone();
        invalid["bookId"] = json!("../etc");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["bookId"] = json!("missing-book");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["bookId"] = json!("bm-book-old");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );

        // chapterId：非法字符 / 不属于该书。
        let mut invalid = valid.clone();
        invalid["chapterId"] = json!("ch 0001");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["chapterId"] = json!("ch_9999");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );

        // title：空白 / 超长（按字符计）。
        let mut invalid = valid.clone();
        invalid["title"] = json!("   ");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["title"] = json!("长".repeat(TITLE_MAX_CHARS + 1));
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );

        // note / quote：超长（按字符计）。
        let mut invalid = valid.clone();
        invalid["note"] = json!("注".repeat(NOTE_MAX_CHARS + 1));
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["quote"] = json!("引".repeat(QUOTE_MAX_CHARS + 1));
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );

        // scrollTop：负数 / 非数字。
        let mut invalid = valid.clone();
        invalid["scrollTop"] = json!(-1);
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["scrollTop"] = json!("120");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );

        // panels：缺失 / bool 非布尔 / tab 不在白名单。
        let mut invalid = valid.clone();
        invalid.as_object_mut().unwrap().remove("panels");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["panels"]["leftOpen"] = json!("true");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["panels"]["leftTab"] = json!("settings");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );
        let mut invalid = valid.clone();
        invalid["panels"]["rightTab"] = json!("toc");
        assert_eq!(
            error_code(add_bookmark_into(&data, &invalid)),
            "INVALID_INPUT"
        );

        // 校验失败不应创建/改写 bookmarks.json。
        assert!(!bookmarks_path(&data).exists());
        assert!(list_bookmarks_into(&data, None).unwrap().is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bookmark_ids_increment_and_list_is_newest_first() {
        let root = temp_root("ids");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);
        let input = sample_input("bm-book-a", "ch_0001");

        // 同毫秒两次写入：id 计数递增，createdAt 相同（createdAt 倒序时按 id 倒序兜底）。
        let first = add_bookmark_at(&data, &input, 1_700_000_000_000).unwrap();
        let second = add_bookmark_at(&data, &input, 1_700_000_000_000).unwrap();
        assert_eq!(first["id"], json!("bm-1700000000000-0000"));
        assert_eq!(second["id"], json!("bm-1700000000000-0001"));
        assert_eq!(first["createdAt"], json!("2023-11-14T22:13:20.000Z"));
        assert_eq!(second["createdAt"], json!("2023-11-14T22:13:20.000Z"));

        let third = add_bookmark_at(&data, &input, 1_700_000_002_000).unwrap();
        assert_eq!(third["id"], json!("bm-1700000002000-0000"));
        assert_eq!(third["createdAt"], json!("2023-11-14T22:13:22.000Z"));

        let list = list_bookmarks_into(&data, Some("bm-book-a")).unwrap();
        let ids: Vec<&str> = list
            .iter()
            .map(|bookmark| bookmark["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![
                "bm-1700000002000-0000",
                "bm-1700000000000-0001",
                "bm-1700000000000-0000"
            ]
        );

        // id 计数冲突兜底函数。
        let mut existing: HashSet<String> = HashSet::new();
        existing.insert("bm-42-0000".to_string());
        existing.insert("bm-42-0001".to_string());
        assert_eq!(next_bookmark_id(&existing, 42), "bm-42-0002");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn update_changes_only_title_and_note() {
        let root = temp_root("update");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);
        let added = add_bookmark_at(
            &data,
            &sample_input("bm-book-a", "ch_0001"),
            1_700_000_000_000,
        )
        .unwrap();
        let id = added["id"].as_str().unwrap().to_string();

        // 只改 title：note 保留，其他字段与 createdAt 不变。
        let only_title =
            update_bookmark_into(&data, &id, &json!({ "title": "  新标题  " })).unwrap();
        assert_eq!(only_title["title"], json!("新标题"));
        assert_eq!(only_title["note"], json!("备注"));
        assert_eq!(only_title["bookId"], added["bookId"]);
        assert_eq!(only_title["chapterId"], added["chapterId"]);
        assert_eq!(only_title["scrollTop"], added["scrollTop"]);
        assert_eq!(only_title["panels"], added["panels"]);
        assert_eq!(only_title["createdAt"], added["createdAt"]);
        let updated_at = only_title["updatedAt"].as_str().unwrap();
        assert!(updated_at.ends_with('Z'));

        // 改 note；再用空串清除 note。
        let updated = update_bookmark_into(&data, &id, &json!({ "note": "  新备注  " })).unwrap();
        assert_eq!(updated["note"], json!("新备注"));
        assert_eq!(updated["title"], json!("新标题"));
        let cleared = update_bookmark_into(&data, &id, &json!({ "note": "" })).unwrap();
        assert!(cleared.get("note").is_none(), "空备注应清除 note 字段");
        assert_eq!(cleared["title"], json!("新标题"));

        // 非法 patch：超长标题 / 非对象 / 不存在的 id / 空 id。
        assert_eq!(
            error_code(update_bookmark_into(
                &data,
                &id,
                &json!({ "title": "长".repeat(TITLE_MAX_CHARS + 1) })
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(update_bookmark_into(&data, &id, &json!(["title"]))),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(update_bookmark_into(&data, "bm-nope-0000", &json!({}))),
            "NOT_FOUND"
        );
        assert_eq!(
            error_code(update_bookmark_into(&data, "   ", &json!({}))),
            "INVALID_INPUT"
        );

        // 非法 patch 不落盘：标题仍是上一次成功更新的值。
        let stored = list_bookmarks_into(&data, Some("bm-book-a"))
            .unwrap()
            .remove(0);
        assert_eq!(stored["title"], json!("新标题"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_removes_and_is_idempotent() {
        let root = temp_root("delete");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);
        let first = add_bookmark_at(
            &data,
            &sample_input("bm-book-a", "ch_0001"),
            1_700_000_001_000,
        )
        .unwrap();
        let second = add_bookmark_at(
            &data,
            &sample_input("bm-book-a", "ch_0001"),
            1_700_000_002_000,
        )
        .unwrap();
        let first_id = first["id"].as_str().unwrap().to_string();
        let second_id = second["id"].as_str().unwrap().to_string();

        // 命中：删除并重写文件。
        assert!(delete_bookmark_into(&data, &first_id).unwrap());
        let list = list_bookmarks_into(&data, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], json!(second_id));

        // 幂等：再删同一个 id 返回 false，列表不变，不报错。
        assert!(!delete_bookmark_into(&data, &first_id).unwrap());
        assert_eq!(list_bookmarks_into(&data, None).unwrap().len(), 1);

        // 空 id 视为非法输入。
        assert_eq!(
            error_code(delete_bookmark_into(&data, "  ")),
            "INVALID_INPUT"
        );

        // 文件缺失时删除：幂等成功，且不为空删除创建 bookmarks.json。
        let missing = root.join("library-missing");
        assert!(!delete_bookmark_into(&missing, "bm-1-0000").unwrap());
        assert!(!bookmarks_path(&missing).exists());

        // 删除最后一条后文件保留空数组（schemaVersion 仍为 1）。
        assert!(delete_bookmark_into(&data, &second_id).unwrap());
        let stored = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        assert_eq!(stored["schemaVersion"], json!(1));
        assert_eq!(stored["bookmarks"], json!([]));
        assert_eq!(temp_files(&data), Vec::<String>::new());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_filters_corrupted_entries_and_orders_by_created_at() {
        let root = temp_root("list");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);
        write_book(&data, "bm-book-b", &["ch_b1"], 2);

        let mut bad_panel = stored_bookmark(
            "bm-bad-panel",
            "bm-book-a",
            "ch_0001",
            "2026-11-15T00:00:06.000Z",
        );
        bad_panel["panels"]["leftTab"] = json!("settings");
        let mut bad_scroll = stored_bookmark(
            "bm-bad-scroll",
            "bm-book-a",
            "ch_0001",
            "2026-11-15T00:00:07.000Z",
        );
        bad_scroll["scrollTop"] = json!(-1);
        let mut bad_created = stored_bookmark(
            "bm-bad-created",
            "bm-book-a",
            "ch_0001",
            "2026-11-15T00:00:08.000Z",
        );
        bad_created.as_object_mut().unwrap().remove("createdAt");
        let entries = json!([
            stored_bookmark(
                "bm-1-0000",
                "bm-book-a",
                "ch_0001",
                "2026-11-15T00:00:01.000Z"
            ),
            stored_bookmark(
                "bm-2-0000",
                "bm-book-b",
                "ch_b1",
                "2026-11-15T00:00:02.000Z"
            ),
            stored_bookmark(
                "bm-3-0000",
                "bm-book-a",
                "ch_0001",
                "2026-11-15T00:00:03.000Z"
            ),
            json!("不是对象"),
            // 缺 id
            json!({
                "bookId": "bm-book-a", "chapterId": "ch_0001", "scrollTop": 0,
                "title": "缺 id", "panels": sample_panels(),
                "createdAt": "2026-11-15T00:00:04.000Z", "updatedAt": "2026-11-15T00:00:04.000Z",
            }),
            // 非法 bookId
            stored_bookmark(
                "bm-bad-book",
                "BAD ID",
                "ch_0001",
                "2026-11-15T00:00:05.000Z"
            ),
            // 非法 panels tab / 负数 scrollTop / 缺 createdAt
            bad_panel,
            bad_scroll,
            bad_created,
        ]);
        write_json(
            &bookmarks_path(&data),
            &json!({ "schemaVersion": 1, "bookmarks": entries }),
        )
        .unwrap();

        let all = list_bookmarks_into(&data, None).unwrap();
        let ids: Vec<&str> = all
            .iter()
            .map(|bookmark| bookmark["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["bm-3-0000", "bm-2-0000", "bm-1-0000"]);

        let only_a = list_bookmarks_into(&data, Some("bm-book-a")).unwrap();
        let ids: Vec<&str> = only_a
            .iter()
            .map(|bookmark| bookmark["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["bm-3-0000", "bm-1-0000"]);

        // 顶层不是当前版本 → 视为空列表（不迁移、不在读路径写盘）。
        write_json(
            &bookmarks_path(&data),
            &json!({ "schemaVersion": 2, "bookmarks": [stored_bookmark("bm-9-0000", "bm-book-a", "ch_0001", "2026-11-15T00:00:09.000Z")] }),
        )
        .unwrap();
        assert!(list_bookmarks_into(&data, None).unwrap().is_empty());

        let _ = fs::remove_dir_all(root);
    }

    // ---- 新字段（order / quoteStart / quoteEnd） ----

    #[test]
    fn order_and_quote_offsets_survive_build_normalize_and_update() {
        let root = temp_root("new-fields");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);

        // 1) build：新增时写入三个新字段。
        let mut input = sample_input("bm-book-a", "ch_0001");
        input["order"] = json!(3);
        input["quoteStart"] = json!(2);
        input["quoteEnd"] = json!(5);
        let added = add_bookmark_at(&data, &input, 1_700_000_000_000).unwrap();
        assert_eq!(added["order"], json!(3));
        assert_eq!(added["quoteStart"], json!(2));
        assert_eq!(added["quoteEnd"], json!(5));
        let id = added["id"].as_str().unwrap().to_string();

        // 2) 落盘 + 读取 normalize：三处都保留。
        let stored = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        assert_eq!(stored["bookmarks"][0]["order"], json!(3));
        assert_eq!(stored["bookmarks"][0]["quoteStart"], json!(2));
        assert_eq!(stored["bookmarks"][0]["quoteEnd"], json!(5));
        let listed = list_bookmarks_into(&data, Some("bm-book-a")).unwrap();
        assert_eq!(listed[0]["order"], json!(3));
        assert_eq!(listed[0]["quoteStart"], json!(2));
        assert_eq!(listed[0]["quoteEnd"], json!(5));

        // 3) update patch：order 可改；quoteStart/quoteEnd 不属于 patch，保留原值；
        //    未知字段（panels 等）被忽略，不会冲掉阅读现场。
        let updated = update_bookmark_into(
            &data,
            &id,
            &json!({
                "title": "改名",
                "order": 7,
                "quoteStart": 0,
                "quoteEnd": 0,
                "panels": { "leftOpen": false },
            }),
        )
        .unwrap();
        assert_eq!(updated["title"], json!("改名"));
        assert_eq!(updated["order"], json!(7));
        assert_eq!(updated["quoteStart"], json!(2));
        assert_eq!(updated["quoteEnd"], json!(5));
        assert_eq!(updated["panels"], sample_panels());
        let after = list_bookmarks_into(&data, None).unwrap();
        assert_eq!(after[0]["order"], json!(7));

        // 4) update 显式 order:null → 退出手动排序（清除字段），其余保留。
        let cleared = update_bookmark_into(&data, &id, &json!({ "order": null })).unwrap();
        assert!(cleared.get("order").is_none());
        assert_eq!(cleared["quoteStart"], json!(2));
        assert_eq!(cleared["quoteEnd"], json!(5));

        // 5) 校验：超上限 / 负数 / 小数 / 单侧偏移 / 倒序偏移 → INVALID_INPUT，且不落盘。
        let before = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        for invalid in [
            json!({ "order": ORDER_MAX + 1 }),
            json!({ "order": -1 }),
            json!({ "order": 1.5 }),
            json!({ "quoteStart": 1 }),
            json!({ "quoteEnd": 1 }),
            json!({ "quoteStart": 5, "quoteEnd": 2 }),
            json!({ "quoteStart": QUOTE_OFFSET_MAX + 1, "quoteEnd": QUOTE_OFFSET_MAX + 1 }),
        ] {
            let mut invalid_input = sample_input("bm-book-a", "ch_0001");
            for (key, value) in invalid.as_object().unwrap() {
                invalid_input[key] = value.clone();
            }
            assert_eq!(
                error_code(add_bookmark_into(&data, &invalid_input)),
                "INVALID_INPUT",
                "非法输入应被拒绝：{invalid}"
            );
        }
        let after_invalid = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        assert_eq!(before, after_invalid, "非法输入不应改写 bookmarks.json");

        // 6) update 的非法 order：整条 patch 不生效（标题也不会被改）。
        assert_eq!(
            error_code(update_bookmark_into(
                &data,
                &id,
                &json!({ "title": "不应生效", "order": ORDER_MAX + 1 })
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            list_bookmarks_into(&data, None).unwrap()[0]["title"],
            json!("改名")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn old_records_without_new_fields_stay_compatible() {
        let root = temp_root("old-fields");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);

        // 旧记录（无新字段）：读取不补字段，也不因缺字段被过滤。
        let old = stored_bookmark(
            "bm-old-0000",
            "bm-book-a",
            "ch_0001",
            "2026-11-15T00:00:00.000Z",
        );
        write_json(
            &bookmarks_path(&data),
            &json!({ "schemaVersion": 1, "bookmarks": [old.clone()] }),
        )
        .unwrap();
        let listed = list_bookmarks_into(&data, Some("bm-book-a")).unwrap();
        assert_eq!(listed.len(), 1);
        for key in ["order", "quoteStart", "quoteEnd"] {
            assert!(listed[0].get(key).is_none(), "旧记录不应凭空补字段：{key}");
        }

        // 旧记录里的脏字段按缺省处理：单侧/倒序/超上限的偏移丢弃，order 超上限丢弃，但记录保留。
        let mut only_start = stored_bookmark(
            "bm-old-0001",
            "bm-book-a",
            "ch_0001",
            "2026-11-15T00:00:01.000Z",
        );
        only_start["quoteStart"] = json!(4);
        let mut reversed = stored_bookmark(
            "bm-old-0002",
            "bm-book-a",
            "ch_0001",
            "2026-11-15T00:00:02.000Z",
        );
        reversed["quoteStart"] = json!(9);
        reversed["quoteEnd"] = json!(3);
        let mut oversized = stored_bookmark(
            "bm-old-0003",
            "bm-book-a",
            "ch_0001",
            "2026-11-15T00:00:03.000Z",
        );
        oversized["order"] = json!(ORDER_MAX + 1);
        oversized["quoteStart"] = json!(0);
        oversized["quoteEnd"] = json!(1);
        write_json(
            &bookmarks_path(&data),
            &json!({ "schemaVersion": 1, "bookmarks": [old.clone(), only_start, reversed, oversized] }),
        )
        .unwrap();
        let listed = list_bookmarks_into(&data, Some("bm-book-a")).unwrap();
        assert_eq!(listed.len(), 4);
        let by_id = |id: &str| listed.iter().find(|item| item["id"] == json!(id)).unwrap();
        assert!(by_id("bm-old-0001").get("quoteStart").is_none());
        assert!(by_id("bm-old-0002").get("quoteEnd").is_none());
        assert!(by_id("bm-old-0003").get("order").is_none());
        assert_eq!(by_id("bm-old-0003")["quoteStart"], json!(0));
        assert_eq!(by_id("bm-old-0003")["quoteEnd"], json!(1));

        // 旧记录执行 rename 后仍是旧记录形态（不补字段）。
        let renamed =
            update_bookmark_into(&data, "bm-old-0000", &json!({ "title": "旧记录改名" })).unwrap();
        assert_eq!(renamed["title"], json!("旧记录改名"));
        for key in ["order", "quoteStart", "quoteEnd"] {
            assert!(renamed.get(key).is_none());
        }

        let _ = fs::remove_dir_all(root);
    }

    // ---- 批量删除 / 批量排序 ----

    #[test]
    fn batch_delete_is_idempotent_and_single_write() {
        let root = temp_root("batch-delete");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);
        let input = sample_input("bm-book-a", "ch_0001");
        let first = add_bookmark_at(&data, &input, 1_700_000_001_000).unwrap();
        let second = add_bookmark_at(&data, &input, 1_700_000_002_000).unwrap();
        let third = add_bookmark_at(&data, &input, 1_700_000_003_000).unwrap();
        let id = |value: &Value| value["id"].as_str().unwrap().to_string();

        // 空 ids：返回 0，且不创建 bookmarks.json。
        let missing = root.join("library-missing");
        assert_eq!(delete_bookmarks_into(&missing, &[]).unwrap(), 0);
        assert!(!bookmarks_path(&missing).exists());

        // 含非法 id 的整批：INVALID_INPUT，一条都不删。
        assert_eq!(
            error_code(delete_bookmarks_into(
                &data,
                &[id(&first), "  ".to_string()]
            )),
            "INVALID_INPUT"
        );
        assert_eq!(list_bookmarks_into(&data, None).unwrap().len(), 3);

        // 批量删除两条：一次写盘，返回 2。
        assert_eq!(
            delete_bookmarks_into(&data, &[id(&first), id(&second)]).unwrap(),
            2
        );
        let remaining = list_bookmarks_into(&data, None).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["id"], json!(id(&third)));
        assert_eq!(temp_files(&data), Vec::<String>::new());

        // 幂等：再删同一批返回 0，列表不变，不写坏文件。
        let snapshot = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        assert_eq!(
            delete_bookmarks_into(&data, &[id(&first), id(&second)]).unwrap(),
            0
        );
        assert_eq!(
            read_json_opt(&bookmarks_path(&data)).unwrap().unwrap(),
            snapshot
        );

        // 混合批量（存在 + 不存在）返回实际删除条数。
        assert_eq!(
            delete_bookmarks_into(&data, &[id(&third), "bm-nope-0000".to_string()]).unwrap(),
            1
        );
        let stored = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        assert_eq!(stored["schemaVersion"], json!(1));
        assert_eq!(stored["bookmarks"], json!([]));
        assert_eq!(temp_files(&data), Vec::<String>::new());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn batch_update_orders_is_scoped_atomic_and_idempotent() {
        let root = temp_root("batch-orders");
        let data = root.join("library");
        write_book(&data, "bm-book-a", &["ch_0001"], 2);
        write_book(&data, "bm-book-b", &["ch_b1"], 2);
        let input_a = sample_input("bm-book-a", "ch_0001");
        let input_b = sample_input("bm-book-b", "ch_b1");
        let a1 = add_bookmark_at(&data, &input_a, 1_700_000_001_000).unwrap();
        let a2 = add_bookmark_at(&data, &input_a, 1_700_000_002_000).unwrap();
        let b1 = add_bookmark_at(&data, &input_b, 1_700_000_003_000).unwrap();
        let id = |value: &Value| value["id"].as_str().unwrap().to_string();

        // 成功：一次写盘，a1/a2 的 order 生效，b1 不受影响。
        let updated = update_bookmark_orders_into(
            &data,
            "bm-book-a",
            &[
                json!({ "id": id(&a2), "order": 0 }),
                json!({ "id": id(&a1), "order": 1 }),
            ],
        )
        .unwrap();
        assert_eq!(updated, 2);
        let ordered = list_bookmarks_into(&data, Some("bm-book-a")).unwrap();
        let order_of = |list: &[Value], target: &str| {
            list.iter()
                .find(|item| item["id"] == json!(target))
                .and_then(|item| item.get("order").cloned())
        };
        assert_eq!(order_of(&ordered, &id(&a2)), Some(json!(0)));
        assert_eq!(order_of(&ordered, &id(&a1)), Some(json!(1)));
        assert_eq!(order_of(&ordered, &id(&b1)), None);
        assert_eq!(temp_files(&data), Vec::<String>::new());

        // 幂等：重复提交相同顺序仍返回 2，文件内容不变（不重复写盘）。
        let snapshot = read_json_opt(&bookmarks_path(&data)).unwrap().unwrap();
        assert_eq!(
            update_bookmark_orders_into(
                &data,
                "bm-book-a",
                &[
                    json!({ "id": id(&a2), "order": 0 }),
                    json!({ "id": id(&a1), "order": 1 }),
                ],
            )
            .unwrap(),
            2
        );
        assert_eq!(
            read_json_opt(&bookmarks_path(&data)).unwrap().unwrap(),
            snapshot
        );

        // 原子性：批内任一 id 不存在 → NOT_FOUND，整批不生效（前面的合法项也不写）。
        let before = fs::read_to_string(bookmarks_path(&data)).unwrap();
        assert_eq!(
            error_code(update_bookmark_orders_into(
                &data,
                "bm-book-a",
                &[
                    json!({ "id": id(&a1), "order": 9 }),
                    json!({ "id": "bm-nope-0000", "order": 0 }),
                ],
            )),
            "NOT_FOUND"
        );
        assert_eq!(fs::read_to_string(bookmarks_path(&data)).unwrap(), before);

        // 跨书 id：b1 不属于 bm-book-a → NOT_FOUND，不生效。
        assert_eq!(
            error_code(update_bookmark_orders_into(
                &data,
                "bm-book-a",
                &[json!({ "id": id(&b1), "order": 0 })],
            )),
            "NOT_FOUND"
        );

        // 非法输入：重复 id / 缺 order / order 超上限 / bookId 非法。
        assert_eq!(
            error_code(update_bookmark_orders_into(
                &data,
                "bm-book-a",
                &[
                    json!({ "id": id(&a1), "order": 0 }),
                    json!({ "id": id(&a1), "order": 1 }),
                ],
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(update_bookmark_orders_into(
                &data,
                "bm-book-a",
                &[json!({ "id": id(&a1) })],
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(update_bookmark_orders_into(
                &data,
                "bm-book-a",
                &[json!({ "id": id(&a1), "order": ORDER_MAX + 1 })],
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(update_bookmark_orders_into(
                &data,
                "../bad",
                &[json!({ "id": id(&a1), "order": 0 })],
            )),
            "INVALID_INPUT"
        );

        // 空 orders：返回 0 且不写盘。
        let snapshot = fs::read_to_string(bookmarks_path(&data)).unwrap();
        assert_eq!(
            update_bookmark_orders_into(&data, "bm-book-a", &[]).unwrap(),
            0
        );
        assert_eq!(fs::read_to_string(bookmarks_path(&data)).unwrap(), snapshot);

        let _ = fs::remove_dir_all(root);
    }
}
