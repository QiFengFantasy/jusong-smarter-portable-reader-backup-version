//! Rust Content API：Tauri 运行时唯一的文件系统访问点。
//!
//! P2 阶段实现读路径（书目/目录/章节/摘要/档案/专题/资产）与种子首启复制；
//! 写路径（导入、摘要回写）在 P3 补齐。所有路径解析都限制在用户库 dataDir 内。

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
#[cfg(target_os = "android")]
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

use crate::util::{now_rfc3339, valid_chapter_id};

const SCHEMA_VERSION: u64 = crate::util::BOOK_SCHEMA_VERSION;

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self::new("IO", message)
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_INPUT", message)
    }
}

#[cfg(debug_assertions)]
pub(crate) fn debug_log(command: &str) {
    eprintln!("[jusong:library] {command}");
}

#[cfg(not(debug_assertions))]
pub(crate) fn debug_log(_command: &str) {}

/// 用户库目录：开发态为仓库 data/library，生产态为 appData/library。
pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, ApiError> {
    if let Ok(dir) = std::env::var("JUSONG_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if cfg!(debug_assertions) && !cfg!(target_os = "android") {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("data")
            .join("library"));
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| ApiError::io(format!("无法获取 appData 目录：{error}")))?;
    Ok(base.join("library"))
}

/// 内容源目录：开发态为仓库 data/books，生产态为安装包资源里的 seed/。
fn content_dir(app: &AppHandle) -> Result<PathBuf, ApiError> {
    if let Ok(dir) = std::env::var("JUSONG_CONTENT_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("data")
            .join("books"));
    }
    app.path()
        .resolve("resources/seed", BaseDirectory::Resource)
        .map_err(|error| ApiError::io(format!("无法解析内置种子内容目录：{error}")))
}

pub(crate) fn valid_book_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 4 || bytes.len() > 64 {
        return false;
    }
    let edge_ok = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    if !edge_ok(bytes[0]) || !edge_ok(bytes[bytes.len() - 1]) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// `book.json` 是否为当前可用的书籍记录（库侧口径：允许 `parseState: "pending"`
/// 的原始文件书，见 `util::is_valid_book`）。
fn is_valid_book(book: &Value) -> bool {
    crate::util::is_valid_book(book, true)
}

fn books_dir(app: &AppHandle) -> Result<PathBuf, ApiError> {
    Ok(data_dir(app)?.join("books"))
}

pub(crate) fn book_dir(app: &AppHandle, book_id: &str) -> Result<PathBuf, ApiError> {
    if !valid_book_id(book_id) {
        return Err(ApiError::invalid(format!("非法 bookId：{book_id}")));
    }
    Ok(books_dir(app)?.join(book_id))
}

fn chapter_dir(app: &AppHandle, book_id: &str, chapter_id: &str) -> Result<PathBuf, ApiError> {
    if !valid_chapter_id(chapter_id) {
        return Err(ApiError::invalid(format!("非法 chapterId：{chapter_id}")));
    }
    Ok(book_dir(app, book_id)?.join("chapters").join(chapter_id))
}

pub(crate) fn read_json_opt(path: &Path) -> Result<Option<Value>, ApiError> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|error| {
            ApiError::io(format!("解析 JSON 失败（{}）：{error}", path.display()))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ApiError::io(format!(
            "读取文件失败（{}）：{error}",
            path.display()
        ))),
    }
}

pub(crate) fn write_json(path: &Path, value: &Value) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            ApiError::io(format!("创建目录失败（{}）：{error}", parent.display()))
        })?;
    }
    let temp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| ApiError::io(format!("序列化 JSON 失败：{error}")))?;
    fs::write(&temp, text).map_err(|error| {
        ApiError::io(format!("写入临时文件失败（{}）：{error}", temp.display()))
    })?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            ApiError::io(format!("替换文件失败（{}）：{error}", path.display()))
        })?;
    }
    fs::rename(&temp, path)
        .map_err(|error| ApiError::io(format!("重命名文件失败（{}）：{error}", path.display())))?;
    Ok(())
}

/// 递归复制目录；跳过派生缓存 seed.json（用户库不需要它）。
fn copy_dir(source: &Path, target: &Path) -> Result<(), ApiError> {
    fs::create_dir_all(target)
        .map_err(|error| ApiError::io(format!("创建目录失败（{}）：{error}", target.display())))?;
    for entry in fs::read_dir(source)
        .map_err(|error| ApiError::io(format!("读取目录失败（{}）：{error}", source.display())))?
    {
        let entry = entry.map_err(|error| ApiError::io(format!("读取目录项失败：{error}")))?;
        let name = entry.file_name();
        if name.to_string_lossy() == "seed.json" {
            continue;
        }
        let from = entry.path();
        let to = target.join(&name);
        if entry
            .file_type()
            .map_err(|error| ApiError::io(format!("读取文件类型失败：{error}")))?
            .is_dir()
        {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|error| {
                ApiError::io(format!(
                    "复制文件失败（{} → {}）：{error}",
                    from.display(),
                    to.display()
                ))
            })?;
        }
    }
    Ok(())
}

/// 写路径串行锁：导入、种子安装、摘要回写共享同一把锁，避免并发写 index/manifest。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn write_guard() -> Result<MutexGuard<'static, ()>, ApiError> {
    WRITE_LOCK
        .lock()
        .map_err(|_| ApiError::io("写锁中毒：前一次写入发生 panic"))
}

pub(crate) async fn run<T, F>(task: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ApiError> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(task).await {
        Ok(result) => result,
        Err(error) => Err(ApiError::io(format!("后台任务失败：{error}"))),
    }
}

#[tauri::command]
pub async fn library_info(app: AppHandle) -> Result<Value, ApiError> {
    debug_log("info");
    run(move || {
        let data = data_dir(&app)?;
        let content = content_dir(&app)?;
        Ok(json!({
            "dataDir": data.to_string_lossy(),
            "contentDir": content.to_string_lossy(),
            "storage": "tauri",
            "schemaVersion": SCHEMA_VERSION,
            "debug": cfg!(debug_assertions),
        }))
    })
    .await
}

/// 首启/升级：把内容源里的种子书复制进用户库，并维护 index.json / manifest.json。
#[tauri::command]
pub async fn library_ensure_seed(app: AppHandle) -> Result<Value, ApiError> {
    debug_log("ensure_seed");
    #[cfg(target_os = "android")]
    {
        return run(move || {
            let data = data_dir(&app)?;
            ensure_seed_from_pack(&app, &data)
        })
        .await;
    }
    #[cfg(not(target_os = "android"))]
    {
        run(move || {
            let data = data_dir(&app)?;
            let content = content_dir(&app)?;
            ensure_seed_into(&data, &content)
        })
        .await
    }
}

/// Android：种子内容作为前端资产嵌入（asset_resolver 读取 seed-pack.json），写入用户库。
#[cfg(target_os = "android")]
fn ensure_seed_from_pack(app: &AppHandle, data: &Path) -> Result<Value, ApiError> {
    let asset = app
        .asset_resolver()
        .get("seed/seed-pack.json".to_string())
        .ok_or_else(|| ApiError::io("安装包缺少种子内容（seed/seed-pack.json）"))?;
    let pack: Value = serde_json::from_slice(&asset.bytes)
        .map_err(|error| ApiError::io(format!("解析种子内容失败：{error}")))?;
    ensure_seed_from_pack_value(data, &pack)
}

/// 解析后的种子包写入用户库（不依赖 Tauri runtime，便于单元测试）。
/// 含 `cover: { mime, base64 }` 时落盘 `cover.jpg`；已有旧版种子副本缺封面时补齐。
#[cfg_attr(not(target_os = "android"), allow(dead_code))] // 桌面构建只在单元测试里使用
fn ensure_seed_from_pack_value(data: &Path, pack: &Value) -> Result<Value, ApiError> {
    let _guard = write_guard()?;
    let books = data.join("books");
    fs::create_dir_all(&books).map_err(|error| ApiError::io(format!("创建用户库失败：{error}")))?;

    let pack_books = pack
        .get("books")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut installed: Vec<String> = Vec::new();
    let mut seed_books: Vec<Value> = Vec::new();
    for entry in pack_books {
        let Some(book) = entry.get("book") else {
            continue;
        };
        let Some(id) = book.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !valid_book_id(id) {
            continue;
        }
        let target = books.join(id);
        if !target.join("book.json").exists() {
            let write_book_file = |relative: &str, value: &Value| -> Result<(), ApiError> {
                let path = target.join(relative);
                write_json(&path, value)
            };
            write_book_file("book.json", book)?;
            if let Some(toc) = entry.get("toc") {
                write_book_file("toc.json", toc)?;
            }
            if let Some(knowledge) = entry.get("knowledge").and_then(Value::as_array) {
                if !knowledge.is_empty() {
                    write_book_file("shared/archives.json", &json!({ "entries": knowledge }))?;
                }
            }
            if let Some(topics) = entry.get("topics") {
                if let Some(map) = topics.get("map").filter(|value| !value.is_null()) {
                    write_book_file("shared/topics/map.json", map)?;
                }
                if let Some(timeline) = topics.get("timeline").filter(|value| !value.is_null()) {
                    write_book_file("shared/topics/timeline.json", timeline)?;
                }
            }
            if let Some(chapters) = entry.get("chapters").and_then(Value::as_array) {
                for chapter_entry in chapters {
                    let Some(chapter) = chapter_entry.get("chapter") else {
                        continue;
                    };
                    let Some(chapter_id) = chapter.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    if !valid_chapter_id(chapter_id) {
                        continue;
                    }
                    write_book_file(&format!("chapters/{chapter_id}/chapter.json"), chapter)?;
                    if let Some(digest) = chapter_entry.get("digest").filter(|v| !v.is_null()) {
                        write_book_file(&format!("chapters/{chapter_id}/digest.json"), digest)?;
                    }
                    if let Some(map) = chapter_entry.get("map").filter(|v| !v.is_null()) {
                        write_book_file(&format!("chapters/{chapter_id}/map.json"), map)?;
                    }
                }
            }
            installed.push(id.to_string());
        }
        if target.join("book.json").exists() {
            // 新装或已有旧版种子副本：有 cover 数据时落盘并补齐 book.json。
            let mut meta = book.clone();
            if let Some((file, mime)) = ensure_pack_cover(&target, book, entry.get("cover"))? {
                meta["coverFile"] = json!(file);
                meta["coverMime"] = json!(mime);
            }
            seed_books.push(meta);
        }
    }

    let value = finalize_seed(data, &books, seed_books, installed)?;
    Ok(value)
}

/// 生成 index.json / manifest.json，并清理旧种子副本（桌面与 Android 共用）。
fn finalize_seed(
    data: &Path,
    books: &Path,
    seed_books: Vec<Value>,
    installed: Vec<String>,
) -> Result<Value, ApiError> {
    if seed_books.is_empty() {
        return Err(ApiError::io("内容源没有找到可安装的种子书，拒绝清理用户库"));
    }
    let current_ids: Vec<String> = seed_books
        .iter()
        .filter_map(|book| book.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let previous_manifest = read_json_opt(&data.join("manifest.json"))?;
    let previous_seed_ids: Vec<String> = previous_manifest
        .as_ref()
        .and_then(|manifest| manifest.get("seeds"))
        .and_then(Value::as_array)
        .map(|seeds| {
            seeds
                .iter()
                .filter_map(|seed| seed.get("bookId").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let mut removed: Vec<String> = Vec::new();
    for id in previous_seed_ids {
        if current_ids.iter().any(|current| current == &id) || !valid_book_id(&id) {
            continue;
        }
        let target = books.join(&id);
        if target.exists() {
            fs::remove_dir_all(&target)
                .map_err(|error| ApiError::io(format!("清理旧种子书失败（{id}）：{error}")))?;
            removed.push(id);
        }
    }

    let mut index_books = seed_books.clone();
    if let Some(existing) = read_json_opt(&books.join("index.json"))? {
        for entry in existing
            .get("books")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let Some(id) = entry.get("id").and_then(Value::as_str) else {
                continue;
            };
            if index_books
                .iter()
                .any(|book| book.get("id").and_then(Value::as_str) == Some(id))
                || removed.iter().any(|removed_id| removed_id == id)
            {
                continue;
            }
            index_books.push(entry);
        }
    }
    write_json(
        &books.join("index.json"),
        &json!({ "schemaVersion": SCHEMA_VERSION, "books": index_books }),
    )?;

    let mut manifest = previous_manifest
        .unwrap_or_else(|| json!({ "schemaVersion": SCHEMA_VERSION, "seeds": [] }));
    manifest["schemaVersion"] = json!(SCHEMA_VERSION);
    let seed_ids: Vec<Value> = current_ids
        .iter()
        .map(|id| json!({ "bookId": id }))
        .collect();
    manifest["seeds"] = Value::Array(seed_ids);
    write_json(&data.join("manifest.json"), &manifest)?;

    Ok(json!({
        "installed": installed,
        "removed": removed,
        "dataDir": data.to_string_lossy(),
    }))
}

/// 桌面：从内容源目录复制种子书到用户库（不依赖 Tauri runtime，便于单元测试）。
fn ensure_seed_into(data: &Path, content: &Path) -> Result<Value, ApiError> {
    let _guard = write_guard()?;
    let books = data.join("books");
    fs::create_dir_all(&books).map_err(|error| ApiError::io(format!("创建用户库失败：{error}")))?;

    let content_index = read_json_opt(&content.join("index.json"))?;
    let seed_entries: Vec<Value> = content_index
        .as_ref()
        .and_then(|value| value.get("books"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut installed: Vec<String> = Vec::new();
    let mut seed_books: Vec<Value> = Vec::new();
    for mut entry in seed_entries {
        if entry.get("format").and_then(Value::as_str) != Some("seed") {
            continue;
        }
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !valid_book_id(id) {
            continue;
        }
        let source = content.join(id);
        let target = books.join(id);
        if !target.join("book.json").exists() {
            copy_dir(&source, &target)?;
            installed.push(id.to_string());
        }
        if target.join("book.json").exists() {
            // 新装（copy_dir 已带 cover）或已有旧版种子副本：确保封面落盘并补齐 book.json。
            if let Some((file, mime)) = refresh_seed_cover_from_dir(&target, &source, &entry)? {
                entry["coverFile"] = json!(file);
                entry["coverMime"] = json!(mime);
            }
            seed_books.push(entry);
        }
    }

    finalize_seed(data, &books, seed_books, installed)
}

#[tauri::command]
pub async fn library_list_books(app: AppHandle) -> Result<Value, ApiError> {
    debug_log("list_books");
    run(move || {
        let index = read_json_opt(&books_dir(&app)?.join("index.json"))?;
        Ok(index
            .and_then(|value| value.get("books").cloned())
            .unwrap_or_else(|| json!([])))
    })
    .await
}

#[tauri::command]
pub async fn library_get_book(app: AppHandle, book_id: String) -> Result<Value, ApiError> {
    debug_log("get_book");
    run(move || {
        let path = book_dir(&app, &book_id)?.join("book.json");
        let Some(book) = read_json_opt(&path)? else {
            return Ok(Value::Null);
        };
        if !is_valid_book(&book) {
            return Ok(Value::Null);
        }
        Ok(book)
    })
    .await
}

#[tauri::command]
pub async fn library_get_toc(app: AppHandle, book_id: String) -> Result<Value, ApiError> {
    debug_log("get_toc");
    run(move || {
        let path = book_dir(&app, &book_id)?.join("toc.json");
        Ok(read_json_opt(&path)?.unwrap_or_else(|| json!([])))
    })
    .await
}

#[tauri::command]
pub async fn library_get_chapter(
    app: AppHandle,
    book_id: String,
    chapter_id: String,
) -> Result<Value, ApiError> {
    debug_log("get_chapter");
    run(move || {
        let path = chapter_dir(&app, &book_id, &chapter_id)?.join("chapter.json");
        Ok(read_json_opt(&path)?.unwrap_or(Value::Null))
    })
    .await
}

#[tauri::command]
pub async fn library_get_chapter_digest(
    app: AppHandle,
    book_id: String,
    chapter_id: String,
) -> Result<Value, ApiError> {
    debug_log("get_chapter_digest");
    run(move || {
        let path = chapter_dir(&app, &book_id, &chapter_id)?.join("digest.json");
        Ok(read_json_opt(&path)?.unwrap_or(Value::Null))
    })
    .await
}

/// 一次读取某书全部章节摘要（替代前端逐章上百次 IPC）：只读一次 `book.json`，
/// 再按 `chapterIds` 顺序读取 `chapters/<id>/digest.json`；单章缺失/损坏
/// （JSON 解析失败或不是对象）跳过，不影响整批；原始文件书（无章节）返回空数组。
fn list_chapter_digests_into(books_root: &Path, book_id: &str) -> Result<Vec<Value>, ApiError> {
    if !valid_book_id(book_id) {
        return Err(ApiError::invalid(format!("非法 bookId：{book_id}")));
    }
    let Some(book) = load_valid_book(books_root, book_id) else {
        return Ok(Vec::new());
    };
    let chapter_ids = book
        .get("chapterIds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut digests = Vec::with_capacity(chapter_ids.len());
    for chapter_id in chapter_ids {
        let Some(chapter_id) = chapter_id.as_str() else {
            continue;
        };
        if !valid_chapter_id(chapter_id) {
            continue;
        }
        let path = books_root
            .join(book_id)
            .join("chapters")
            .join(chapter_id)
            .join("digest.json");
        let Some(digest) = read_json_lenient(&path) else {
            continue;
        };
        if digest.is_object() {
            digests.push(digest);
        }
    }
    Ok(digests)
}

/// 批量读取某书全部章节摘要（首页知识统计/知识库检索用，一次 spawn_blocking）。
#[tauri::command]
pub async fn library_list_chapter_digests(
    app: AppHandle,
    book_id: String,
) -> Result<Value, ApiError> {
    debug_log("list_chapter_digests");
    run(move || {
        let books_root = books_dir(&app)?;
        let digests = list_chapter_digests_into(&books_root, &book_id)?;
        Ok(Value::Array(digests))
    })
    .await
}

/// 探索投影里的 id 上限（placeId / routeId / themeId / eventId 都是短 slug）。
const EXPLORE_ID_MAX_CHARS: usize = 200;

/// 探索 id 数组：缺省/非数组视为空；过滤空串与超长项（宽松读取，不让单条脏数据毁整章）。
fn explore_string_ids(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty() && id.chars().count() <= EXPLORE_ID_MAX_CHARS)
                .map(|id| json!(id))
                .collect()
        })
        .unwrap_or_default()
}

/// 地图聚焦点：经纬度必须有限且在合法范围内；zoom 可选且非法时丢弃。
fn explore_focus(value: Option<&Value>) -> Value {
    let Some(object) = value.and_then(Value::as_object) else {
        return Value::Null;
    };
    let (Some(lon), Some(lat)) = (
        object.get("lon").and_then(Value::as_f64),
        object.get("lat").and_then(Value::as_f64),
    ) else {
        return Value::Null;
    };
    if !lon.is_finite()
        || !lat.is_finite()
        || !(-180.0..=180.0).contains(&lon)
        || !(-90.0..=90.0).contains(&lat)
    {
        return Value::Null;
    }
    let mut focus = json!({ "lon": lon, "lat": lat });
    if let Some(zoom) = object
        .get("zoom")
        .and_then(Value::as_f64)
        .filter(|zoom| zoom.is_finite() && *zoom >= 0.0)
    {
        focus["zoom"] = json!(zoom);
    }
    focus
}

/// 单章 `explore.json` → `ChapterExplore`；顶层结构/schemaVersion 损坏返回 None。
/// 宽松规范化：map/timeline 缺省或类型不对视为 null，数组缺省视为空；
/// bookId/chapterId 以调用参数为准（章节归属已由调用方校验）。
fn normalize_chapter_explore(book_id: &str, chapter_id: &str, value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let map = match object.get("map") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Object(map)) => json!({
            "placeIds": explore_string_ids(map.get("placeIds")),
            "routeIds": explore_string_ids(map.get("routeIds")),
            "themeIds": explore_string_ids(map.get("themeIds")),
            "focus": explore_focus(map.get("focus")),
        }),
        Some(_) => Value::Null,
    };
    let timeline = match object.get("timeline") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Object(timeline)) => {
            json!({ "eventIds": explore_string_ids(timeline.get("eventIds")) })
        }
        Some(_) => Value::Null,
    };
    Some(json!({
        "schemaVersion": 1,
        "bookId": book_id,
        "chapterId": chapter_id,
        "map": map,
        "timeline": timeline,
    }))
}

/// 读取章节探索投影：章节必须属于该书；explore.json 缺失/损坏/结构不合法 → null。
fn chapter_explore_into(
    books_root: &Path,
    book_id: &str,
    chapter_id: &str,
) -> Result<Value, ApiError> {
    if !valid_book_id(book_id) {
        return Err(ApiError::invalid(format!("非法 bookId：{book_id}")));
    }
    if !valid_chapter_id(chapter_id) {
        return Err(ApiError::invalid(format!("非法 chapterId：{chapter_id}")));
    }
    let Some(book) = load_valid_book(books_root, book_id) else {
        return Ok(Value::Null);
    };
    let belongs = book
        .get("chapterIds")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(chapter_id)));
    if !belongs {
        return Ok(Value::Null);
    }
    let path = books_root
        .join(book_id)
        .join("chapters")
        .join(chapter_id)
        .join("explore.json");
    // 缺失/损坏一律返回 null（探索面板据此回退到「其他」tab，不报错）。
    Ok(read_json_lenient(&path)
        .and_then(|explore| normalize_chapter_explore(book_id, chapter_id, &explore))
        .unwrap_or(Value::Null))
}

/// 读取章节探索投影（地图/时间线章节投影）；无数据返回 null。
#[tauri::command]
pub async fn library_get_chapter_explore(
    app: AppHandle,
    book_id: String,
    chapter_id: String,
) -> Result<Value, ApiError> {
    debug_log("get_chapter_explore");
    run(move || {
        let books_root = books_dir(&app)?;
        chapter_explore_into(&books_root, &book_id, &chapter_id)
    })
    .await
}

/// 读取某本书的档案条目（`shared/archives.json` 的 entries 数组；缺失返回空）。
fn archives_entries_from(book_dir: &Path) -> Result<Vec<Value>, ApiError> {
    let path = book_dir.join("shared/archives.json");
    Ok(read_json_opt(&path)?
        .and_then(|value| value.get("entries").cloned())
        .and_then(|entries| entries.as_array().cloned())
        .unwrap_or_default())
}

fn archives_entries(app: &AppHandle, book_id: &str) -> Result<Vec<Value>, ApiError> {
    archives_entries_from(&book_dir(app, book_id)?)
}

#[tauri::command]
pub async fn library_list_knowledge(
    app: AppHandle,
    book_id: String,
    chapter_id: Option<String>,
) -> Result<Value, ApiError> {
    debug_log("list_knowledge");
    run(move || {
        let entries = archives_entries(&app, &book_id)?;
        let filtered: Vec<Value> = match chapter_id {
            Some(chapter_id) => {
                if !valid_chapter_id(&chapter_id) {
                    return Err(ApiError::invalid(format!("非法 chapterId：{chapter_id}")));
                }
                entries
                    .into_iter()
                    .filter(|entry| {
                        entry.get("chapterId").and_then(Value::as_str) == Some(chapter_id.as_str())
                    })
                    .collect()
            }
            None => entries,
        };
        Ok(Value::Array(filtered))
    })
    .await
}

#[tauri::command]
pub async fn library_get_knowledge(
    app: AppHandle,
    book_id: String,
    entry_id: String,
) -> Result<Value, ApiError> {
    debug_log("get_knowledge");
    run(move || {
        let entries = archives_entries(&app, &book_id)?;
        Ok(entries
            .into_iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(entry_id.as_str()))
            .unwrap_or(Value::Null))
    })
    .await
}

// ---------------------------------------------------------------------------
// 知识库写入：AGENT 回答保存为档案条目（用户点「保存」，不是模型工具）。
// 写入 books/<bookId>/shared/archives.json；不改 book.json（chapterAssets 只反映
// 章节摘要/档案文件本身，不因 AGENT 笔记变化）。
// ---------------------------------------------------------------------------

/// 允许写入的知识条目类型（`@jusong/core` KnowledgeType 的可写子集）。
/// place/timeline 由导入构建流程（`import_build`）写入，payload 必须是对象。
const AGENT_KNOWLEDGE_TYPES: [&str; 4] = ["note", "search", "place", "timeline"];
const KNOWLEDGE_TITLE_MAX_CHARS: usize = 200;
const KNOWLEDGE_BODY_MAX_CHARS: usize = 20_000;

/// 生成唯一的知识条目 id：`agent-<毫秒>-<4位计数>`，与已有条目冲突时递增。
fn next_knowledge_id(existing_ids: &HashSet<String>, millis: u128) -> String {
    for attempt in 0..100_000u32 {
        let candidate = format!("agent-{millis}-{attempt:04}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
    }
    format!("agent-{millis}-{}", now_millis())
}

/// 追加知识条目的实现（不依赖 Tauri runtime，便于单元测试）。返回新条目。
#[allow(clippy::too_many_arguments)]
fn add_knowledge_into(
    books_root: &Path,
    book_id: &str,
    chapter_id: Option<&str>,
    entry_type: Option<&str>,
    title: &str,
    body: &str,
    payload: Option<&Value>,
) -> Result<Value, ApiError> {
    // 1) 书籍校验：与 library_get_book 同口径（schemaVersion 2 且含章节）。
    let Some(book) = load_valid_book(books_root, book_id) else {
        return Err(ApiError::new(
            "NOT_FOUND",
            format!("书籍不存在或不是当前数据格式：{book_id}"),
        ));
    };

    // 2) 章节校验：提供时必须在 book.chapterIds 内。
    let chapter_ids: Vec<&str> = book
        .get("chapterIds")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let chapter_id = chapter_id.map(str::trim).filter(|id| !id.is_empty());
    if let Some(chapter_id) = chapter_id {
        if !chapter_ids.contains(&chapter_id) {
            return Err(ApiError::invalid(format!("章节不属于本书：{chapter_id}")));
        }
    }

    // 3) 类型白名单：缺省 note；非法值拒绝（不做静默回落，避免前端误传被掩盖）。
    let entry_type = entry_type.map(str::trim).filter(|value| !value.is_empty());
    let entry_type = entry_type.unwrap_or("note");
    if !AGENT_KNOWLEDGE_TYPES.contains(&entry_type) {
        return Err(ApiError::invalid(format!(
            "不支持的知识条目类型：{entry_type}（可选 note / search / place / timeline）"
        )));
    }
    // place/timeline 是地图/时间线条目：payload 必须是 JSON 对象（承载坐标/日期等结构化字段）。
    if matches!(entry_type, "place" | "timeline") && !payload.is_some_and(Value::is_object) {
        return Err(ApiError::invalid(format!(
            "{entry_type} 知识条目的 payload 必须是 JSON 对象"
        )));
    }

    // 4) 标题/正文：按字符（不是字节）计，trim 后校验并存储。
    let title = title.trim();
    let title_chars = title.chars().count();
    if title_chars == 0 || title_chars > KNOWLEDGE_TITLE_MAX_CHARS {
        return Err(ApiError::invalid(format!(
            "标题长度需为 1–{KNOWLEDGE_TITLE_MAX_CHARS} 字符"
        )));
    }
    let body = body.trim();
    let body_chars = body.chars().count();
    if body_chars == 0 || body_chars > KNOWLEDGE_BODY_MAX_CHARS {
        return Err(ApiError::invalid(format!(
            "正文长度需为 1–{KNOWLEDGE_BODY_MAX_CHARS} 字符"
        )));
    }

    // 5) 读-改-写 archives.json：保留现有顶层结构，缺失字段按既有约定补齐。
    let _guard = write_guard()?;
    let book_directory = books_root.join(book_id);
    let archive_path = book_directory.join("shared/archives.json");
    let mut archive = match read_json_opt(&archive_path)? {
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(ApiError::new(
                "CORRUPTED",
                "archives.json 顶层不是 JSON 对象",
            ))
        }
        None => serde_json::Map::new(),
    };
    archive
        .entry("schemaVersion".to_string())
        .or_insert_with(|| json!(1));
    archive
        .entry("bookId".to_string())
        .or_insert_with(|| json!(book_id));
    let entries = archive
        .entry("entries".to_string())
        .or_insert_with(|| json!([]));
    let Some(entries) = entries.as_array_mut() else {
        return Err(ApiError::new(
            "CORRUPTED",
            "archives.json 的 entries 不是数组",
        ));
    };
    let existing_ids: HashSet<String> = entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let id = next_knowledge_id(&existing_ids, now_millis());

    let mut entry = serde_json::Map::new();
    entry.insert("id".to_string(), json!(id));
    entry.insert("bookId".to_string(), json!(book_id));
    if let Some(chapter_id) = chapter_id {
        entry.insert("chapterId".to_string(), json!(chapter_id));
    }
    entry.insert("type".to_string(), json!(entry_type));
    entry.insert("title".to_string(), json!(title));
    entry.insert("body".to_string(), json!(body));
    entry.insert("createdAt".to_string(), json!(now_rfc3339()));
    if let Some(payload) = payload {
        entry.insert("payload".to_string(), payload.clone());
    }
    let entry = Value::Object(entry);
    entries.push(entry.clone());
    write_json(&archive_path, &Value::Object(archive))?;
    Ok(entry)
}

/// 把 AGENT 回答追加为知识库条目（用户显式保存，不是模型自动工具）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn library_add_knowledge(
    app: AppHandle,
    book_id: String,
    chapter_id: Option<String>,
    entry_type: Option<String>,
    title: String,
    body: String,
    payload: Option<Value>,
) -> Result<Value, ApiError> {
    debug_log("add_knowledge");
    run(move || {
        let books_root = books_dir(&app)?;
        add_knowledge_into(
            &books_root,
            &book_id,
            chapter_id.as_deref(),
            entry_type.as_deref(),
            &title,
            &body,
            payload.as_ref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn library_get_chapter_assets(
    app: AppHandle,
    book_id: String,
    chapter_id: String,
) -> Result<Value, ApiError> {
    debug_log("get_chapter_assets");
    run(move || {
        if !valid_chapter_id(&chapter_id) {
            return Err(ApiError::invalid(format!("非法 chapterId：{chapter_id}")));
        }
        let dir = chapter_dir(&app, &book_id, &chapter_id)?;
        let book = read_json_opt(&book_dir(&app, &book_id)?.join("book.json"))?;
        if let Some(stored) = book
            .as_ref()
            .and_then(|value| value.get("chapterAssets"))
            .and_then(|assets| assets.get(&chapter_id))
        {
            return Ok(stored.clone());
        }

        let chapter = read_json_opt(&dir.join("chapter.json"))?;
        let digest = read_json_opt(&dir.join("digest.json"))?;
        let has_dossier = archives_entries(&app, &book_id)?.iter().any(|entry| {
            entry.get("chapterId").and_then(Value::as_str) == Some(chapter_id.as_str())
                && entry.get("type").and_then(Value::as_str) == Some("legacy-article")
        });
        let has_map = digest
            .as_ref()
            .and_then(|value| value.get("map"))
            .is_some_and(|map| {
                ["placeIds", "routeIds"].iter().any(|key| {
                    map.get(*key)
                        .and_then(Value::as_array)
                        .is_some_and(|items| !items.is_empty())
                })
            });
        let has_notes = chapter
            .as_ref()
            .and_then(|value| value.get("blocks"))
            .and_then(Value::as_array)
            .is_some_and(|blocks| {
                blocks
                    .iter()
                    .any(|block| block.get("kind").and_then(Value::as_str) == Some("note"))
            });
        Ok(json!({
            "hasContent": chapter.is_some(),
            "hasDigest": digest.is_some(),
            "hasDossier": has_dossier,
            "hasMap": has_map,
            "hasNotes": has_notes,
        }))
    })
    .await
}

#[tauri::command]
pub async fn library_get_book_topics(app: AppHandle, book_id: String) -> Result<Value, ApiError> {
    debug_log("get_book_topics");
    run(move || {
        let base = book_dir(&app, &book_id)?;
        let mut map = read_json_opt(&base.join("shared/topics/map.json"))?;
        let mut timeline = read_json_opt(&base.join("shared/topics/timeline.json"))?;
        // 兼容旧布局（仅存档；新用户库不会走到这里）。
        if map.is_none() {
            map = read_json_opt(&base.join("knowledge/topics/map.json"))?;
        }
        if timeline.is_none() {
            timeline = read_json_opt(&base.join("knowledge/topics/timeline.json"))?;
        }
        Ok(json!({ "map": map, "timeline": timeline }))
    })
    .await
}

// ---------------------------------------------------------------------------
// 写入路径（P3）：读取原文件、原子导入 EPUB、摘要回写
// ---------------------------------------------------------------------------

const MAX_EPUB_BYTES: u64 = 256 * 1024 * 1024;
/// 封面入库大小上限（解码后字节）；与 packages/core `COVER_MAX_DECODED_BYTES` 一致。
const MAX_COVER_BYTES: usize = 2 * 1024 * 1024;
const COVER_FILE_NAME: &str = "cover.jpg";
const COVER_MIME: &str = "image/jpeg";

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn sanitize_slug(value: &str) -> String {
    let mut slug = String::new();
    for character in value.chars() {
        let lower = character.to_ascii_lowercase();
        if lower.is_ascii_lowercase() || lower.is_ascii_digit() {
            slug.push(lower);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 32 {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "book".to_string()
    } else {
        slug
    }
}

fn sanitize_file_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = cleaned
        .trim_matches(|character: char| character == '.' || character == ' ')
        .to_string();
    if trimmed.is_empty() {
        "source.epub".to_string()
    } else {
        trimmed
    }
}

/// 解码 content:// URI 片段里的百分号转义（只处理路径常用字符，非法序列原样保留）。
#[cfg(target_os = "android")]
fn percent_decode_uri(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let pair = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(pair, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Android content:// URI → 可读文件名；找不到时回退 `upload.bin`。
#[cfg(target_os = "android")]
fn content_uri_file_name(uri: &str) -> String {
    let last = uri.rsplit('/').next().unwrap_or("upload.bin");
    let decoded = percent_decode_uri(last);
    let name = decoded
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("upload.bin")
        .trim();
    if name.is_empty() || name == "." || name == ".." {
        "upload.bin".to_string()
    } else {
        name.to_string()
    }
}

/// Android 文件选择器返回的是 `content://` URI，不能直接交给 `std::fs`；
/// 用 tauri-plugin-fs 通过 ContentResolver 读出字节，落到应用缓存目录，
/// 返回（可读路径, 需要清理的临时目录）。桌面/普通路径原样返回。
#[cfg(target_os = "android")]
pub(crate) fn materialize_picked_source(
    app: &AppHandle,
    raw: &str,
) -> Result<(PathBuf, Option<PathBuf>), ApiError> {
    if !raw.starts_with("content://") {
        return Ok((PathBuf::from(raw), None));
    }
    use tauri_plugin_fs::{FsExt, OpenOptions};

    let url = tauri::Url::parse(raw)
        .map_err(|error| ApiError::invalid(format!("无效的文件 URI（{raw}）：{error}")))?;
    let mut options = OpenOptions::new();
    options.read(true);
    let mut file = app
        .fs()
        .open(url, options)
        .map_err(|error| ApiError::io(format!("无法读取选择的文件（{raw}）：{error}")))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| ApiError::io(format!("读取选择的文件失败（{raw}）：{error}")))?;

    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| ApiError::io(format!("无法定位应用缓存目录：{error}")))?
        .join(format!("jusong-picked-{}", now_millis()));
    fs::create_dir_all(&directory)
        .map_err(|error| ApiError::io(format!("创建导入缓存目录失败：{error}")))?;
    let path = directory.join(content_uri_file_name(raw));
    fs::write(&path, &bytes)
        .map_err(|error| ApiError::io(format!("写入导入缓存文件失败：{error}")))?;
    Ok((path, Some(directory)))
}

#[cfg(not(target_os = "android"))]
pub(crate) fn materialize_picked_source(
    _app: &AppHandle,
    raw: &str,
) -> Result<(PathBuf, Option<PathBuf>), ApiError> {
    Ok((PathBuf::from(raw), None))
}

fn read_epub_file(path: &Path) -> Result<Vec<u8>, ApiError> {
    let metadata = fs::metadata(path).map_err(|error| {
        ApiError::io(format!("无法读取文件信息（{}）：{error}", path.display()))
    })?;
    if metadata.len() > MAX_EPUB_BYTES {
        return Err(ApiError::invalid("文件过大：EPUB 上限 256 MB"));
    }
    let bytes = fs::read(path).map_err(|error| ApiError::io(format!("读取 EPUB 失败：{error}")))?;
    // Android content:// URI 落到缓存后可能没有 .epub 扩展名；此时用 ZIP 魔数识别。
    // 带 .epub 扩展名的文件仍交给前端 parseEpub 做结构校验（兼容单测中的占位字节）。
    let extension_is_epub = path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"));
    if !extension_is_epub && (bytes.len() < 4 || &bytes[..2] != b"PK") {
        return Err(ApiError::invalid("请选择 .epub 格式的电子书"));
    }
    Ok(bytes)
}

/// 读取原 EPUB 字节（dialog 选择后交给前端解析）。
#[tauri::command]
pub async fn library_read_epub(
    app: AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, ApiError> {
    debug_log("read_epub");
    run(move || {
        let (source, temporary) = materialize_picked_source(&app, &path)?;
        let result = read_epub_file(&source);
        if let Some(directory) = temporary {
            let _ = fs::remove_dir_all(directory);
        }
        result
    })
    .await
    .map(tauri::ipc::Response::new)
}

/// 解码导入 IPC 传来的 base64 封面；解码失败、空内容、非图片 MIME 或超过 2 MB
/// 时返回 None（导入继续，书籍回落占位封面）。
fn decode_cover(cover: Option<&str>, cover_mime: Option<&str>) -> Option<Vec<u8>> {
    if let Some(mime) = cover_mime {
        let mime = mime.trim().to_ascii_lowercase();
        if !mime.is_empty() && !mime.starts_with("image/") {
            return None;
        }
    }
    let encoded = cover?.trim();
    if encoded.is_empty() {
        return None;
    }
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_COVER_BYTES {
        return None;
    }
    Some(bytes)
}

/// 封面文件名白名单：只允许普通文件名，拒绝路径分隔符与 `..`（防目录逃逸）。
fn valid_cover_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/// 原子写二进制资产（封面等非 JSON 文件）：写 `<name>.tmp` 后 rename。
fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            ApiError::io(format!("创建目录失败（{}）：{error}", parent.display()))
        })?;
    }
    let file_name = path.file_name().and_then(OsStr::to_str).unwrap_or("asset");
    let temp = path.with_file_name(format!("{file_name}.tmp"));
    fs::write(&temp, bytes).map_err(|error| {
        ApiError::io(format!("写入临时文件失败（{}）：{error}", temp.display()))
    })?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            ApiError::io(format!("替换文件失败（{}）：{error}", path.display()))
        })?;
    }
    fs::rename(&temp, path)
        .map_err(|error| ApiError::io(format!("重命名文件失败（{}）：{error}", path.display())))?;
    Ok(())
}

/// 读取目标书目录已登记的封面：book.json 的 coverFile 指向的文件存在时返回
/// `(coverFile, coverMime)`。用于种子书封面刷新前判断是否已处理过。
fn stored_cover(target: &Path) -> Option<(String, String)> {
    let book = read_json_opt(&target.join("book.json")).ok().flatten()?;
    let file = book.get("coverFile").and_then(Value::as_str)?;
    if !valid_cover_file_name(file) || !target.join(file).exists() {
        return None;
    }
    let mime = book
        .get("coverMime")
        .and_then(Value::as_str)
        .filter(|mime| mime.starts_with("image/"))
        .unwrap_or(COVER_MIME);
    Some((file.to_string(), mime.to_string()))
}

/// 已有种子书补齐封面（桌面 / 内容源目录）：目标缺封面而内容源有 cover 文件时
/// 复制并更新 book.json。返回补齐后的 `(coverFile, coverMime)`；无需处理返回 None。
fn refresh_seed_cover_from_dir(
    target: &Path,
    source_dir: &Path,
    entry: &Value,
) -> Result<Option<(String, String)>, ApiError> {
    if let Some(cover) = stored_cover(target) {
        return Ok(Some(cover));
    }
    let Some(mut stored) = read_json_opt(&target.join("book.json"))? else {
        return Ok(None);
    };
    let source_book = read_json_opt(&source_dir.join("book.json")).ok().flatten();
    let mut candidates: Vec<String> = Vec::new();
    for value in [
        entry.get("coverFile"),
        source_book.as_ref().and_then(|book| book.get("coverFile")),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(name) = value.as_str().filter(|name| valid_cover_file_name(name)) {
            candidates.push(name.to_string());
        }
    }
    for name in [COVER_FILE_NAME, "cover.jpeg", "cover.png"] {
        candidates.push(name.to_string());
    }
    let Some(file) = candidates
        .into_iter()
        .find(|name| source_dir.join(name).is_file())
    else {
        return Ok(None);
    };
    let source_path = source_dir.join(&file);
    let bytes = fs::read(&source_path).map_err(|error| {
        ApiError::io(format!(
            "读取种子封面失败（{}）：{error}",
            source_path.display()
        ))
    })?;
    if bytes.is_empty() || bytes.len() > MAX_COVER_BYTES {
        return Ok(None);
    }
    let mime = entry
        .get("coverMime")
        .and_then(Value::as_str)
        .filter(|mime| mime.starts_with("image/"))
        .or_else(|| {
            source_book
                .as_ref()
                .and_then(|book| book.get("coverMime"))
                .and_then(Value::as_str)
                .filter(|mime| mime.starts_with("image/"))
        })
        .unwrap_or(COVER_MIME)
        .to_string();
    write_bytes_atomic(&target.join(&file), &bytes)?;
    if let Value::Object(object) = &mut stored {
        object.insert("coverFile".to_string(), json!(file));
        object.insert("coverMime".to_string(), json!(mime));
    }
    write_json(&target.join("book.json"), &stored)?;
    Ok(Some((file, mime)))
}

/// 种子包封面（Android）：把 pack 条目的 `cover: { mime, base64 }` 解码写入目标书目录，
/// 并补齐 book.json 的 coverFile/coverMime。新装与已有旧版种子副本共用。
/// 返回 `(coverFile, coverMime)`；无可用封面返回 None。
#[cfg_attr(not(target_os = "android"), allow(dead_code))] // 桌面构建只在单元测试里使用
fn ensure_pack_cover(
    target: &Path,
    book: &Value,
    cover: Option<&Value>,
) -> Result<Option<(String, String)>, ApiError> {
    if let Some(stored) = stored_cover(target) {
        return Ok(Some(stored));
    }
    let Some(mut stored) = read_json_opt(&target.join("book.json"))? else {
        return Ok(None);
    };
    let file = stored
        .get("coverFile")
        .and_then(Value::as_str)
        .filter(|name| valid_cover_file_name(name))
        .or_else(|| {
            book.get("coverFile")
                .and_then(Value::as_str)
                .filter(|name| valid_cover_file_name(name))
        })
        .unwrap_or(COVER_FILE_NAME)
        .to_string();
    let Some(entry_cover) = cover else {
        return Ok(None);
    };
    let mime = entry_cover.get("mime").and_then(Value::as_str);
    let Some(bytes) = decode_cover(entry_cover.get("base64").and_then(Value::as_str), mime) else {
        return Ok(None);
    };
    write_bytes_atomic(&target.join(&file), &bytes)?;
    let mime = mime
        .filter(|value| value.starts_with("image/"))
        .unwrap_or(COVER_MIME)
        .to_string();
    if stored.get("coverFile").and_then(Value::as_str) != Some(file.as_str())
        || stored.get("coverMime").and_then(Value::as_str) != Some(mime.as_str())
    {
        if let Value::Object(object) = &mut stored {
            object.insert("coverFile".to_string(), json!(file));
            object.insert("coverMime".to_string(), json!(mime));
        }
        write_json(&target.join("book.json"), &stored)?;
    }
    Ok(Some((file, mime)))
}

fn remap_toc(value: &Value, mapping: &HashMap<String, String>) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| remap_toc(item, mapping)).collect())
        }
        Value::Object(object) => {
            let mut next = object.clone();
            if let Some(Value::String(chapter_id)) = object.get("chapterId") {
                if let Some(mapped) = mapping.get(chapter_id) {
                    next.insert("chapterId".to_string(), json!(mapped));
                    if object.contains_key("id") {
                        next.insert("id".to_string(), json!(mapped));
                    }
                }
            }
            if let Some(children) = object.get("children") {
                next.insert("children".to_string(), remap_toc(children, mapping));
            }
            Value::Object(next)
        }
        other => other.clone(),
    }
}

fn chapter_assets(chapter: &Value, digest: Option<&Value>) -> Value {
    let has_notes = chapter
        .get("blocks")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("kind").and_then(Value::as_str) == Some("note"))
        });
    let has_map = digest
        .and_then(|value| value.get("map"))
        .is_some_and(|map| {
            ["placeIds", "routeIds"].iter().any(|key| {
                map.get(*key)
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
            })
        });
    json!({
        "hasContent": true,
        "hasDigest": digest.is_some(),
        "hasDossier": false,
        "hasMap": has_map,
        "hasNotes": has_notes,
    })
}

fn read_book_source_hash(books_root: &Path, book_id: &str) -> Option<String> {
    let book = read_json_opt(&books_root.join(book_id).join("book.json")).ok()??;
    book.get("source")
        .and_then(|source| source.get("sha256"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn find_book_by_source_hash(books_root: &Path, sha256: &str) -> Option<Value> {
    let index = read_json_opt(&books_root.join("index.json")).ok()??;
    for entry in index.get("books").and_then(Value::as_array)?.iter() {
        let Some(book_id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if read_book_source_hash(books_root, book_id).as_deref() == Some(sha256) {
            let book = read_json_opt(&books_root.join(book_id).join("book.json")).ok()??;
            let mut merged = book;
            merged["deduped"] = json!(true);
            return Some(merged);
        }
    }
    None
}

fn append_library_index(books_root: &Path, meta: &Value) -> Result<(), ApiError> {
    let index_path = books_root.join("index.json");
    let mut books: Vec<Value> = read_json_opt(&index_path)?
        .and_then(|index| index.get("books").cloned())
        .and_then(|books| books.as_array().cloned())
        .unwrap_or_default();
    if let Some(id) = meta.get("id").and_then(Value::as_str) {
        books.retain(|book| book.get("id").and_then(Value::as_str) != Some(id));
    }
    books.push(meta.clone());
    write_json(
        &index_path,
        &json!({ "schemaVersion": SCHEMA_VERSION, "books": books }),
    )
}

/// 逐项把 `source` 目录树搬到 `target`（目录递归创建；文件优先 rename，失败再 copy+delete）。
///
/// 仅作为整目录 `rename` 失败时的回退：Windows 安全软件 / 文件系统过滤 / 沙箱环境可能
/// 拒绝「带子树目录」的 rename（os error 5 拒绝访问），但逐文件移动通常可用。
fn move_tree_into(source: &Path, target: &Path) -> Result<(), ApiError> {
    fs::create_dir_all(target).map_err(|error| {
        ApiError::io(format!("创建目标目录失败（{}）：{error}", target.display()))
    })?;
    let entries = fs::read_dir(source).map_err(|error| {
        ApiError::io(format!("读取临时目录失败（{}）：{error}", source.display()))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| ApiError::io(format!("读取目录项失败：{error}")))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            ApiError::io(format!("读取文件类型失败（{}）：{error}", from.display()))
        })?;
        if file_type.is_dir() {
            move_tree_into(&from, &to)?;
        } else {
            let moved = fs::rename(&from, &to).or_else(|_| {
                fs::copy(&from, &to)
                    .map(|_| ())
                    .and_then(|()| fs::remove_file(&from))
            });
            moved.map_err(|error| {
                ApiError::io(format!(
                    "移动文件失败（{} → {}）：{error}",
                    from.display(),
                    to.display()
                ))
            })?;
        }
    }
    Ok(())
}

/// 导入实现（不依赖 Tauri runtime，便于单元测试）。
///
/// `cover` 为前端缩放编码后的 base64 JPEG；有效时写 `cover.jpg` 并在 book.json
/// 记录 `coverFile`/`coverMime`，无效/超限时静默忽略（书籍无封面）。
#[allow(clippy::too_many_arguments)]
fn import_book_into(
    books_root: &Path,
    source_path: &Path,
    slug: &str,
    book: &Value,
    toc: &Value,
    chapters: &[Value],
    digests: &[Value],
    imported_at: &str,
    cover: Option<&str>,
    cover_mime: Option<&str>,
) -> Result<Value, ApiError> {
    let _guard = write_guard()?;
    let file_bytes = read_epub_file(source_path)?;
    fs::create_dir_all(books_root)
        .map_err(|error| ApiError::io(format!("创建书籍根目录失败：{error}")))?;
    let sha256 = sha256_hex(&file_bytes);
    let size = file_bytes.len() as u64;
    let cover_bytes = decode_cover(cover, cover_mime);
    let file_name = source_path
        .file_name()
        .and_then(OsStr::to_str)
        .map(sanitize_file_name)
        .unwrap_or_else(|| "source.epub".to_string());
    if chapters.is_empty() {
        return Err(ApiError::invalid("EPUB 没有解析出任何章节"));
    }
    if let Some(existing) = find_book_by_source_hash(books_root, &sha256) {
        return Ok(existing);
    }

    let slug = sanitize_slug(slug);
    let hash8 = &sha256[..8.min(sha256.len())];
    let mut book_id = format!("{slug}-{hash8}");
    if !valid_book_id(&book_id) {
        book_id = format!("book-{hash8}");
    }
    for suffix in 2..50 {
        if !books_root.join(&book_id).exists() {
            break;
        }
        book_id = format!("{slug}-{hash8}-{suffix}");
    }
    if books_root.join(&book_id).exists() {
        return Err(ApiError::new("EXISTS", "同名书籍已存在，无法导入"));
    }

    let mut mapping: HashMap<String, String> = HashMap::new();
    let mut chapter_ids: Vec<String> = Vec::new();
    for (index, chapter) in chapters.iter().enumerate() {
        let original = chapter
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("ch-{index}"));
        let mut mapped = format!("{book_id}-{original}");
        if !valid_chapter_id(&mapped) {
            mapped = format!("{book_id}-ch-{index}");
        }
        mapping.insert(original, mapped.clone());
        chapter_ids.push(mapped);
    }

    let temporary = books_root.join(format!(".import-{book_id}-{}", now_millis()));
    let result = (|| -> Result<Value, ApiError> {
        fs::create_dir_all(temporary.join("source"))
            .map_err(|error| ApiError::io(format!("创建导入临时目录失败：{error}")))?;

        for (index, chapter) in chapters.iter().enumerate() {
            let original = chapter
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("ch-{index}"));
            let mapped = mapping
                .get(&original)
                .cloned()
                .unwrap_or_else(|| chapter_ids[index].clone());
            let mut chapter_value = chapter.clone();
            if let Value::Object(object) = &mut chapter_value {
                object.insert("id".to_string(), json!(mapped));
                object.insert("bookId".to_string(), json!(book_id));
            }
            let directory = temporary.join("chapters").join(&mapped);
            fs::create_dir_all(&directory)
                .map_err(|error| ApiError::io(format!("创建章节目录失败：{error}")))?;
            write_json(&directory.join("chapter.json"), &chapter_value)?;
            if let Some(digest) = digests.get(index) {
                let mut digest_value = digest.clone();
                if let Value::Object(object) = &mut digest_value {
                    object.insert("bookId".to_string(), json!(book_id));
                    object.insert("chapterId".to_string(), json!(mapped));
                }
                write_json(&directory.join("digest.json"), &digest_value)?;
            }
        }

        let remapped_toc = remap_toc(toc, &mapping);
        write_json(&temporary.join("toc.json"), &remapped_toc)?;

        let mut assets = serde_json::Map::new();
        for (index, chapter_id) in chapter_ids.iter().enumerate() {
            assets.insert(
                chapter_id.clone(),
                chapter_assets(&chapters[index], digests.get(index)),
            );
        }
        let mut book_meta = book.clone();
        if let Value::Object(object) = &mut book_meta {
            object.insert("id".to_string(), json!(book_id));
            object.insert("format".to_string(), json!("epub"));
            object.insert("sourceName".to_string(), json!(file_name));
            object.insert("importedAt".to_string(), json!(imported_at));
            object.insert(
                "volumeCount".to_string(),
                json!(toc.as_array().map_or(0, Vec::len)),
            );
            object.insert("chapterCount".to_string(), json!(chapter_ids.len()));
            object.insert("schemaVersion".to_string(), json!(SCHEMA_VERSION));
            object.insert("chapterIds".to_string(), json!(chapter_ids));
            object.insert("chapterAssets".to_string(), Value::Object(assets));
            object.insert(
                "source".to_string(),
                json!({ "fileName": file_name, "sha256": sha256, "size": size }),
            );
            if cover_bytes.is_some() {
                object.insert("coverFile".to_string(), json!(COVER_FILE_NAME));
                object.insert("coverMime".to_string(), json!(COVER_MIME));
            }
        }
        write_json(&temporary.join("book.json"), &book_meta)?;
        fs::write(temporary.join("source").join(&file_name), &file_bytes)
            .map_err(|error| ApiError::io(format!("保存原文件失败：{error}")))?;
        if let Some(cover_bytes) = cover_bytes.as_deref() {
            fs::write(temporary.join(COVER_FILE_NAME), cover_bytes)
                .map_err(|error| ApiError::io(format!("保存封面失败：{error}")))?;
        }

        let final_dir = books_root.join(&book_id);
        if let Err(rename_error) = fs::rename(&temporary, &final_dir) {
            // 回退：逐项移动。目标目录可能建到一半，失败时整体清理，避免留下孤儿目录。
            let fallback = move_tree_into(&temporary, &final_dir).and_then(|()| {
                fs::remove_dir_all(&temporary)
                    .map_err(|error| ApiError::io(format!("清理导入临时目录失败：{error}")))
            });
            if let Err(fallback_error) = fallback {
                let _ = fs::remove_dir_all(&final_dir);
                return Err(ApiError::io(format!(
                    "提交导入失败（{}）：{rename_error}；逐项移动回退也失败：{}",
                    final_dir.display(),
                    fallback_error.message
                )));
            }
            debug_log("import rename fallback used");
        }
        append_library_index(books_root, &book_meta)?;
        Ok(book_meta)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn library_import_epub(
    app: AppHandle,
    path: String,
    slug: String,
    book: Value,
    toc: Value,
    chapters: Vec<Value>,
    digests: Vec<Value>,
    imported_at: String,
    cover: Option<String>,
    cover_mime: Option<String>,
) -> Result<Value, ApiError> {
    debug_log("import_epub");
    let root = books_dir(&app)?;
    run(move || {
        let (source, temporary) = materialize_picked_source(&app, &path)?;
        let result = import_book_into(
            &root,
            &source,
            &slug,
            &book,
            &toc,
            &chapters,
            &digests,
            &imported_at,
            cover.as_deref(),
            cover_mime.as_deref(),
        );
        if let Some(directory) = temporary {
            let _ = fs::remove_dir_all(directory);
        }
        result
    })
    .await
}

/// 摘要回写：原子写 digest.json，并更新 book.json.chapterAssets.hasDigest。
#[tauri::command]
pub async fn library_save_chapter_digest(app: AppHandle, digest: Value) -> Result<Value, ApiError> {
    debug_log("save_chapter_digest");
    run(move || {
        let _guard = write_guard()?;
        let book_id = digest
            .get("bookId")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::invalid("摘要缺少 bookId"))?
            .to_string();
        let chapter_id = digest
            .get("chapterId")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::invalid("摘要缺少 chapterId"))?
            .to_string();
        let directory = chapter_dir(&app, &book_id, &chapter_id)?;
        write_json(&directory.join("digest.json"), &digest)?;

        let book_path = book_dir(&app, &book_id)?.join("book.json");
        if let Some(mut book) = read_json_opt(&book_path)? {
            let Some(assets) = book.get_mut("chapterAssets").and_then(Value::as_object_mut) else {
                return Ok(json!({ "hasDigest": true, "chapterAssetsUpdated": false }));
            };
            let updated = assets
                .get_mut(&chapter_id)
                .and_then(Value::as_object_mut)
                .map(|entry| {
                    entry.insert("hasDigest".to_string(), json!(true));
                })
                .is_some();
            if updated {
                write_json(&book_path, &book)?;
            }
            return Ok(json!({ "hasDigest": true, "chapterAssetsUpdated": updated }));
        }
        Ok(json!({ "hasDigest": true, "chapterAssetsUpdated": false }))
    })
    .await
}

const MAX_SETTINGS_BYTES: usize = 64 * 1024;

fn read_settings_from(data: &Path) -> Result<Option<Value>, ApiError> {
    read_json_opt(&data.join("settings.json"))
}

fn write_settings_to(data: &Path, settings: &Value) -> Result<(), ApiError> {
    if !settings.is_object() {
        return Err(ApiError::invalid("设置内容必须是 JSON 对象"));
    }
    let encoded = serde_json::to_string(settings)
        .map_err(|error| ApiError::io(format!("序列化设置失败：{error}")))?;
    if encoded.len() > MAX_SETTINGS_BYTES {
        return Err(ApiError::invalid("设置内容过大（上限 64 KB）"));
    }
    let _guard = write_guard()?;
    write_json(&data.join("settings.json"), settings)
}

/// 用户设置（放用户库 settings.json；M1 起替代 localStorage）。
#[tauri::command]
pub async fn library_get_settings(app: AppHandle) -> Result<Value, ApiError> {
    debug_log("get_settings");
    run(move || {
        let data = data_dir(&app)?;
        Ok(read_settings_from(&data)?.unwrap_or(Value::Null))
    })
    .await
}

#[tauri::command]
pub async fn library_save_settings(app: AppHandle, settings: Value) -> Result<Value, ApiError> {
    debug_log("save_settings");
    run(move || {
        let data = data_dir(&app)?;
        write_settings_to(&data, &settings)?;
        Ok(json!({ "ok": true }))
    })
    .await
}

// ---------------------------------------------------------------------------
// 全局检索（按需扫描）：不建索引、不缓存检索数据，每次请求现扫用户库磁盘。
// ---------------------------------------------------------------------------

const SEARCH_DEFAULT_LIMIT: u32 = 100;
const SEARCH_MAX_LIMIT: u32 = 200;
/// snippet：命中位置前后各取的字符数。
const SEARCH_SNIPPET_PAD: usize = 48;
/// 进度事件最小间隔：约每 8 个章节或每 300ms 至少发一次。
const SEARCH_PROGRESS_CHAPTERS: usize = 8;
const SEARCH_PROGRESS_INTERVAL_MS: u64 = 300;

/// 取消注册表：requestId → 已请求取消。搜索结束（成功/取消/错误）时移除标记。
static SEARCH_CANCELS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn search_cancels() -> &'static Mutex<HashSet<String>> {
    SEARCH_CANCELS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 标记某次检索需要取消（前端 `library_cancel_search`）。
fn register_search_cancel(request_id: &str) {
    if let Ok(mut set) = search_cancels().lock() {
        set.insert(request_id.to_string());
    }
}

/// 移除取消标记；开始与结束都调用，避免上一次同名 requestId 的残留标记。
fn clear_search_cancel(request_id: &str) {
    if let Ok(mut set) = search_cancels().lock() {
        set.remove(request_id);
    }
}

fn is_search_cancelled(request_id: &str) -> bool {
    search_cancels()
        .lock()
        .map(|set| set.contains(request_id))
        .unwrap_or(false)
}

fn emit_search_progress(
    app: &AppHandle,
    request_id: &str,
    scanned: usize,
    total: usize,
    done: bool,
    phase: &str,
) {
    let payload = json!({
        "requestId": request_id,
        "scanned": scanned,
        "total": total,
        "done": done,
        "phase": phase,
    });
    // 事件只是进度提示，发送失败不影响检索结果。
    let _ = app.emit("library-search-progress", payload);
}

/// ASCII 大小写不敏感的子串查找；返回原字符串的字节偏移（保证落在 char 边界上）。
/// 中文按原样逐字节比较；`to_ascii_lowercase` 只改 ASCII 字节，长度与边界不变。
fn find_match(text: &str, query_lower: &str) -> Option<usize> {
    if query_lower.is_empty() || text.is_empty() {
        return None;
    }
    let lowered = text.to_ascii_lowercase();
    if lowered.len() != text.len() {
        return None;
    }
    lowered
        .find(query_lower)
        .filter(|offset| text.is_char_boundary(*offset))
}

/// 取命中位置前后各 pad 个字符并归一空白；含省略号时说明被截断。
fn snippet_around(text: &str, match_start: usize, match_len: usize, pad: usize) -> String {
    let match_start = match_start.min(text.len());
    let start = text[..match_start]
        .char_indices()
        .rev()
        .nth(pad.saturating_sub(1))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let match_end = (match_start + match_len).min(text.len());
    let end = text[match_end..]
        .char_indices()
        .nth(pad)
        .map(|(index, _)| match_end + index)
        .unwrap_or(text.len());
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    let body = text[start..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    snippet.push_str(body.trim());
    if end < text.len() {
        snippet.push('…');
    }
    snippet
}

/// 检索命中的一本书：title / author / description 用于书名命中与 snippet。
struct SearchBook {
    id: String,
    title: String,
    author: String,
    description: String,
    chapter_ids: Vec<String>,
}

impl SearchBook {
    fn context(&self) -> String {
        let mut text = self.title.clone();
        for part in [&self.author, &self.description] {
            if !part.is_empty() {
                text.push_str(" · ");
                text.push_str(part);
            }
        }
        text
    }
}

/// 宽松读取：单本书/章数据损坏时跳过该文件，而不是让整次检索失败。
fn read_json_lenient(path: &Path) -> Option<Value> {
    read_json_opt(path).ok().flatten()
}

/// 从 index.json 收集可检索的书（与 `library_get_book` 同口径：只认 schemaVersion 2）。
fn collect_search_books(books_root: &Path) -> Result<Vec<SearchBook>, ApiError> {
    let Some(index) = read_json_opt(&books_root.join("index.json"))? else {
        return Ok(Vec::new());
    };
    let entries = index
        .get("books")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut books = Vec::new();
    for entry in entries {
        let Some(book_id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !valid_book_id(book_id) {
            continue;
        }
        let Some(book) = read_json_lenient(&books_root.join(book_id).join("book.json")) else {
            continue;
        };
        if book.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            continue;
        }
        let chapter_ids: Vec<String> = book
            .get("chapterIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .filter(|id| valid_chapter_id(id))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if chapter_ids.is_empty() {
            continue;
        }
        books.push(SearchBook {
            id: book_id.to_string(),
            title: book
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(book_id)
                .to_string(),
            author: book
                .get("author")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            description: book
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            chapter_ids,
        });
    }
    Ok(books)
}

fn digest_snippet(digest: &Value, query_lower: &str, query_len: usize) -> Option<String> {
    let match_text = |text: &str| {
        find_match(text, query_lower)
            .map(|position| snippet_around(text, position, query_len, SEARCH_SNIPPET_PAD))
    };
    if let Some(snippet) = digest
        .get("title")
        .and_then(Value::as_str)
        .and_then(match_text)
    {
        return Some(snippet);
    }
    if let Some(snippet) = digest
        .get("opening")
        .and_then(Value::as_str)
        .and_then(match_text)
    {
        return Some(snippet);
    }
    let points = digest.get("keyPoints").and_then(Value::as_array)?;
    for point in points {
        for field in ["title", "text"] {
            if let Some(snippet) = point
                .get(field)
                .and_then(Value::as_str)
                .and_then(match_text)
            {
                return Some(snippet);
            }
        }
    }
    None
}

/// 检索结果：kind=book/chapter/knowledge；同 kind+bookId+chapterId+entryId+title 只留一条。
struct SearchOutcome {
    hits: Vec<Value>,
    scanned: usize,
    total: usize,
    cancelled: bool,
}

#[allow(clippy::too_many_arguments)]
fn push_search_hit(
    hits: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    kind: &str,
    book_id: &str,
    book_title: &str,
    author: Option<&str>,
    chapter_id: Option<&str>,
    chapter_title: Option<&str>,
    entry_id: Option<&str>,
    title: &str,
    snippet: String,
) {
    let key = format!(
        "{kind}\u{1}{book_id}\u{1}{}\u{1}{}\u{1}{title}",
        chapter_id.unwrap_or(""),
        entry_id.unwrap_or(""),
    );
    if !seen.insert(key) {
        return;
    }
    let mut hit = serde_json::Map::new();
    hit.insert("kind".to_string(), json!(kind));
    hit.insert("bookId".to_string(), json!(book_id));
    hit.insert("bookTitle".to_string(), json!(book_title));
    if let Some(author) = author {
        hit.insert("author".to_string(), json!(author));
    }
    if let Some(chapter_id) = chapter_id {
        hit.insert("chapterId".to_string(), json!(chapter_id));
    }
    if let Some(chapter_title) = chapter_title.filter(|value| !value.is_empty()) {
        hit.insert("chapterTitle".to_string(), json!(chapter_title));
    }
    if let Some(entry_id) = entry_id {
        hit.insert("entryId".to_string(), json!(entry_id));
    }
    hit.insert("title".to_string(), json!(title));
    hit.insert("snippet".to_string(), json!(snippet));
    hits.push(Value::Object(hit));
}

/// 扫描实现（不依赖 Tauri runtime，便于单元测试）。
///
/// 扫描顺序：每本书（书名/作者 → 各章：标题/正文 → 摘要 → 档案），因此结果稳定、
/// 去重时保留先出现的条目。`book_ids` 限定章节/知识库扫描范围；书名/作者命中
/// （`include_book_level`）始终在全库范围。`knowledge_only` 只扫摘要与档案。
/// `on_progress` 只在扫描中回调，`is_cancelled` 在每个章节/档案条目前后检查。
#[allow(clippy::too_many_arguments)]
fn search_into<F, C>(
    books_root: &Path,
    query: &str,
    limit: usize,
    book_ids: Option<&[String]>,
    include_book_level: bool,
    knowledge_only: bool,
    mut on_progress: F,
    is_cancelled: C,
) -> Result<SearchOutcome, ApiError>
where
    F: FnMut(usize, usize),
    C: Fn() -> bool,
{
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchOutcome {
            hits: Vec::new(),
            scanned: 0,
            total: 0,
            cancelled: false,
        });
    }
    let query_lower = query.to_ascii_lowercase();
    let query_len = query.len();
    let books = collect_search_books(books_root)?;
    // bookIds 范围：只保留合法 id；扫描顺序仍按库内顺序。
    let scope: Option<HashSet<String>> =
        book_ids.map(|ids| ids.iter().filter(|id| valid_book_id(id)).cloned().collect());
    let in_scope = |book: &SearchBook| {
        scope
            .as_ref()
            .is_none_or(|scope| scope.contains(book.id.as_str()))
    };
    let total: usize = books
        .iter()
        .filter(|book| in_scope(book))
        .map(|book| book.chapter_ids.len())
        .sum();
    let find_book_level = include_book_level && !knowledge_only;
    let mut hits: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut scanned = 0usize;
    let mut cancelled = false;
    let mut since_emit = 0usize;
    let mut last_emit = Instant::now();
    on_progress(0, total);

    'books: for book in &books {
        // 1) 书名命中：snippet 取书名/作者/简介附近文本。
        if find_book_level {
            if let Some(position) = find_match(&book.title, &query_lower) {
                let context = book.context();
                let snippet = snippet_around(&context, position, query_len, SEARCH_SNIPPET_PAD);
                push_search_hit(
                    &mut hits,
                    &mut seen,
                    "book",
                    &book.id,
                    &book.title,
                    None,
                    None,
                    None,
                    None,
                    &book.title,
                    snippet,
                );
            }
            // 2) 作者命中：title 为书名，snippet 取作者附近，并带 author 字段。
            if !book.author.is_empty() {
                if let Some(position) = find_match(&book.author, &query_lower) {
                    let snippet =
                        snippet_around(&book.author, position, query_len, SEARCH_SNIPPET_PAD);
                    push_search_hit(
                        &mut hits,
                        &mut seen,
                        "author",
                        &book.id,
                        &book.title,
                        Some(&book.author),
                        None,
                        None,
                        None,
                        &book.title,
                        snippet,
                    );
                }
            }
        }

        // bookIds 范围外的书只参与书名/作者匹配，不扫章节与知识库。
        if !in_scope(book) {
            continue;
        }

        let mut chapter_titles: HashMap<String, String> = HashMap::new();

        // 2) 章节标题 / blocks 正文（knowledgeOnly 时跳过），以及 3) 章节摘要 digest。
        for chapter_id in &book.chapter_ids {
            if is_cancelled() {
                cancelled = true;
                break 'books;
            }
            let directory = books_root.join(&book.id).join("chapters").join(chapter_id);
            let mut chapter_title = String::new();
            if !knowledge_only {
                let chapter = read_json_lenient(&directory.join("chapter.json"));
                chapter_title = chapter
                    .as_ref()
                    .and_then(|value| value.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !chapter_title.is_empty() {
                    chapter_titles.insert(chapter_id.clone(), chapter_title.clone());
                }
                if let Some(chapter) = chapter.as_ref() {
                    let snippet = find_match(&chapter_title, &query_lower)
                        .map(|position| {
                            snippet_around(&chapter_title, position, query_len, SEARCH_SNIPPET_PAD)
                        })
                        .or_else(|| {
                            chapter
                                .get("blocks")
                                .and_then(Value::as_array)
                                .and_then(|blocks| {
                                    blocks.iter().find_map(|block| {
                                        let text = block.get("text").and_then(Value::as_str)?;
                                        let position = find_match(text, &query_lower)?;
                                        Some(snippet_around(
                                            text,
                                            position,
                                            query_len,
                                            SEARCH_SNIPPET_PAD,
                                        ))
                                    })
                                })
                        });
                    if let Some(snippet) = snippet {
                        push_search_hit(
                            &mut hits,
                            &mut seen,
                            "chapter",
                            &book.id,
                            &book.title,
                            None,
                            Some(chapter_id),
                            Some(&chapter_title),
                            None,
                            &chapter_title,
                            snippet,
                        );
                    }
                }
            }

            if let Some(digest) = read_json_lenient(&directory.join("digest.json")) {
                let digest_title = digest
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&chapter_title);
                let display_chapter_title = if chapter_title.is_empty() {
                    digest_title
                } else {
                    &chapter_title
                };
                if let Some(snippet) = digest_snippet(&digest, &query_lower, query_len) {
                    let entry_id = format!("digest:{chapter_id}");
                    push_search_hit(
                        &mut hits,
                        &mut seen,
                        "knowledge",
                        &book.id,
                        &book.title,
                        None,
                        Some(chapter_id),
                        Some(display_chapter_title),
                        Some(&entry_id),
                        digest_title,
                        snippet,
                    );
                }
            }

            scanned += 1;
            since_emit += 1;
            let time_due =
                last_emit.elapsed() >= Duration::from_millis(SEARCH_PROGRESS_INTERVAL_MS);
            if since_emit >= SEARCH_PROGRESS_CHAPTERS || time_due {
                on_progress(scanned, total);
                since_emit = 0;
                last_emit = Instant::now();
            }
        }

        // 4) 整本档案 shared/archives.json。
        if last_emit.elapsed() >= Duration::from_millis(SEARCH_PROGRESS_INTERVAL_MS) {
            on_progress(scanned, total);
            last_emit = Instant::now();
        }
        if let Some(archives) =
            read_json_lenient(&books_root.join(&book.id).join("shared/archives.json"))
        {
            if let Some(entries) = archives.get("entries").and_then(Value::as_array) {
                for entry in entries {
                    if is_cancelled() {
                        cancelled = true;
                        break 'books;
                    }
                    let title = entry.get("title").and_then(Value::as_str).unwrap_or("");
                    let body = entry.get("body").and_then(Value::as_str).unwrap_or("");
                    let snippet = find_match(title, &query_lower)
                        .map(|position| {
                            snippet_around(title, position, query_len, SEARCH_SNIPPET_PAD)
                        })
                        .or_else(|| {
                            find_match(body, &query_lower).map(|position| {
                                snippet_around(body, position, query_len, SEARCH_SNIPPET_PAD)
                            })
                        });
                    let Some(snippet) = snippet else {
                        continue;
                    };
                    let Some(entry_id) = entry.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    if entry_id.is_empty() {
                        continue;
                    }
                    let chapter_id = entry
                        .get("chapterId")
                        .and_then(Value::as_str)
                        .filter(|id| valid_chapter_id(id));
                    let chapter_title = chapter_id
                        .and_then(|id| chapter_titles.get(id))
                        .map(String::as_str);
                    push_search_hit(
                        &mut hits,
                        &mut seen,
                        "knowledge",
                        &book.id,
                        &book.title,
                        None,
                        chapter_id,
                        chapter_title,
                        Some(entry_id),
                        title,
                        snippet,
                    );
                }
            }
        }
    }

    hits.truncate(limit);
    Ok(SearchOutcome {
        hits,
        scanned,
        total,
        cancelled,
    })
}

/// 全局检索：每次请求现扫用户库磁盘（不建索引、不缓存），结果按扫描顺序返回。
#[tauri::command]
pub async fn library_search(
    app: AppHandle,
    query: String,
    request_id: String,
    limit: Option<u32>,
    book_ids: Option<Vec<String>>,
    include_book_level: Option<bool>,
    knowledge_only: Option<bool>,
) -> Result<Value, ApiError> {
    debug_log("search");
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() || request_id.chars().count() > 128 {
        return Err(ApiError::invalid("requestId 无效（1–128 字符）"));
    }
    let limit = limit
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT) as usize;
    // bookIds：丢弃非法 id；空数组表示「无范围的章节检索」，仍可返回书名/作者命中。
    let book_ids: Option<Vec<String>> = book_ids.map(|ids| {
        ids.into_iter()
            .filter(|id| valid_book_id(id))
            .collect::<Vec<String>>()
    });
    let include_book_level = include_book_level.unwrap_or(true);
    let knowledge_only = knowledge_only.unwrap_or(false);
    // 清理同 requestId 的残留标记，避免上一轮取消影响本次检索。
    clear_search_cancel(&request_id);
    let task_app = app.clone();
    let task_request_id = request_id.clone();
    let outcome = run(move || {
        let result = books_dir(&task_app).and_then(|books_root| {
            let progress_app = task_app.clone();
            let progress_request_id = task_request_id.clone();
            search_into(
                &books_root,
                &query,
                limit,
                book_ids.as_deref(),
                include_book_level,
                knowledge_only,
                |scanned, total| {
                    emit_search_progress(
                        &progress_app,
                        &progress_request_id,
                        scanned,
                        total,
                        false,
                        "scanning",
                    );
                },
                || is_search_cancelled(&task_request_id),
            )
        });
        // 无论成功/取消/出错都移除取消标记并补发 done 事件。
        clear_search_cancel(&task_request_id);
        let (scanned, total, cancelled) = result
            .as_ref()
            .map(|outcome| (outcome.scanned, outcome.total, outcome.cancelled))
            .unwrap_or((0, 0, false));
        if cancelled {
            debug_log("search cancelled");
        }
        emit_search_progress(&task_app, &task_request_id, scanned, total, true, "done");
        result.map(|outcome| Value::Array(outcome.hits))
    })
    .await;
    // spawn_blocking 任务 panic 时兜底清理（正常路径已在任务内清理）。
    clear_search_cancel(&request_id);
    outcome
}

/// 取消进行中的检索：登记 requestId，搜索循环在下个章节/档案条目后尽快停止。
#[tauri::command]
pub async fn library_cancel_search(_app: AppHandle, request_id: String) -> Result<Value, ApiError> {
    debug_log("cancel_search");
    let request_id = request_id.trim();
    if request_id.is_empty() || request_id.chars().count() > 128 {
        return Err(ApiError::invalid("requestId 无效（1–128 字符）"));
    }
    register_search_cancel(request_id);
    Ok(json!({ "ok": true, "requestId": request_id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::rfc3339_from_millis;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jusong-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(root.join("books")).unwrap();
        root
    }

    fn sample_chapters() -> Vec<Value> {
        vec![json!({
            "id": "ch_0001",
            "bookId": "",
            "title": "第一章",
            "blocks": [{ "id": "p1", "kind": "paragraph", "text": "正文" }],
        })]
    }

    fn sample_toc() -> Value {
        json!([{ "id": "ch_0001", "type": "chapter", "title": "第一章", "order": 1, "chapterId": "ch_0001" }])
    }

    fn sample_digests() -> Vec<Value> {
        vec![json!({
            "schemaVersion": 1,
            "bookId": "",
            "chapterId": "ch_0001",
            "title": "第一章",
            "generatedAt": "2026-11-15T00:00:00.000Z",
            "source": "import-structure",
            "stats": { "charCount": 2, "paragraphCount": 1, "headingCount": 0, "noteCount": 0 },
            "headings": [],
            "opening": "正文",
            "closing": "正文",
            "keyPoints": []
        })]
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sanitize_slug_handles_ascii_and_spaces() {
        assert_eq!(sanitize_slug("My  Book!"), "my-book");
        assert_eq!(sanitize_slug("   "), "book");
        assert_eq!(sanitize_slug(&"a".repeat(40)), "a".repeat(32));
    }

    #[test]
    fn read_epub_accepts_zip_magic_without_extension() {
        let root = temp_root("read-extensionless");
        let source = root.join("content-cache-file.bin");
        fs::write(&source, b"PK\x03\x04rest").unwrap();
        assert_eq!(read_epub_file(&source).unwrap(), b"PK\x03\x04rest");
        let invalid = root.join("content-cache-invalid.bin");
        fs::write(&invalid, b"not-a-zip").unwrap();
        assert_eq!(read_epub_file(&invalid).unwrap_err().code, "INVALID_INPUT");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_is_atomic_and_deduplicates() {
        let root = temp_root("import");
        let books = root.join("books");
        let source = root.join("测试导入.epub");
        fs::write(&source, b"fake-epub-bytes").unwrap();
        let book = json!({ "title": "测试导入书", "author": "作者" });

        let first = import_book_into(
            &books,
            &source,
            "ceshidaorushu",
            &book,
            &sample_toc(),
            &sample_chapters(),
            &sample_digests(),
            "2026-11-15T00:00:00.000Z",
            None,
            None,
        )
        .expect("first import");
        let book_id = first["id"].as_str().unwrap().to_string();
        assert!(book_id.starts_with("ceshidaorushu-"));
        assert!(books.join(&book_id).join("book.json").exists());
        assert!(books
            .join(&book_id)
            .join("source")
            .join("测试导入.epub")
            .exists());
        assert!(books
            .join(&book_id)
            .join("chapters")
            .join(format!("{book_id}-ch_0001"))
            .join("digest.json")
            .exists());
        assert!(first.get("coverFile").is_none());
        let index = read_json_opt(&books.join("index.json")).unwrap().unwrap();
        assert_eq!(index["books"].as_array().unwrap().len(), 1);

        // 同文件重复导入返回已有书，不产生第二本。
        let second = import_book_into(
            &books,
            &source,
            "ceshidaorushu",
            &book,
            &sample_toc(),
            &sample_chapters(),
            &sample_digests(),
            "2026-11-15T00:00:00.000Z",
            None,
            None,
        )
        .expect("dedupe import");
        assert_eq!(second["id"].as_str().unwrap(), book_id);
        assert_eq!(second["deduped"], json!(true));
        assert_eq!(
            read_json_opt(&books.join("index.json")).unwrap().unwrap()["books"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let leftovers: Vec<PathBuf> = fs::read_dir(&books)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.starts_with(".import-"))
            })
            .collect();
        assert!(leftovers.is_empty(), "临时目录未清理：{leftovers:?}");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn settings_roundtrip_and_validation() {
        let root = temp_root("settings");
        let data = root.join("library");
        fs::create_dir_all(&data).unwrap();

        assert!(read_settings_from(&data).unwrap().is_none());
        let settings = json!({ "notesPanelEnabled": true, "noteDisplayMode": "panel" });
        write_settings_to(&data, &settings).unwrap();
        let loaded = read_settings_from(&data).unwrap().unwrap();
        assert_eq!(loaded, settings);
        assert!(data.join("settings.json").exists());

        let invalid = write_settings_to(&data, &json!([1, 2, 3]));
        assert!(invalid.is_err(), "非对象设置应被拒绝");

        let _ = fs::remove_dir_all(root);
    }

    fn write_seed(content: &Path, id: &str) {
        let directory = content.join(id);
        fs::create_dir_all(&directory).unwrap();
        let book = json!({
            "id": id,
            "title": id,
            "format": "seed",
            "volumeCount": 1,
            "chapterCount": 1
        });
        fs::write(
            directory.join("book.json"),
            serde_json::to_string(&book).unwrap(),
        )
        .unwrap();
        let index = json!({ "schemaVersion": 2, "books": [book] });
        fs::write(
            content.join("index.json"),
            serde_json::to_string(&index).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn ensure_seed_replaces_and_removes_stale_seed_books() {
        let root = temp_root("seed-update");
        let data = root.join("library");
        let content = root.join("content");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&content).unwrap();
        write_seed(&content, "seedone-11111111");

        let first = ensure_seed_into(&data, &content).expect("first seed");
        assert_eq!(first["installed"].as_array().unwrap().len(), 1);
        assert!(data.join("books/seedone-11111111/book.json").exists());

        // 内容修订：bookId（内容哈希）变化，旧种子副本应被清理。
        fs::remove_dir_all(content.join("seedone-11111111")).unwrap();
        write_seed(&content, "seedtwo-22222222");
        let second = ensure_seed_into(&data, &content).expect("second seed");
        assert_eq!(second["installed"].as_array().unwrap().len(), 1);
        assert_eq!(second["removed"].as_array().unwrap().len(), 1);
        assert!(!data.join("books/seedone-11111111").exists());
        assert!(data.join("books/seedtwo-22222222/book.json").exists());

        let index = read_json_opt(&data.join("books/index.json"))
            .unwrap()
            .unwrap();
        let books = index["books"].as_array().unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0]["id"], "seedtwo-22222222");
        let manifest = read_json_opt(&data.join("manifest.json")).unwrap().unwrap();
        assert_eq!(manifest["seeds"].as_array().unwrap().len(), 1);
        assert_eq!(manifest["seeds"][0]["bookId"], "seedtwo-22222222");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ensure_seed_refreshes_cover_for_existing_and_new_books() {
        let root = temp_root("seed-cover");
        let data = root.join("library");
        let content = root.join("content");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&content).unwrap();
        let existing_id = "seedcover-33333333";
        let new_id = "seedcover-44444444";
        let cover = b"\xff\xd8seed-cover-bytes".to_vec();

        let existing_source = content.join(existing_id);
        let new_source = content.join(new_id);
        fs::create_dir_all(&existing_source).unwrap();
        fs::create_dir_all(&new_source).unwrap();
        let existing_book = json!({
            "id": existing_id, "title": "旧种子", "format": "seed",
            "volumeCount": 1, "chapterCount": 1,
            "coverFile": "cover.jpg", "coverMime": "image/jpeg",
        });
        let new_book = json!({
            "id": new_id, "title": "新种子", "format": "seed",
            "volumeCount": 1, "chapterCount": 1,
            "coverFile": "cover.jpg", "coverMime": "image/jpeg",
        });
        fs::write(
            existing_source.join("book.json"),
            serde_json::to_string(&existing_book).unwrap(),
        )
        .unwrap();
        fs::write(existing_source.join("cover.jpg"), &cover).unwrap();
        fs::write(
            new_source.join("book.json"),
            serde_json::to_string(&new_book).unwrap(),
        )
        .unwrap();
        fs::write(new_source.join("cover.jpg"), &cover).unwrap();
        fs::write(
            content.join("index.json"),
            serde_json::to_string(&json!({
                "schemaVersion": 2,
                "books": [existing_book, new_book],
            }))
            .unwrap(),
        )
        .unwrap();

        // 用户库里 existing_id 是旧版种子副本：book.json 存在但没有封面。
        let old_target = data.join("books").join(existing_id);
        fs::create_dir_all(&old_target).unwrap();
        let old_book = json!({
            "id": existing_id, "title": "旧种子", "schemaVersion": 2,
            "chapterIds": ["ch_a"], "volumeCount": 1, "chapterCount": 1,
        });
        fs::write(
            old_target.join("book.json"),
            serde_json::to_string(&old_book).unwrap(),
        )
        .unwrap();
        assert!(!old_target.join("cover.jpg").exists());

        let outcome = ensure_seed_into(&data, &content).expect("seed with cover");
        let installed: Vec<&str> = outcome["installed"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(installed, vec![new_id], "已存在的旧书不重装，只补封面");

        // 旧书：封面补齐 + book.json 更新。
        assert_eq!(fs::read(old_target.join("cover.jpg")).unwrap(), cover);
        let refreshed = read_json_opt(&old_target.join("book.json"))
            .unwrap()
            .unwrap();
        assert_eq!(refreshed["coverFile"], "cover.jpg");
        assert_eq!(refreshed["coverMime"], "image/jpeg");

        // 新书：安装即带封面。
        let new_target = data.join("books").join(new_id);
        assert_eq!(fs::read(new_target.join("cover.jpg")).unwrap(), cover);
        let installed_book = read_json_opt(&new_target.join("book.json"))
            .unwrap()
            .unwrap();
        assert_eq!(installed_book["coverFile"], "cover.jpg");

        // 用户库 index.json 两边条目都带封面字段。
        let index = read_json_opt(&data.join("books/index.json"))
            .unwrap()
            .unwrap();
        for entry in index["books"].as_array().unwrap() {
            assert_eq!(entry["coverFile"], "cover.jpg");
            assert_eq!(entry["coverMime"], "image/jpeg");
        }

        // 幂等：再次 ensure 不重复安装、不报错、封面仍在。
        let second = ensure_seed_into(&data, &content).expect("idempotent seed");
        assert!(second["installed"].as_array().unwrap().is_empty());
        assert_eq!(fs::read(old_target.join("cover.jpg")).unwrap(), cover);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn seed_pack_installs_and_refreshes_cover() {
        let root = temp_root("seed-pack-cover");
        let data = root.join("library");
        fs::create_dir_all(&data).unwrap();
        let cover = b"\xff\xd8pack-cover-bytes".to_vec();
        let cover_base64 = BASE64_STANDARD.encode(&cover);
        let book_id = "packcover-55555555";
        let book = json!({
            "id": book_id, "title": "包内种子", "format": "seed",
            "schemaVersion": 2, "chapterIds": ["ch_a"],
            "volumeCount": 1, "chapterCount": 1,
            "coverFile": "cover.jpg", "coverMime": "image/jpeg",
        });
        let pack = json!({
            "schemaVersion": 2,
            "books": [{
                "book": book,
                "cover": { "mime": "image/jpeg", "base64": cover_base64 },
                "toc": [],
                "chapters": [{ "chapter": {
                    "id": "ch_a", "bookId": book_id, "title": "第一章", "blocks": []
                }}],
            }],
        });

        // 首次安装：cover base64 → cover.jpg。
        let outcome = ensure_seed_from_pack_value(&data, &pack).expect("pack seed");
        assert_eq!(outcome["installed"].as_array().unwrap().len(), 1);
        let target = data.join("books").join(book_id);
        assert_eq!(fs::read(target.join("cover.jpg")).unwrap(), cover);
        let stored = read_json_opt(&target.join("book.json")).unwrap().unwrap();
        assert_eq!(stored["coverFile"], "cover.jpg");

        // 模拟旧版种子副本：删掉 cover.jpg 与 book.json 的封面字段，再 ensure 应补齐。
        fs::remove_file(target.join("cover.jpg")).unwrap();
        let mut stored = stored;
        if let Value::Object(object) = &mut stored {
            object.remove("coverFile");
            object.remove("coverMime");
        }
        write_json(&target.join("book.json"), &stored).unwrap();

        let second = ensure_seed_from_pack_value(&data, &pack).expect("pack cover refresh");
        assert!(second["installed"].as_array().unwrap().is_empty());
        assert_eq!(fs::read(target.join("cover.jpg")).unwrap(), cover);
        let refreshed = read_json_opt(&target.join("book.json")).unwrap().unwrap();
        assert_eq!(refreshed["coverFile"], "cover.jpg");
        assert_eq!(refreshed["coverMime"], "image/jpeg");

        let _ = fs::remove_dir_all(root);
    }

    /// 全局检索测试库：1 本书 2 章 + 2 份摘要 + 3 条档案（其中 1 条重复）。
    fn write_search_fixture(root: &Path) -> String {
        let books = root.join("books");
        let book_id = "searchbook-11111111";
        let directory = books.join(book_id);
        fs::create_dir_all(directory.join("chapters/ch_a")).unwrap();
        fs::create_dir_all(directory.join("chapters/ch_b")).unwrap();
        fs::create_dir_all(directory.join("shared")).unwrap();
        let book = json!({
            "id": book_id,
            "title": "检索测试书",
            "author": "测试作者",
            "description": "用于全局检索测试的简介",
            "schemaVersion": 2,
            "chapterIds": ["ch_a", "ch_b"],
        });
        fs::write(
            directory.join("book.json"),
            serde_json::to_string(&book).unwrap(),
        )
        .unwrap();
        fs::write(
            books.join("index.json"),
            serde_json::to_string(&json!({ "schemaVersion": 2, "books": [book] })).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("chapters/ch_a/chapter.json"),
            serde_json::to_string(&json!({
                "id": "ch_a",
                "bookId": book_id,
                "title": "第一章 起点",
                "blocks": [
                    { "id": "p1", "kind": "heading", "text": "第一章 起点" },
                    { "id": "p2", "kind": "paragraph", "text": "正文里出现 Needle 关键字。" },
                ],
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("chapters/ch_b/chapter.json"),
            serde_json::to_string(&json!({
                "id": "ch_b",
                "bookId": book_id,
                "title": "第二章 终点",
                "blocks": [{ "id": "p1", "kind": "paragraph", "text": "没有关键字的正文。" }],
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("chapters/ch_a/digest.json"),
            serde_json::to_string(&json!({
                "title": "第一章 起点",
                "opening": "开篇提到 needle 的说明。",
                "keyPoints": [
                    { "section": "overview", "title": "要点标题", "text": "要点正文。" }
                ],
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("chapters/ch_b/digest.json"),
            serde_json::to_string(&json!({
                "title": "第二章 终点",
                "opening": "没有命中内容的摘要。",
                "keyPoints": [],
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("shared/archives.json"),
            serde_json::to_string(&json!({
                "schemaVersion": 2,
                "bookId": book_id,
                "entries": [
                    {
                        "id": "entry-a",
                        "bookId": book_id,
                        "chapterId": "ch_a",
                        "type": "legacy-article",
                        "title": "档案甲",
                        "body": "档案正文没有那个词。",
                        "createdAt": "2026-11-15T00:00:00.000Z",
                    },
                    {
                        "id": "entry-a",
                        "bookId": book_id,
                        "chapterId": "ch_a",
                        "type": "legacy-article",
                        "title": "档案甲",
                        "body": "档案正文没有那个词。",
                        "createdAt": "2026-11-15T00:00:00.000Z",
                    },
                    {
                        "id": "topic-a",
                        "bookId": book_id,
                        "type": "legacy-topic",
                        "title": "专题乙",
                        "body": "专题正文包含 needle 的内容。",
                        "createdAt": "2026-11-15T00:00:00.000Z",
                    },
                ],
            }))
            .unwrap(),
        )
        .unwrap();
        book_id.to_string()
    }

    /// 在检索测试库上追加第二本书（1 章），用于 bookIds 范围/全库书名测试。
    fn append_second_search_book(root: &Path) -> String {
        let books = root.join("books");
        let book_id = "searchbook-22222222";
        let directory = books.join(book_id);
        fs::create_dir_all(directory.join("chapters/ch_c")).unwrap();
        let book = json!({
            "id": book_id,
            "title": "第二本书",
            "author": "副作者",
            "description": "第二本简介",
            "schemaVersion": 2,
            "chapterIds": ["ch_c"],
        });
        fs::write(
            directory.join("book.json"),
            serde_json::to_string(&book).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("chapters/ch_c/chapter.json"),
            serde_json::to_string(&json!({
                "id": "ch_c",
                "bookId": book_id,
                "title": "第三章 别处",
                "blocks": [
                    { "id": "p1", "kind": "paragraph", "text": "第二本书正文也出现 needle 字样。" }
                ],
            }))
            .unwrap(),
        )
        .unwrap();
        let index_path = books.join("index.json");
        let mut index = read_json_opt(&index_path).unwrap().unwrap();
        index["books"].as_array_mut().unwrap().push(book.clone());
        write_json(&index_path, &index).unwrap();
        book_id.to_string()
    }

    fn run_search(root: &Path, query: &str, limit: usize) -> SearchOutcome {
        search_into(
            &root.join("books"),
            query,
            limit,
            None,
            true,
            false,
            |_, _| {},
            || false,
        )
        .expect("search")
    }

    #[test]
    fn global_search_matches_book_chapter_digest_and_archives() {
        let root = temp_root("search-kinds");
        write_search_fixture(&root);

        let outcome = run_search(&root, "needle", 100);
        assert_eq!(outcome.total, 2);
        assert!(!outcome.cancelled);
        assert_eq!(outcome.hits.len(), 3, "章节正文 + 摘要 opening + 专题档案");
        assert_eq!(outcome.hits[0]["kind"], "chapter");
        assert_eq!(outcome.hits[0]["bookId"], "searchbook-11111111");
        assert_eq!(outcome.hits[0]["bookTitle"], "检索测试书");
        assert_eq!(outcome.hits[0]["chapterId"], "ch_a");
        assert_eq!(outcome.hits[0]["chapterTitle"], "第一章 起点");
        assert_eq!(outcome.hits[0]["title"], "第一章 起点");
        assert!(outcome.hits[0].get("entryId").is_none());
        assert_eq!(outcome.hits[1]["kind"], "knowledge");
        assert_eq!(outcome.hits[1]["entryId"], "digest:ch_a");
        assert_eq!(outcome.hits[1]["chapterId"], "ch_a");
        assert_eq!(outcome.hits[2]["kind"], "knowledge");
        assert_eq!(outcome.hits[2]["entryId"], "topic-a");
        assert!(outcome.hits[2].get("chapterId").is_none());

        let book_outcome = run_search(&root, "检索测试书", 100);
        assert_eq!(book_outcome.hits.len(), 1);
        assert_eq!(book_outcome.hits[0]["kind"], "book");
        assert_eq!(book_outcome.hits[0]["title"], "检索测试书");
        assert!(book_outcome.hits[0]["snippet"]
            .as_str()
            .unwrap()
            .contains("测试作者"));
        assert!(book_outcome.hits[0].get("chapterId").is_none());

        let archive_outcome = run_search(&root, "档案甲", 100);
        assert_eq!(archive_outcome.hits.len(), 1, "同 key 的重复档案只留一条");
        assert_eq!(archive_outcome.hits[0]["entryId"], "entry-a");
        assert_eq!(archive_outcome.hits[0]["chapterTitle"], "第一章 起点");

        let digest_outcome = run_search(&root, "要点标题", 100);
        assert_eq!(digest_outcome.hits.len(), 1);
        assert_eq!(digest_outcome.hits[0]["entryId"], "digest:ch_a");

        let empty = run_search(&root, "不存在的词XYZ", 100);
        assert!(empty.hits.is_empty());
        assert_eq!(empty.scanned, 2, "未命中也要完成整轮扫描");

        let blank = run_search(&root, "   ", 100);
        assert!(blank.hits.is_empty());
        assert_eq!(blank.total, 0);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn global_search_is_ascii_case_insensitive() {
        let root = temp_root("search-case");
        write_search_fixture(&root);
        let lower = run_search(&root, "needle", 100);
        let upper = run_search(&root, "NEEDLE", 100);
        assert_eq!(lower.hits, upper.hits);
        assert_eq!(find_match("Hello Needle", "needle"), Some(6));
        assert_eq!(find_match("中文关键字测试", "关键字"), Some("中文".len()));
        assert_eq!(find_match("abc", "zz"), None);
        assert_eq!(find_match("", "x"), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn snippet_handles_multibyte_boundaries() {
        let text = "😀😀abc😀😀";
        assert_eq!(find_match(text, "abc"), Some("😀😀".len()));
        assert_eq!(snippet_around(text, "😀😀".len(), 3, 2), text);

        let long = "开端".to_string() + &"字".repeat(100) + "命中" + &"尾".repeat(100) + "结束";
        let position = find_match(&long, "命中").expect("命中位置");
        let snippet = snippet_around(&long, position, "命中".len(), 8);
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert!(snippet.contains("命中"));
        assert!(!snippet.contains("开端"), "窗口只保留命中附近文本");

        // 命中在开头/结尾时不应越界 panic。
        assert_eq!(snippet_around("命中开头", 0, "命中".len(), 20), "命中开头");
        let tail = snippet_around("结尾命中", "结尾".len(), "命中".len(), 20);
        assert_eq!(tail, "结尾命中");
    }

    #[test]
    fn global_search_truncates_to_limit() {
        let root = temp_root("search-limit");
        write_search_fixture(&root);
        let limited = run_search(&root, "第一章", 1);
        assert_eq!(limited.hits.len(), 1);
        assert_eq!(limited.hits[0]["kind"], "chapter");
        let full = run_search(&root, "第一章", 100);
        assert_eq!(full.hits.len(), 2, "章节标题 + 摘要标题各一条");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn global_search_stops_on_cancel() {
        let root = temp_root("search-cancel");
        write_search_fixture(&root);
        let calls = std::cell::Cell::new(0usize);
        let outcome = search_into(
            &root.join("books"),
            "needle",
            100,
            None,
            true,
            false,
            |_, _| {},
            || {
                calls.set(calls.get() + 1);
                calls.get() > 1
            },
        )
        .expect("search");
        assert!(outcome.cancelled);
        assert_eq!(outcome.scanned, 1, "第 1 章后收到取消，不再扫第 2 章");
        assert_eq!(outcome.total, 2);
        assert_eq!(outcome.hits.len(), 2, "取消后返回已收集的章节/摘要结果");
        assert!(outcome.hits.iter().all(|hit| hit["chapterId"] == "ch_a"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn global_search_respects_book_scope() {
        let root = temp_root("search-scope");
        write_search_fixture(&root);
        let second = append_second_search_book(&root);
        let scope = vec!["searchbook-11111111".to_string()];

        // bookIds 子集：total 只算范围内章节，且只返回该书命中。
        let scoped = search_into(
            &root.join("books"),
            "needle",
            100,
            Some(&scope),
            true,
            false,
            |_, _| {},
            || false,
        )
        .expect("scoped search");
        assert_eq!(scoped.total, 2);
        assert_eq!(scoped.scanned, 2);
        assert_eq!(scoped.hits.len(), 3);
        assert!(scoped
            .hits
            .iter()
            .all(|hit| hit["bookId"] == "searchbook-11111111"));

        // 默认全库：两本书都扫。
        let full = run_search(&root, "needle", 100);
        assert_eq!(full.total, 3);
        assert_eq!(full.hits.len(), 4);
        assert!(full.hits.iter().any(|hit| hit["bookId"] == second.as_str()));

        // 书名/作者命中不受 bookIds 限制（全库范围）。
        let title = search_into(
            &root.join("books"),
            "第二本书",
            100,
            Some(&scope),
            true,
            false,
            |_, _| {},
            || false,
        )
        .expect("book level search");
        assert_eq!(title.hits.len(), 1);
        assert_eq!(title.hits[0]["kind"], "book");
        assert_eq!(title.hits[0]["bookId"], second.as_str());
        assert_eq!(title.total, 2, "书名命中不扩大章节扫描范围");

        // includeBookLevel=false 时不做书名/作者匹配。
        let no_book_level = search_into(
            &root.join("books"),
            "第二本书",
            100,
            Some(&scope),
            false,
            false,
            |_, _| {},
            || false,
        )
        .expect("no book level search");
        assert!(no_book_level.hits.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn global_search_matches_author() {
        let root = temp_root("search-author");
        write_search_fixture(&root);
        let outcome = run_search(&root, "测试作者", 100);
        assert_eq!(outcome.hits.len(), 1);
        let hit = &outcome.hits[0];
        assert_eq!(hit["kind"], "author");
        assert_eq!(hit["title"], "检索测试书");
        assert_eq!(hit["bookTitle"], "检索测试书");
        assert_eq!(hit["author"], "测试作者");
        assert!(hit["snippet"].as_str().unwrap().contains("测试作者"));
        assert!(hit.get("chapterId").is_none());

        let partial = run_search(&root, "作者", 100);
        assert!(partial.hits.iter().any(|hit| hit["kind"] == "author"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn global_search_knowledge_only_skips_content_and_book_level() {
        let root = temp_root("search-knowledge");
        write_search_fixture(&root);
        let outcome = search_into(
            &root.join("books"),
            "needle",
            100,
            None,
            true,
            true,
            |_, _| {},
            || false,
        )
        .expect("knowledge only search");
        assert_eq!(outcome.total, 2);
        assert_eq!(outcome.scanned, 2);
        assert_eq!(outcome.hits.len(), 2, "摘要 opening + 专题档案；正文不返回");
        assert!(outcome.hits.iter().all(|hit| hit["kind"] == "knowledge"));

        // 只出现在章节正文里的词不返回。
        let chapter_only = search_into(
            &root.join("books"),
            "关键字",
            100,
            None,
            true,
            true,
            |_, _| {},
            || false,
        )
        .expect("knowledge only chapter word");
        assert!(chapter_only.hits.is_empty());

        // 书名/作者不参与 knowledgeOnly。
        let book_title = search_into(
            &root.join("books"),
            "检索测试书",
            100,
            None,
            true,
            true,
            |_, _| {},
            || false,
        )
        .expect("knowledge only book title");
        assert!(book_title.hits.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rfc3339_formats_utc_timestamps() {
        assert_eq!(rfc3339_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            rfc3339_from_millis(1_700_000_000_000),
            "2023-11-14T22:13:20.000Z"
        );
        assert_eq!(
            rfc3339_from_millis(1_700_000_000_123),
            "2023-11-14T22:13:20.123Z"
        );
    }

    #[test]
    fn import_writes_cover_sidecar() {
        let root = temp_root("import-cover");
        let books = root.join("books");
        let source = root.join("封面书.epub");
        fs::write(&source, b"epub-with-cover").unwrap();
        let cover_bytes = b"\xff\xd8\xff\xe0fake-jpeg".to_vec();
        let cover = base64::engine::general_purpose::STANDARD.encode(&cover_bytes);
        let meta = import_book_into(
            &books,
            &source,
            "fengmian",
            &json!({ "title": "封面书", "author": "作者" }),
            &sample_toc(),
            &sample_chapters(),
            &sample_digests(),
            "2026-11-15T00:00:00.000Z",
            Some(&cover),
            Some("image/jpeg"),
        )
        .expect("import with cover");
        let book_id = meta["id"].as_str().unwrap();
        assert_eq!(meta["coverFile"], "cover.jpg");
        assert_eq!(meta["coverMime"], "image/jpeg");
        assert_eq!(
            fs::read(books.join(book_id).join("cover.jpg")).unwrap(),
            cover_bytes
        );
        let stored = read_json_opt(&books.join(book_id).join("book.json"))
            .unwrap()
            .unwrap();
        assert_eq!(stored["coverFile"], "cover.jpg");
        assert_eq!(stored["coverMime"], "image/jpeg");
        let index = read_json_opt(&books.join("index.json")).unwrap().unwrap();
        assert_eq!(index["books"][0]["coverFile"], "cover.jpg");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn move_tree_into_moves_nested_files() {
        // 回退路径：整目录 rename 不可用时，逐项把临时目录树搬到目标目录。
        let root = temp_root("move-tree");
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("chapters/ch_1")).unwrap();
        fs::create_dir_all(source.join("source")).unwrap();
        fs::write(source.join("book.json"), b"{}").unwrap();
        fs::write(
            source.join("chapters/ch_1/chapter.json"),
            b"{\"id\":\"ch_1\"}",
        )
        .unwrap();
        fs::write(source.join("source/原文件.epub"), b"epub").unwrap();

        move_tree_into(&source, &target).expect("move tree");

        assert!(target.join("book.json").exists());
        assert!(target.join("chapters/ch_1/chapter.json").exists());
        assert!(target.join("source/原文件.epub").exists());
        assert!(!source.join("book.json").exists());
        assert!(!source.join("chapters/ch_1/chapter.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_ignores_invalid_or_oversized_cover() {
        let root = temp_root("import-bad-cover");
        let books = root.join("books");
        let source = root.join("无封面书.epub");
        fs::write(&source, b"epub-without-cover").unwrap();
        let oversized =
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_COVER_BYTES + 1]);
        let cases = [Some("!!!not-base64!!!"), Some(oversized.as_str()), Some("")];
        for cover in cases {
            let meta = import_book_into(
                &books,
                &source,
                "wufengmian",
                &json!({ "title": "无封面书" }),
                &sample_toc(),
                &sample_chapters(),
                &sample_digests(),
                "2026-11-15T00:00:00.000Z",
                cover,
                None,
            )
            .expect("import ignores bad cover");
            let book_id = meta["id"].as_str().unwrap();
            assert!(meta.get("coverFile").is_none());
            assert!(!books.join(book_id).join("cover.jpg").exists());
        }
        let _ = fs::remove_dir_all(root);
    }

    fn write_recent_book(books: &Path, book_id: &str, title: &str, author: &str) {
        let directory = books.join(book_id);
        fs::create_dir_all(&directory).unwrap();
        let book = json!({
            "id": book_id,
            "title": title,
            "author": author,
            "schemaVersion": 2,
            "chapterIds": ["ch_a"],
        });
        fs::write(
            directory.join("book.json"),
            serde_json::to_string(&book).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn recent_books_roundtrip_dedup_and_order() {
        let root = temp_root("recent");
        let books = root.join("books");
        write_recent_book(&books, "recent-book-a", "甲书", "甲作者");
        write_recent_book(&books, "recent-book-b", "乙书", "乙作者");
        let recent_path = root.join("recent.json");

        // 缺失文件：返回空且不自动创建。
        assert!(read_recent_into(&books, &recent_path).unwrap().is_empty());
        assert!(!recent_path.exists());

        record_recent_into(&books, &recent_path, "recent-book-a").unwrap();
        record_recent_into(&books, &recent_path, "recent-book-b").unwrap();
        let list = read_recent_into(&books, &recent_path).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["bookId"], "recent-book-b");
        assert_eq!(list[0]["title"], "乙书");
        assert_eq!(list[0]["author"], "乙作者");
        let opened_at = list[0]["openedAt"].as_str().unwrap();
        assert!(opened_at.ends_with('Z'));
        assert!(opened_at.contains('T'));

        // 重复打开：移到最前，不产生重复条目。
        record_recent_into(&books, &recent_path, "recent-book-a").unwrap();
        let list = read_recent_into(&books, &recent_path).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["bookId"], "recent-book-a");
        assert_eq!(list[1]["bookId"], "recent-book-b");

        // 原子写：schemaVersion 1，无临时文件残留。
        let stored = read_json_opt(&recent_path).unwrap().unwrap();
        assert_eq!(stored["schemaVersion"], RECENT_SCHEMA_VERSION);
        assert!(!root.join("recent.json.tmp").exists());
        let leftovers: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "临时文件未清理：{leftovers:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recent_books_filter_missing_and_old_books() {
        let root = temp_root("recent-filter");
        let books = root.join("books");
        write_recent_book(&books, "recent-book-a", "甲书", "甲作者");
        // 旧存档：schemaVersion 1 的书不可记入最近阅读。
        let old = books.join("oldbook-1111");
        fs::create_dir_all(&old).unwrap();
        let old_book = json!({
            "id": "oldbook-1111",
            "title": "旧存档",
            "schemaVersion": 1,
            "chapterIds": ["ch_a"],
        });
        fs::write(
            old.join("book.json"),
            serde_json::to_string(&old_book).unwrap(),
        )
        .unwrap();
        let recent_path = root.join("recent.json");
        write_json(
            &recent_path,
            &json!({
                "schemaVersion": 1,
                "books": [
                    { "bookId": "missing-book", "title": "已删除", "openedAt": "2026-11-15T00:00:00.000Z" },
                    { "bookId": "oldbook-1111", "title": "旧存档", "openedAt": "2026-11-15T00:00:00.000Z" },
                    { "bookId": "recent-book-a", "title": "甲书", "author": "甲作者", "openedAt": "2026-11-15T00:00:00.000Z" },
                    { "bookId": "recent-book-a", "title": "甲书", "openedAt": "2026-11-15T00:00:00.000Z" }
                ]
            }),
        )
        .unwrap();
        let list = read_recent_into(&books, &recent_path).unwrap();
        assert_eq!(list.len(), 1, "缺失/旧存档条目被过滤，重复条目去重");
        assert_eq!(list[0]["bookId"], "recent-book-a");

        // 记录不存在/旧格式的书返回 NOT_FOUND，且不改写文件。
        assert!(record_recent_into(&books, &recent_path, "missing-book").is_err());
        assert!(record_recent_into(&books, &recent_path, "oldbook-1111").is_err());
        assert_eq!(read_recent_into(&books, &recent_path).unwrap().len(), 1);

        // 非 schemaVersion 1 的 recent.json 视为空列表。
        write_json(&recent_path, &json!({ "schemaVersion": 2, "books": [] })).unwrap();
        assert!(read_recent_into(&books, &recent_path).unwrap().is_empty());

        let _ = fs::remove_dir_all(root);
    }

    fn write_knowledge_book(root: &Path, book_id: &str, schema_version: u64) -> PathBuf {
        let books = root.join("books");
        let directory = books.join(book_id);
        fs::create_dir_all(&directory).unwrap();
        let book = json!({
            "id": book_id,
            "title": "知识测试书",
            "author": "作者",
            "schemaVersion": schema_version,
            "chapterIds": ["ch_a", "ch_b"],
        });
        fs::write(
            directory.join("book.json"),
            serde_json::to_string(&book).unwrap(),
        )
        .unwrap();
        directory
    }

    #[test]
    fn add_knowledge_appends_and_is_readable() {
        let root = temp_root("knowledge-add");
        let book_id = "knowbook-11111111";
        let directory = write_knowledge_book(&root, book_id, 2);
        let book_before = fs::read(directory.join("book.json")).unwrap();
        let books = root.join("books");

        let entry = add_knowledge_into(
            &books,
            book_id,
            Some("ch_a"),
            Some("search"),
            "  标题  ",
            " 正文内容 ",
            Some(&json!({ "source": "agent", "question": "Q?" })),
        )
        .expect("add knowledge");
        assert_eq!(entry["bookId"], book_id);
        assert_eq!(entry["chapterId"], "ch_a");
        assert_eq!(entry["type"], "search");
        assert_eq!(entry["title"], "标题");
        assert_eq!(entry["body"], "正文内容");
        assert_eq!(entry["payload"]["source"], "agent");
        assert_eq!(entry["payload"]["question"], "Q?");
        let id = entry["id"].as_str().unwrap();
        assert!(id.starts_with("agent-"), "id 格式：{id}");
        let created = entry["createdAt"].as_str().unwrap();
        assert!(created.contains('T') && created.ends_with('Z'));

        // 与 library_list_knowledge 同口径（archives_entries）可读。
        let listed = archives_entries_from(&directory).expect("list knowledge");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["id"], id);

        // 第二条：缺省 type=note、无 chapterId/payload、追加在末尾、id 不重复。
        let second = add_knowledge_into(&books, book_id, None, None, "第二条", "内容", None)
            .expect("second knowledge");
        assert_eq!(second["type"], "note");
        assert!(second.get("chapterId").is_none());
        assert!(second.get("payload").is_none());
        let listed = archives_entries_from(&directory).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[1]["title"], "第二条");
        assert_ne!(listed[0]["id"], listed[1]["id"]);

        // archives.json 缺失时按约定创建 schemaVersion=1 / bookId / entries。
        let archive = read_json_opt(&directory.join("shared/archives.json"))
            .unwrap()
            .unwrap();
        assert_eq!(archive["schemaVersion"], 1);
        assert_eq!(archive["bookId"], book_id);
        assert_eq!(archive["entries"].as_array().unwrap().len(), 2);

        // 不修改 book.json；原子写无 tmp 残留。
        assert_eq!(fs::read(directory.join("book.json")).unwrap(), book_before);
        assert!(!directory.join("shared/archives.json.tmp").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn add_knowledge_accepts_place_and_timeline_entries() {
        let root = temp_root("knowledge-topics");
        let book_id = "knowbook-55555555";
        let directory = write_knowledge_book(&root, book_id, 2);
        let books = root.join("books");

        // place/timeline 为导入构建写入的地图/时间线条目，payload 必为对象。
        let place = add_knowledge_into(
            &books,
            book_id,
            Some("ch_a"),
            Some("place"),
            "广州",
            "地点说明",
            Some(&json!({ "lon": 113.2, "lat": 23.1, "themes": ["agent-build"] })),
        )
        .expect("place knowledge");
        assert_eq!(place["type"], "place");
        assert_eq!(place["chapterId"], "ch_a");
        assert_eq!(place["payload"]["lon"], json!(113.2));

        let event = add_knowledge_into(
            &books,
            book_id,
            Some("ch_a"),
            Some("timeline"),
            "事件一",
            "事件说明",
            Some(&json!({ "date": "1921-07-01", "importance": 3 })),
        )
        .expect("timeline knowledge");
        assert_eq!(event["type"], "timeline");
        assert_eq!(event["payload"]["date"], json!("1921-07-01"));

        // payload 缺失 / 非对象 → INVALID_INPUT，不写入。
        for entry_type in ["place", "timeline"] {
            for payload in [None, Some(json!("字符串")), Some(json!([1, 2]))] {
                assert_eq!(
                    error_code(add_knowledge_into(
                        &books,
                        book_id,
                        None,
                        Some(entry_type),
                        "标题",
                        "正文",
                        payload.as_ref(),
                    )),
                    "INVALID_INPUT",
                    "entry_type={entry_type} payload={payload:?}"
                );
            }
        }

        // note/search 仍允许缺省 payload。
        add_knowledge_into(&books, book_id, None, Some("note"), "笔记", "正文", None)
            .expect("note without payload");
        add_knowledge_into(&books, book_id, None, Some("search"), "检索", "正文", None)
            .expect("search without payload");

        let listed = archives_entries_from(&directory).unwrap();
        assert_eq!(listed.len(), 4);
        assert_eq!(listed[0]["type"], json!("place"));
        assert_eq!(listed[1]["type"], json!("timeline"));
        assert_eq!(listed[2]["type"], json!("note"));
        assert_eq!(listed[3]["type"], json!("search"));
        assert!(!directory.join("shared/archives.json.tmp").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn add_knowledge_preserves_archive_structure() {
        let root = temp_root("knowledge-preserve");
        let book_id = "knowbook-22222222";
        let directory = write_knowledge_book(&root, book_id, 2);
        let archive_path = directory.join("shared/archives.json");
        write_json(
            &archive_path,
            &json!({
                "schemaVersion": 2,
                "bookId": book_id,
                "generatedAt": "2026-01-01T00:00:00.000Z",
                "entries": [{
                    "id": "legacy-a",
                    "bookId": book_id,
                    "type": "legacy-article",
                    "title": "旧条目",
                    "body": "旧正文",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                }],
            }),
        )
        .unwrap();

        add_knowledge_into(
            &root.join("books"),
            book_id,
            Some("ch_b"),
            Some("note"),
            "新条目",
            "新正文",
            None,
        )
        .expect("add knowledge");

        let archive = read_json_opt(&archive_path).unwrap().unwrap();
        assert_eq!(archive["schemaVersion"], 2, "沿用现有 schemaVersion");
        assert_eq!(
            archive["generatedAt"], "2026-01-01T00:00:00.000Z",
            "保留自定义顶层字段"
        );
        let entries = archive["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["id"], "legacy-a", "旧条目保留在前");
        assert_eq!(entries[1]["chapterId"], "ch_b");
        assert_eq!(entries[1]["title"], "新条目");
        assert!(!archive_path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn add_knowledge_rejects_invalid_input() {
        let root = temp_root("knowledge-invalid");
        let books = root.join("books");
        let book_id = "knowbook-33333333";
        let directory = write_knowledge_book(&root, book_id, 2);
        let archive_path = directory.join("shared/archives.json");

        // 不存在的书 / 旧存档（schemaVersion 1）书。
        assert!(
            add_knowledge_into(&books, "missing-book", None, None, "标题", "正文", None).is_err()
        );
        write_knowledge_book(&root, "oldknow-44444444", 1);
        assert!(
            add_knowledge_into(&books, "oldknow-44444444", None, None, "标题", "正文", None)
                .is_err()
        );

        // 章节不属于本书。
        let err = add_knowledge_into(&books, book_id, Some("ch_x"), None, "标题", "正文", None)
            .unwrap_err();
        assert_eq!(err.code, "INVALID_INPUT");

        // 空/超长标题、空/超长正文（按字符计）。
        assert!(add_knowledge_into(&books, book_id, None, None, "   ", "正文", None).is_err());
        assert!(
            add_knowledge_into(&books, book_id, None, None, &"题".repeat(201), "正文", None)
                .is_err()
        );
        assert!(add_knowledge_into(&books, book_id, None, None, "标题", "\n\t ", None).is_err());
        assert!(add_knowledge_into(
            &books,
            book_id,
            None,
            None,
            "标题",
            &"文".repeat(20_001),
            None
        )
        .is_err());

        // 非法类型（不做静默回落）。
        assert!(add_knowledge_into(
            &books,
            book_id,
            None,
            Some("legacy-article"),
            "标题",
            "正文",
            None
        )
        .is_err());

        // 以上非法调用都不应创建 archives.json。
        assert!(!archive_path.exists());

        // 边界：200 字标题 + 20000 字正文通过。
        add_knowledge_into(
            &books,
            book_id,
            None,
            None,
            &"题".repeat(200),
            &"文".repeat(20_000),
            None,
        )
        .expect("boundary length ok");
        assert_eq!(archives_entries_from(&directory).unwrap().len(), 1);

        // 之后非法调用不再追加。
        assert!(add_knowledge_into(&books, book_id, None, None, "", "正文", None).is_err());
        assert_eq!(archives_entries_from(&directory).unwrap().len(), 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn knowledge_ids_increment_on_collision() {
        let mut ids = HashSet::new();
        let first = next_knowledge_id(&ids, 1_700_000_000_000);
        assert_eq!(first, "agent-1700000000000-0000");
        ids.insert(first);
        let second = next_knowledge_id(&ids, 1_700_000_000_000);
        assert_eq!(second, "agent-1700000000000-0001");
        assert!(!ids.contains(&second));
    }

    // ---- 批量摘要 / 章节 explore / 原始文件书（parseState=pending） ----

    fn error_code<T>(result: Result<T, ApiError>) -> &'static str {
        match result {
            Ok(_) => panic!("预期返回错误，实际成功"),
            Err(error) => error.code,
        }
    }

    /// 写一本书的 book.json（`extra` 合并进顶层，用于 pending/format 等新字段）。
    fn write_book_meta(
        books: &Path,
        book_id: &str,
        chapter_ids: &[&str],
        extra: &Value,
    ) -> PathBuf {
        let directory = books.join(book_id);
        fs::create_dir_all(&directory).unwrap();
        let mut book = json!({
            "id": book_id,
            "title": format!("书 {book_id}"),
            "schemaVersion": 2,
            "chapterIds": chapter_ids,
        });
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                book[key] = value.clone();
            }
        }
        fs::write(
            directory.join("book.json"),
            serde_json::to_string(&book).unwrap(),
        )
        .unwrap();
        directory
    }

    /// 写章节目录：chapter.json 必有；digest/explore 按需写入。
    fn write_chapter_files(
        directory: &Path,
        book_id: &str,
        chapter_id: &str,
        digest: Option<&Value>,
        explore: Option<&Value>,
    ) {
        let chapter_dir = directory.join("chapters").join(chapter_id);
        fs::create_dir_all(&chapter_dir).unwrap();
        fs::write(
            chapter_dir.join("chapter.json"),
            serde_json::to_string(&json!({
                "id": chapter_id,
                "bookId": book_id,
                "title": chapter_id,
                "blocks": [{ "id": "p1", "kind": "paragraph", "text": "正文" }],
            }))
            .unwrap(),
        )
        .unwrap();
        if let Some(digest) = digest {
            fs::write(
                chapter_dir.join("digest.json"),
                serde_json::to_string(digest).unwrap(),
            )
            .unwrap();
        }
        if let Some(explore) = explore {
            fs::write(
                chapter_dir.join("explore.json"),
                serde_json::to_string(explore).unwrap(),
            )
            .unwrap();
        }
    }

    fn sample_full_digest(chapter_id: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "bookId": "digestbook-01",
            "chapterId": chapter_id,
            "title": format!("章节 {chapter_id}"),
            "generatedAt": "2026-11-15T00:00:00.000Z",
            "source": "import-structure",
            "stats": { "charCount": 2, "paragraphCount": 1, "headingCount": 0, "noteCount": 0 },
            "headings": ["小标题"],
            "opening": "正文",
            "closing": "正文",
            "keyPoints": [{ "section": "正文", "text": "要点", "citations": [] }],
        })
    }

    #[test]
    fn list_chapter_digests_reads_all_in_chapter_order() {
        let root = temp_root("digests");
        let books = root.join("books");
        let book_id = "digestbook-01";
        let directory = write_book_meta(
            &books,
            book_id,
            &["ch_a", "ch_b", "ch_c", "ch_d", "ch_e"],
            &json!({}),
        );
        let digest_a = sample_full_digest("ch_a");
        let digest_b = sample_full_digest("ch_b");
        write_chapter_files(&directory, book_id, "ch_a", Some(&digest_a), None);
        write_chapter_files(&directory, book_id, "ch_b", Some(&digest_b), None);
        // ch_c：摘要缺失 → 跳过。
        write_chapter_files(&directory, book_id, "ch_c", None, None);
        // ch_d：损坏 JSON → 跳过；ch_e：非对象 → 跳过。
        write_chapter_files(&directory, book_id, "ch_d", None, None);
        write_chapter_files(&directory, book_id, "ch_e", None, None);
        fs::write(directory.join("chapters/ch_d/digest.json"), "{ not json").unwrap();
        fs::write(directory.join("chapters/ch_e/digest.json"), "[]").unwrap();

        let digests = list_chapter_digests_into(&books, book_id).unwrap();
        assert_eq!(digests.len(), 2);
        assert_eq!(digests[0]["chapterId"], json!("ch_a"));
        assert_eq!(digests[0]["title"], json!("章节 ch_a"));
        // 完整对象：stats/headings/keyPoints/citations 等长字段都保留（前端只投影所需部分）。
        assert_eq!(digests[0]["stats"]["paragraphCount"], json!(1));
        assert_eq!(digests[0]["headings"], json!(["小标题"]));
        assert_eq!(digests[0]["keyPoints"][0]["text"], json!("要点"));
        assert_eq!(digests[1]["chapterId"], json!("ch_b"));
        assert_eq!(digests[1]["opening"], json!("正文"));

        // 书缺失 → 空数组；bookId 非法 → INVALID_INPUT。
        assert!(list_chapter_digests_into(&books, "missing-book-1")
            .unwrap()
            .is_empty());
        assert_eq!(
            error_code(list_chapter_digests_into(&books, "BAD ID")),
            "INVALID_INPUT"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn chapter_explore_returns_normalized_projection_or_null() {
        let root = temp_root("explore");
        let books = root.join("books");
        let book_id = "explorebook-01";
        let directory = write_book_meta(
            &books,
            book_id,
            &["v1-0101", "v1-0102", "v1-0103"],
            &json!({}),
        );
        let explore = json!({
            "schemaVersion": 1,
            "bookId": "some-other-book",
            "chapterId": "v1-0102",
            "map": {
                "placeIds": ["guangzhou", "  "],
                "routeIds": ["route-1"],
                "focus": { "lon": 113.2, "lat": 23.1, "zoom": 6 },
            },
            "timeline": { "eventIds": ["evt-1"] },
        });
        write_chapter_files(&directory, book_id, "v1-0101", None, Some(&explore));

        let value = chapter_explore_into(&books, book_id, "v1-0101").unwrap();
        // bookId/chapterId 以调用参数为准（文件里的旧值不采信）。
        assert_eq!(value["schemaVersion"], json!(1));
        assert_eq!(value["bookId"], json!(book_id));
        assert_eq!(value["chapterId"], json!("v1-0101"));
        // 数组缺省补空、空白项过滤；focus 保留 zoom（JSON 数字统一按 f64 输出）。
        assert_eq!(value["map"]["placeIds"], json!(["guangzhou"]));
        assert_eq!(value["map"]["routeIds"], json!(["route-1"]));
        assert_eq!(value["map"]["themeIds"], json!([]));
        assert_eq!(value["map"]["focus"]["lon"], json!(113.2));
        assert_eq!(value["map"]["focus"]["lat"], json!(23.1));
        assert_eq!(value["map"]["focus"]["zoom"], json!(6.0));
        assert_eq!(value["timeline"]["eventIds"], json!(["evt-1"]));

        // 缺失 / 不属于该书 / 书不存在 → null。
        assert!(chapter_explore_into(&books, book_id, "v1-0102")
            .unwrap()
            .is_null());
        assert!(chapter_explore_into(&books, book_id, "v1-9999")
            .unwrap()
            .is_null());
        assert!(chapter_explore_into(&books, "missing-book-1", "v1-0101")
            .unwrap()
            .is_null());
        // 非法 id → INVALID_INPUT（与 chapter_dir 同口径）。
        assert_eq!(
            error_code(chapter_explore_into(&books, book_id, "bad id")),
            "INVALID_INPUT"
        );
        assert_eq!(
            error_code(chapter_explore_into(&books, "../etc", "v1-0101")),
            "INVALID_INPUT"
        );

        // 损坏 JSON / schemaVersion 不符 → null。
        write_chapter_files(&directory, book_id, "v1-0102", None, None);
        fs::write(
            directory.join("chapters/v1-0102/explore.json"),
            "{ not json",
        )
        .unwrap();
        assert!(chapter_explore_into(&books, book_id, "v1-0102")
            .unwrap()
            .is_null());
        write_chapter_files(
            &directory,
            book_id,
            "v1-0102",
            None,
            Some(&json!({ "schemaVersion": 2, "map": null, "timeline": null })),
        );
        assert!(chapter_explore_into(&books, book_id, "v1-0102")
            .unwrap()
            .is_null());

        // 宽松规范化：map/timeline 类型不对 → null；focus 非法 → null；只有 timeline 也合法。
        write_chapter_files(
            &directory,
            book_id,
            "v1-0103",
            None,
            Some(&json!({
                "schemaVersion": 1,
                "map": "坏数据",
                "timeline": { "eventIds": ["evt-2", ""] },
                "focus": { "lon": 999, "lat": 0 },
            })),
        );
        let value = chapter_explore_into(&books, book_id, "v1-0103").unwrap();
        assert!(value["map"].is_null());
        assert_eq!(value["timeline"]["eventIds"], json!(["evt-2"]));

        write_chapter_files(
            &directory,
            book_id,
            "v1-0102",
            None,
            Some(&json!({
                "schemaVersion": 1,
                "map": { "placeIds": ["guangzhou"], "focus": { "lon": 999, "lat": 0 } },
            })),
        );
        let value = chapter_explore_into(&books, book_id, "v1-0102").unwrap();
        assert_eq!(value["map"]["placeIds"], json!(["guangzhou"]));
        assert!(value["map"]["focus"].is_null());
        assert!(value["timeline"].is_null());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_original_book_is_valid_but_has_no_chapters() {
        let root = temp_root("pending");
        let books = root.join("books");
        let book_id = "pendingbook-1";
        let directory = write_book_meta(
            &books,
            book_id,
            &[],
            &json!({
                "format": "pdf",
                "parseState": "pending",
                "sourceName": "sample.pdf",
                "sourceSize": 1024,
            }),
        );

        // 校验口径：schemaVersion 2 + parseState=pending（无章节）仍是合法书。
        let stored = read_json_opt(&directory.join("book.json"))
            .unwrap()
            .unwrap();
        assert!(is_valid_book(&stored));
        assert!(load_valid_book(&books, book_id).is_some());
        // 批量摘要对无章节的 pending 书返回空数组。
        assert!(list_chapter_digests_into(&books, book_id)
            .unwrap()
            .is_empty());
        // 最近阅读也认可 pending 书（同 load_valid_book 口径）。
        let recent = record_recent_into(&books, &root.join("recent.json"), book_id).unwrap();
        assert_eq!(recent[0]["bookId"], json!(book_id));
        assert_eq!(recent[0]["title"], json!(format!("书 {book_id}")));

        // 反例：无章节且非 pending / 旧 schemaVersion / 缺 parseState 都不算合法书。
        assert!(!is_valid_book(
            &json!({ "schemaVersion": 2, "chapterIds": [] })
        ));
        assert!(!is_valid_book(
            &json!({ "schemaVersion": 2, "chapterIds": [], "parseState": "parsed" })
        ));
        assert!(!is_valid_book(
            &json!({ "schemaVersion": 1, "chapterIds": ["ch_1"] })
        ));
        assert!(!is_valid_book(&json!({ "schemaVersion": 2 })));
        // 正常书仍合法。
        assert!(is_valid_book(
            &json!({ "schemaVersion": 2, "chapterIds": ["ch_1"] })
        ));
        let empty_id = "emptybook-01";
        write_book_meta(&books, empty_id, &[], &json!({}));
        assert!(load_valid_book(&books, empty_id).is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "依赖本机开发用户库 data/library（gitignored）"]
    fn real_library_digests_and_explore_smoke() {
        let books_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("data")
            .join("library")
            .join("books");
        if !books_root.join("index.json").exists() {
            eprintln!("没有 data/library，跳过");
            return;
        }
        let index = read_json_opt(&books_root.join("index.json"))
            .unwrap()
            .unwrap_or(Value::Null);
        let book_ids: Vec<String> = index
            .get("books")
            .and_then(Value::as_array)
            .map(|books| {
                books
                    .iter()
                    .filter_map(|book| book.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let mut total_digests = 0usize;
        let mut total_explore = 0usize;
        for book_id in &book_ids {
            let digests = list_chapter_digests_into(&books_root, book_id).expect("list digests");
            assert!(
                digests.iter().all(Value::is_object),
                "{book_id} 的摘要必须是对象数组"
            );
            total_digests += digests.len();
            let Some(book) = load_valid_book(&books_root, book_id) else {
                continue;
            };
            let chapter_ids: Vec<String> = book
                .get("chapterIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            for chapter_id in chapter_ids.iter().take(3) {
                let value = chapter_explore_into(&books_root, book_id, chapter_id)
                    .expect("chapter explore");
                if !value.is_null() {
                    assert_eq!(value["schemaVersion"], json!(1));
                    assert_eq!(value["chapterId"], json!(chapter_id));
                    assert_eq!(value["bookId"], json!(book_id));
                    total_explore += 1;
                }
            }
        }
        eprintln!(
            "真实库：{} 本书，{} 份摘要，抽样 {} 份 explore",
            book_ids.len(),
            total_digests,
            total_explore
        );
        assert!(total_digests > 0, "开发库应至少有一份摘要");
    }

    #[test]
    #[ignore = "依赖本机开发用户库 data/library（gitignored）"]
    fn global_search_real_library_timing() {
        let books_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("data")
            .join("library")
            .join("books");
        if !books_root.join("index.json").exists() {
            eprintln!("没有 data/library，跳过实测");
            return;
        }
        let started = Instant::now();
        let outcome = search_into(
            &books_root,
            "革命",
            100,
            None,
            true,
            false,
            |_, _| {},
            || false,
        )
        .expect("search");
        let elapsed = started.elapsed();
        eprintln!(
            "全局检索实测：扫描 {}/{} 章，{} 条命中，耗时 {:?}",
            outcome.scanned,
            outcome.total,
            outcome.hits.len(),
            elapsed
        );
        for hit in outcome.hits.iter().take(3) {
            eprintln!(
                "  kind={} book={} chapter={:?} entry={:?} title={} snippet={}",
                hit["kind"],
                hit["bookTitle"],
                hit.get("chapterId"),
                hit.get("entryId"),
                hit["title"],
                hit["snippet"],
            );
        }
        assert_eq!(outcome.total, 160);
        assert!(!outcome.hits.is_empty());
    }
}

// ---------------------------------------------------------------------------
// 最近阅读：用户库 dataDir/recent.json（schemaVersion 1，最多 50 本，最近在前）。
// ---------------------------------------------------------------------------

const RECENT_SCHEMA_VERSION: u64 = 1;
const RECENT_MAX_BOOKS: usize = 50;

/// 读取 book.json 并校验与 `library_get_book` 同口径（库侧允许 pending 原始文件书，
/// 见 `util::load_valid_book`；章节型校验由各调用点自行处理）。
fn load_valid_book(books_root: &Path, book_id: &str) -> Option<Value> {
    crate::util::load_valid_book(books_root, book_id, true)
}

/// 读取最近阅读列表：过滤已删除/旧存档（非 schemaVersion 2）的书，去重，最多 50 条。
/// 文件不存在时返回空列表，且不创建文件。
fn read_recent_into(books_root: &Path, recent_path: &Path) -> Result<Vec<Value>, ApiError> {
    let Some(value) = read_json_opt(recent_path)? else {
        return Ok(Vec::new());
    };
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(RECENT_SCHEMA_VERSION) {
        return Ok(Vec::new());
    }
    let entries = value
        .get("books")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut books = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in entries {
        let Some(book_id) = entry.get("bookId").and_then(Value::as_str) else {
            continue;
        };
        if !seen.insert(book_id.to_string()) {
            continue;
        }
        let Some(book) = load_valid_book(books_root, book_id) else {
            continue;
        };
        let title = entry
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .or_else(|| book.get("title").and_then(Value::as_str))
            .unwrap_or(book_id)
            .to_string();
        let author = entry
            .get("author")
            .and_then(Value::as_str)
            .filter(|author| !author.is_empty())
            .or_else(|| {
                book.get("author")
                    .and_then(Value::as_str)
                    .filter(|author| !author.is_empty())
            })
            .map(str::to_string);
        let opened_at = entry
            .get("openedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut item = json!({
            "bookId": book_id,
            "title": title,
            "openedAt": opened_at,
        });
        if let Some(author) = author {
            item["author"] = json!(author);
        }
        books.push(item);
    }
    books.truncate(RECENT_MAX_BOOKS);
    Ok(books)
}

/// 记录一次打开：校验书存在，移到最前并刷新 openedAt，原子写 recent.json。
fn record_recent_into(
    books_root: &Path,
    recent_path: &Path,
    book_id: &str,
) -> Result<Vec<Value>, ApiError> {
    let Some(book) = load_valid_book(books_root, book_id) else {
        return Err(ApiError::new(
            "NOT_FOUND",
            format!("书籍不存在或不是当前数据格式：{book_id}"),
        ));
    };
    let _guard = write_guard()?;
    let mut books = read_recent_into(books_root, recent_path)?;
    books.retain(|entry| entry.get("bookId").and_then(Value::as_str) != Some(book_id));
    let title = book
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .unwrap_or(book_id);
    let mut item = json!({
        "bookId": book_id,
        "title": title,
        "openedAt": now_rfc3339(),
    });
    if let Some(author) = book
        .get("author")
        .and_then(Value::as_str)
        .filter(|author| !author.is_empty())
    {
        item["author"] = json!(author);
    }
    books.insert(0, item);
    books.truncate(RECENT_MAX_BOOKS);
    write_json(
        recent_path,
        &json!({ "schemaVersion": RECENT_SCHEMA_VERSION, "books": books }),
    )?;
    Ok(books)
}

#[tauri::command]
pub async fn library_get_recent_books(app: AppHandle) -> Result<Value, ApiError> {
    debug_log("get_recent_books");
    run(move || {
        let books_root = books_dir(&app)?;
        let recent_path = data_dir(&app)?.join("recent.json");
        Ok(Value::Array(read_recent_into(&books_root, &recent_path)?))
    })
    .await
}

#[tauri::command]
pub async fn library_record_recent_book(
    app: AppHandle,
    book_id: String,
) -> Result<Value, ApiError> {
    debug_log("record_recent_book");
    run(move || {
        let books_root = books_dir(&app)?;
        let recent_path = data_dir(&app)?.join("recent.json");
        record_recent_into(&books_root, &recent_path, &book_id)?;
        Ok(json!({ "ok": true }))
    })
    .await
}
