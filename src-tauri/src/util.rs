//! `library.rs` / `bookmarks.rs` 共享的小工具。
//!
//! 这些辅助原先在两个模块里各有一份（注释里互相标注「同实现」），抽到 crate 根
//! `util` 模块后只保留一处实现；`mod util;` 由 lib.rs 声明。
//!
//! 依赖方向：`util` → `library`（底层 JSON 读取、毫秒时间、bookId 校验仍留在 library.rs），
//! `library` / `bookmarks` → `util`。Rust 模块间循环引用是允许的，这里只引用具体函数，
//! 没有初始化顺序问题。

use std::path::Path;

use serde_json::Value;

use crate::library::{now_millis, read_json_opt, valid_book_id};

/// `book.json` / `index.json` / `manifest.json` 的有效数据版本。
pub(crate) const BOOK_SCHEMA_VERSION: u64 = 2;

/// 章节 id 合法性：非空、≤128 字节、不以 `.` 开头，只含 ASCII 字母/数字/`-`/`_`。
pub(crate) fn valid_chapter_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 || id.starts_with('.') {
        return false;
    }
    id.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// 当前 UTC 时间（RFC3339，毫秒精度）。
pub(crate) fn now_rfc3339() -> String {
    rfc3339_from_millis(now_millis())
}

/// Unix 毫秒 → RFC3339（UTC，`2026-11-15T00:00:00.000Z`）。
pub(crate) fn rfc3339_from_millis(millis: u128) -> String {
    let total_seconds = (millis / 1000) as i64;
    let sub_millis = (millis % 1000) as u32;
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{sub_millis:03}Z")
}

/// 公历「自 1970-01-01 起的天数」→ (年, 月, 日)（Howard Hinnant 算法）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `book.json` 是否为当前可用的书籍记录：
/// - schemaVersion 必须为当前版本；
/// - 正常书必须有章节；`allow_pending` 为 true 时接受 `chapterIds: []` +
///   `parseState: "pending"` 的**原始文件书**（非 EPUB，标待解析；无章节但仍是合法书籍）。
///
/// 阅读器/书签路径传 false（pending 书不能加书签/读章节），书库与最近阅读传 true。
pub(crate) fn is_valid_book(book: &Value, allow_pending: bool) -> bool {
    let schema_ok = book.get("schemaVersion").and_then(Value::as_u64) == Some(BOOK_SCHEMA_VERSION);
    let has_chapters = book
        .get("chapterIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| !ids.is_empty());
    let pending =
        allow_pending && book.get("parseState").and_then(Value::as_str) == Some("pending");
    schema_ok && (has_chapters || pending)
}

/// 读取 `books/<bookId>/book.json` 并校验；缺失/损坏（JSON 解析失败）/格式不符 → None。
pub(crate) fn load_valid_book(
    books_root: &Path,
    book_id: &str,
    allow_pending: bool,
) -> Option<Value> {
    if !valid_book_id(book_id) {
        return None;
    }
    let book = read_json_opt(&books_root.join(book_id).join("book.json"))
        .ok()
        .flatten()?;
    is_valid_book(&book, allow_pending).then_some(book)
}
