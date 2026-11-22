//! 导入导出后端：原文件入库、加密解析包（`.jusong`）导入/导出、导出统计与进度事件。
//!
//! 导出/导入整包契约：
//! - `library_import_original(path)`：EPUB / MOBI / PDF / TXT 作为「原始文件书」入库，
//!   只建最小书籍目录（book.json + 空 toc.json），`parseState = "pending"`、`chapterIds = []`；
//!   按 sha256 去重，原文件保存在 `source/<原文件名>`。
//! - `library_import_package(path)`：**只接受 `.jusong`**（旧 `.zip` 拒绝）。容器内部是 ZIP，
//!   整个 ZIP 用程序内置固定密钥 AES-256-GCM 加密（仅混淆，不是强保密）。解密到内存后用
//!   `ZipArchive` 校验；防 zip slip / 绝对路径 / 符号链接，解压后限制 512 MB；
//!   校验顶层 book.json（schemaVersion 2）与合法 bookId。
//! - `library_book_transfer_info(bookId)`：导出页统计（原文件/解析包大小、章节/档案/摘要数）。
//! - `library_export_book(bookId, mode, destination)`：original / package / all。
//!   `package` 先把书籍目录（含 `source/`，不含用户库 index.json / manifest.json）打成临时 ZIP，
//!   再整体加密写成 `.jusong`，临时 ZIP 必须删除。
//! - 进度事件 `library-transfer-progress`：
//!   `{ requestId, direction: "import"|"export", phase, current, total, message }`，
//!   phase 含 `validate` / `copy` / `zip` / `unzip` / `encrypt` / `decrypt`。
//!
//! `.jusong` 容器格式（字节顺序固定）：`magic "JUSONG1\0"`(8B) + `version` u8(1B)
//! + `nonce`(12B) + AES-256-GCM 密文（含 16B tag）。密钥 = SHA-256(源码内置常量)；
//!
//! 不打印、不写日志、不返回前端。
//!
//! 所有写路径持 `library::write_guard()` 串行锁；先写临时目录再 rename 提交，
//! 失败时清理临时目录，避免留下半成品书籍。

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use aes_gcm::aead::{AeadCore, AeadInPlace, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::library::{
    data_dir, debug_log, materialize_picked_source, now_millis, read_json_opt, run, valid_book_id,
    write_guard, write_json, ApiError,
};
use crate::util::{now_rfc3339, valid_chapter_id, BOOK_SCHEMA_VERSION as SCHEMA_VERSION};

/// 原文件与解析包大小上限（契约：512 MB，同时用于解压后总大小）。
const MAX_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;
/// 解析包条目数量上限（防目录炸弹）。
const MAX_PACKAGE_ENTRIES: usize = 200_000;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
/// 超过该大小的文件在 zip 里直接 store（原文件多为已压缩格式，省 CPU/时间）。
const ZIP_DEFLATE_MAX_BYTES: u64 = 16 * 1024 * 1024;
const PROGRESS_MIN_INTERVAL_MS: u64 = 200;
const PROGRESS_EVENT: &str = "library-transfer-progress";
const ALLOWED_FORMATS: [&str; 4] = ["epub", "mobi", "pdf", "txt"];

// --- `.jusong` 私有容器 -----------------------------------------------------

/// 容器 magic：`JUSONG1\0`（8 字节）。
const PACKAGE_MAGIC: &[u8; 8] = b"JUSONG1\0";
/// 容器版本；格式变更时递增（旧版本导入会明确报「版本不支持」）。
const PACKAGE_VERSION: u8 = 1;
const PACKAGE_NONCE_BYTES: usize = 12;
const PACKAGE_TAG_BYTES: usize = 16;
const PACKAGE_HEADER_BYTES: usize = PACKAGE_MAGIC.len() + 1 + PACKAGE_NONCE_BYTES;
/// 容器相对 ZIP 明文的固定额外开销（头 + GCM tag）。
const PACKAGE_OVERHEAD_BYTES: u64 = (PACKAGE_HEADER_BYTES + PACKAGE_TAG_BYTES) as u64;
/// 固定内置密钥种子：仅用于让标准解压工具无法直接打开解析包（混淆，不是强保密）。
/// 由 SHA-256 派生 32 字节密钥；**不得**打印、写日志或返回前端。
const PACKAGE_KEY_SEED: &[u8] = b"jusong.jusong-container.fixed-key.v1.2026";
/// 解析包扩展名（私有容器，内部仍是 ZIP）。
const PACKAGE_EXTENSION: &str = "jusong";

/// 导出临时 ZIP 序号，避免同毫秒并发导出撞名。
static TEMP_PACKAGE_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// `.jusong` 加解密
// ---------------------------------------------------------------------------

/// 由内置常量派生 32 字节 AES-256 密钥（固定密钥：不同版本/环境复用）。
fn package_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(PACKAGE_KEY_SEED);
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

fn package_cipher() -> Result<Aes256Gcm, ApiError> {
    let key = package_key();
    Aes256Gcm::new_from_slice(&key).map_err(|_| ApiError::io("解析包加解密初始化失败"))
}

/// 加密 ZIP 明文并写入 `.jusong` 容器（原地加密，避免再复制一份大缓冲）。
/// 返回写入的容器字节数。
fn encrypt_package_into_writer(
    mut plaintext: Vec<u8>,
    writer: &mut dyn Write,
) -> Result<u64, ApiError> {
    let cipher = package_cipher()?;
    let nonce = Aes256Gcm::generate_nonce(OsRng);
    writer
        .write_all(PACKAGE_MAGIC)
        .and_then(|()| writer.write_all(&[PACKAGE_VERSION]))
        .and_then(|()| writer.write_all(nonce.as_slice()))
        .and_then(|()| {
            cipher
                .encrypt_in_place(&nonce, b"", &mut plaintext)
                .map_err(|_| std::io::Error::other("AES-GCM 加密失败"))
        })
        .and_then(|()| writer.write_all(&plaintext))
        .map_err(|error| ApiError::io(format!("写入解析包失败：{error}")))?;
    Ok((PACKAGE_HEADER_BYTES + plaintext.len()) as u64)
}

/// 校验容器头并原地解密，返回 ZIP 明文字节（供 `ZipArchive` 读取）。
fn decrypt_package_bytes(mut container: Vec<u8>) -> Result<Vec<u8>, ApiError> {
    if container.len() < PACKAGE_HEADER_BYTES + PACKAGE_TAG_BYTES {
        return Err(ApiError::invalid(
            "不是有效的 .jusong 解析包（文件过短或已损坏）",
        ));
    }
    if &container[..PACKAGE_MAGIC.len()] != PACKAGE_MAGIC {
        return Err(ApiError::invalid(
            "不是有效的 .jusong 解析包（magic 不匹配）",
        ));
    }
    let version = container[PACKAGE_MAGIC.len()];
    if version != PACKAGE_VERSION {
        return Err(ApiError::invalid(format!(
            "解析包版本不支持：{version}（当前支持 {PACKAGE_VERSION}）"
        )));
    }
    let mut nonce_bytes = [0u8; PACKAGE_NONCE_BYTES];
    nonce_bytes.copy_from_slice(&container[PACKAGE_MAGIC.len() + 1..PACKAGE_HEADER_BYTES]);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = package_cipher()?;
    // 原地去掉容器头（drain 不额外分配大缓冲），再原地解密。
    container.drain(..PACKAGE_HEADER_BYTES);
    cipher
        .decrypt_in_place(nonce, b"", &mut container)
        .map_err(|_| ApiError::invalid("解析包解密失败（文件损坏，或不是本程序导出的解析包）"))?;
    if container.is_empty() {
        return Err(ApiError::invalid("解析包解密后内容为空"));
    }
    Ok(container)
}

/// 给导出目标补上 `.jusong` 扩展名（覆盖用户误写的其他扩展名）。
fn with_package_extension(path: &Path) -> PathBuf {
    path.with_extension(PACKAGE_EXTENSION)
}

/// 导出临时 ZIP 路径：放在导出目标同目录（`.jusong-tmp-*`），导出结束必须删除。
fn temporary_package_zip_path(destination: &Path) -> PathBuf {
    let sequence = TEMP_PACKAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("package");
    destination.with_file_name(format!(
        ".jusong-tmp-{name}-{}-{sequence}.zip",
        std::process::id()
    ))
}

// ---------------------------------------------------------------------------
// 进度事件
// ---------------------------------------------------------------------------

/// 发送一次进度事件；事件只是 UI 提示，发送失败不影响导入/导出结果。
fn emit_transfer_progress(
    app: &AppHandle,
    request_id: &str,
    direction: &str,
    phase: &str,
    current: u64,
    total: u64,
    message: &str,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        json!({
            "requestId": request_id,
            "direction": direction,
            "phase": phase,
            "current": current,
            "total": total,
            "message": message,
        }),
    );
}

/// 前端未传 requestId 时后端生成一个，保证事件 payload 字段完整。
fn resolve_request_id(request_id: Option<String>) -> String {
    request_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && id.chars().count() <= 128)
        .unwrap_or_else(|| format!("transfer-{}", now_millis()))
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

fn format_from_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    ALLOWED_FORMATS
        .into_iter()
        .find(|format| *format == extension.as_str())
}

fn format_from_book(book: &Value) -> &'static str {
    book.get("format")
        .and_then(Value::as_str)
        .and_then(|format| {
            ALLOWED_FORMATS
                .into_iter()
                .find(|allowed| *allowed == format)
        })
        .unwrap_or("bin")
}

/// 文件名 → bookId slug（仅 ASCII；中文等非 ASCII 字符回退为 "book"）。
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
    slug.trim_matches('-').to_string()
}

/// 原文件名入库前清洗：去掉路径分隔符/控制字符，空名回退 `source.<format>`。
fn sanitize_source_name(path: &Path, format: &str) -> String {
    let raw = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let cleaned: String = raw
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
        format!("source.{format}")
    } else {
        trimmed
    }
}

/// 导出文件名（不含扩展名）：替换跨平台非法字符，限 100 字符。
fn sanitize_export_stem(title: &str, fallback: &str) -> String {
    let cleaned: String = title
        .trim()
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
    let limited: String = trimmed.chars().take(100).collect();
    if limited.trim().is_empty() {
        fallback.to_string()
    } else {
        limited
    }
}

/// `source/` 内的普通文件名白名单（拒绝路径分隔符与 `..`）。
fn valid_source_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.contains(':')
}

fn hash_file(path: &Path) -> Result<String, ApiError> {
    let mut file = File::open(path)
        .map_err(|error| ApiError::io(format!("读取文件失败（{}）：{error}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            ApiError::io(format!("读取文件失败（{}）：{error}", path.display()))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 流式复制文件并同时计算 sha256；按时间节流发复制进度。返回 `(sha256, 字节数)`。
fn copy_file_with_progress(
    source: &Path,
    destination: &Path,
    phase: &str,
    message: &str,
    progress: &mut dyn FnMut(&str, u64, u64, &str),
) -> Result<(String, u64), ApiError> {
    let total = fs::metadata(source)
        .map_err(|error| {
            ApiError::io(format!("读取文件信息失败（{}）：{error}", source.display()))
        })?
        .len();
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            ApiError::io(format!("创建目录失败（{}）：{error}", parent.display()))
        })?;
    }
    let mut reader = File::open(source)
        .map_err(|error| ApiError::io(format!("读取文件失败（{}）：{error}", source.display())))?;
    let mut writer = File::create(destination).map_err(|error| {
        ApiError::io(format!(
            "创建文件失败（{}）：{error}",
            destination.display()
        ))
    })?;
    let mut hasher = Sha256::new();
    let mut copied = 0u64;
    let mut last_emit = Instant::now();
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            ApiError::io(format!("读取文件失败（{}）：{error}", source.display()))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        writer.write_all(&buffer[..read]).map_err(|error| {
            ApiError::io(format!(
                "写入文件失败（{}）：{error}",
                destination.display()
            ))
        })?;
        copied += read as u64;
        if last_emit.elapsed() >= Duration::from_millis(PROGRESS_MIN_INTERVAL_MS) {
            progress(phase, copied, total, message);
            last_emit = Instant::now();
        }
    }
    writer.flush().map_err(|error| {
        ApiError::io(format!(
            "写入文件失败（{}）：{error}",
            destination.display()
        ))
    })?;
    progress(phase, copied, total.max(copied), message);
    Ok((format!("{:x}", hasher.finalize()), copied))
}

/// 递归搬运临时目录内容（整目录 rename 失败时的回退）。
fn move_directory_contents(source: &Path, target: &Path) -> Result<(), ApiError> {
    // 回退路径下 target 尚未创建（整目录 rename 失败后才逐项搬运）；
    // 先建目录，否则嵌套 source/ 目录里的文件 rename 会报“找不到路径”。
    fs::create_dir_all(target).map_err(|error| {
        ApiError::io(format!("创建目标目录失败（{}）：{error}", target.display()))
    })?;
    let entries = fs::read_dir(source)
        .map_err(|error| ApiError::io(format!("读取目录失败（{}）：{error}", source.display())))?;
    for entry in entries {
        let entry = entry.map_err(|error| ApiError::io(format!("读取目录项失败：{error}")))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            ApiError::io(format!("读取文件类型失败（{}）：{error}", from.display()))
        })?;
        if file_type.is_dir() {
            move_directory_contents(&from, &to)?;
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

/// 原子提交临时书籍目录：优先整目录 rename，失败回退逐项移动。
fn commit_directory(temporary: &Path, final_dir: &Path) -> Result<(), ApiError> {
    if final_dir.exists() {
        return Err(ApiError::new(
            "EXISTS",
            format!("书籍目录已存在：{}", final_dir.display()),
        ));
    }
    if let Err(rename_error) = fs::rename(temporary, final_dir) {
        fs::create_dir_all(final_dir).map_err(|error| {
            ApiError::io(format!(
                "创建书籍目录失败（{}）：{error}",
                final_dir.display()
            ))
        })?;
        let fallback = move_directory_contents(temporary, final_dir).and_then(|()| {
            fs::remove_dir_all(temporary).map_err(|error| {
                ApiError::io(format!(
                    "清理导入临时目录失败（{}）：{error}",
                    temporary.display()
                ))
            })
        });
        if let Err(fallback_error) = fallback {
            let _ = fs::remove_dir_all(final_dir);
            return Err(ApiError::io(format!(
                "提交书籍目录失败（{}）：{rename_error}；逐项移动回退也失败：{}",
                final_dir.display(),
                fallback_error.message
            )));
        }
        debug_log("transfer rename fallback used");
    }
    Ok(())
}

/// 书籍目录下所有普通文件（跳过符号链接与 `*.tmp` 临时文件），按路径排序保证稳定。
fn collect_book_files(root: &Path) -> Result<Vec<(PathBuf, u64)>, ApiError> {
    fn visit(directory: &Path, files: &mut Vec<(PathBuf, u64)>) -> Result<(), ApiError> {
        let mut entries: Vec<fs::DirEntry> = fs::read_dir(directory)
            .map_err(|error| {
                ApiError::io(format!("读取目录失败（{}）：{error}", directory.display()))
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ApiError::io(format!("读取目录项失败：{error}")))?;
        entries.sort_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                ApiError::io(format!("读取文件类型失败（{}）：{error}", path.display()))
            })?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                visit(&path, files)?;
            } else if file_type.is_file() {
                let name = entry.file_name();
                if name.to_string_lossy().ends_with(".tmp") {
                    continue;
                }
                let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                files.push((path, size));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, &mut files)?;
    Ok(files)
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

// ---------------------------------------------------------------------------
// 书库索引 / 原文件定位
// ---------------------------------------------------------------------------

/// 向 `books/index.json` 追加/替换一条书籍摘要（只保留 schemaVersion 2 的库结构）。
fn append_index_entry(books_root: &Path, meta: &Value) -> Result<(), ApiError> {
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

fn source_sha_of(book: &Value) -> Option<&str> {
    book.get("sourceSha256")
        .and_then(Value::as_str)
        .filter(|sha| !sha.is_empty())
        .or_else(|| {
            book.get("source")
                .and_then(|source| source.get("sha256"))
                .and_then(Value::as_str)
                .filter(|sha| !sha.is_empty())
        })
}

/// 按 sourceSha256 在用户库里找已有书；命中返回 book.json 副本并标记 `deduped = true`。
fn find_book_by_source_sha(books_root: &Path, sha256: &str) -> Result<Option<Value>, ApiError> {
    let Some(index) = read_json_opt(&books_root.join("index.json"))? else {
        return Ok(None);
    };
    let entries = index
        .get("books")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for entry in entries {
        let Some(book_id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !valid_book_id(book_id) {
            continue;
        }
        let Some(mut book) = read_json_opt(&books_root.join(book_id).join("book.json"))? else {
            continue;
        };
        if book.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            continue;
        }
        if source_sha_of(&book) == Some(sha256) {
            book["deduped"] = json!(true);
            return Ok(Some(book));
        }
    }
    Ok(None)
}

/// 找到书籍的原文件：优先 book.json 记录的 sourceName，其次 `source/` 下唯一普通文件。
fn source_file_for(directory: &Path, book: &Value) -> Option<PathBuf> {
    let source_dir = directory.join("source");
    let mut candidates: Vec<String> = Vec::new();
    for value in [
        book.get("sourceName"),
        book.get("source").and_then(|source| source.get("fileName")),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(name) = value.as_str().filter(|name| valid_source_file_name(name)) {
            if !candidates.iter().any(|existing| existing == name) {
                candidates.push(name.to_string());
            }
        }
    }
    for name in candidates {
        let path = source_dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut files: Vec<PathBuf> = fs::read_dir(&source_dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_file())
                .unwrap_or(false)
        })
        .map(|entry| entry.path())
        .collect();
    files.sort();
    files.into_iter().next()
}

fn unique_book_id(books_root: &Path, slug: &str, hash8: &str) -> String {
    let base = if slug.is_empty() {
        format!("book-{hash8}")
    } else {
        format!("{slug}-{hash8}")
    };
    let base = if valid_book_id(&base) {
        base
    } else {
        format!("book-{hash8}")
    };
    let mut candidate = base.clone();
    for suffix in 2..1000 {
        if !books_root.join(&candidate).exists() {
            return candidate;
        }
        candidate = format!("{base}-{suffix}");
    }
    format!("{base}-{}", now_millis())
}

// ---------------------------------------------------------------------------
// zip 解析包：解压（防 zip slip / 绝对路径 / 符号链接 / 大小上限）
// ---------------------------------------------------------------------------

/// 把 zip 条目名规整为安全的相对路径分段；空段与 `.` 忽略，`..`/绝对路径/盘符/`:` 拒绝。
fn sanitize_zip_entry_name(name: &str) -> Result<Vec<String>, ApiError> {
    if name.is_empty() {
        return Err(ApiError::invalid("解析包含空路径条目"));
    }
    if name.contains('\0') {
        return Err(ApiError::invalid("解析包含非法路径（NUL）"));
    }
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(ApiError::invalid(format!("解析包含绝对路径：{name}")));
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return Err(ApiError::invalid(format!("解析包含盘符路径：{name}")));
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(ApiError::invalid(format!("解析包含目录逃逸路径：{name}"))),
            _ => {
                if part.contains(':') {
                    return Err(ApiError::invalid(format!("解析包含非法路径：{name}")));
                }
                parts.push(part.to_string());
            }
        }
    }
    Ok(parts)
}

fn zip_mode_is_symlink(mode: u32) -> bool {
    mode & 0o170000 == 0o120000
}

fn zip_mode_is_special(mode: u32) -> bool {
    let kind = mode & 0o170000;
    kind != 0 && kind != 0o040000 && kind != 0o100000
}

struct ZipEntryPlan {
    index: usize,
    relative: PathBuf,
    is_dir: bool,
}

/// 解压解析包到 `target`（调用方负责清理）。校验失败时不写入任何文件。
fn extract_package_zip<R: Read + Seek>(
    reader: R,
    target: &Path,
    progress: &mut dyn FnMut(&str, u64, u64, &str),
) -> Result<(), ApiError> {
    let mut archive = ZipArchive::new(reader)
        .map_err(|error| ApiError::invalid(format!("解析包内容不是有效的 zip：{error}")))?;
    if archive.len() > MAX_PACKAGE_ENTRIES {
        return Err(ApiError::invalid("解析包条目过多，拒绝导入"));
    }

    // 第一遍：校验路径/类型/重复，并统计解压后大小。
    let mut plans: Vec<ZipEntryPlan> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut declared_total: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| ApiError::invalid(format!("读取解析包条目失败：{error}")))?;
        if let Some(mode) = entry.unix_mode() {
            if zip_mode_is_symlink(mode) {
                return Err(ApiError::invalid(format!(
                    "解析包含符号链接（{}），拒绝导入",
                    entry.name()
                )));
            }
            if zip_mode_is_special(mode) {
                return Err(ApiError::invalid(format!(
                    "解析包含不支持的条目类型（{}），拒绝导入",
                    entry.name()
                )));
            }
        }
        let is_dir = entry.is_dir();
        let parts = sanitize_zip_entry_name(entry.name())?;
        if parts.is_empty() {
            if is_dir {
                continue;
            }
            return Err(ApiError::invalid("解析包含空路径条目"));
        }
        let relative: PathBuf = parts.iter().collect();
        // Windows 文件系统大小写不敏感：重复路径按小写判重，避免后写覆盖先写。
        if !seen.insert(relative.to_string_lossy().to_lowercase()) {
            return Err(ApiError::invalid(format!(
                "解析包含重复路径：{}",
                relative.display()
            )));
        }
        declared_total = declared_total.saturating_add(entry.size());
        if declared_total > MAX_TRANSFER_BYTES {
            return Err(ApiError::invalid("解析包解压后超过 512 MB 上限"));
        }
        plans.push(ZipEntryPlan {
            index,
            relative,
            is_dir,
        });
    }
    if !plans
        .iter()
        .any(|plan| !plan.is_dir && plan.relative == Path::new("book.json"))
    {
        return Err(ApiError::invalid(
            "解析包顶层缺少 book.json（不是有效的解析包）",
        ));
    }

    // 第二遍：实际解压。按实际写入字节再兜一次大小上限。
    fs::create_dir_all(target).map_err(|error| {
        ApiError::io(format!(
            "创建解压临时目录失败（{}）：{error}",
            target.display()
        ))
    })?;
    let total = declared_total;
    let mut written: u64 = 0;
    let mut last_emit = Instant::now();
    for plan in plans {
        let mut entry = archive
            .by_index(plan.index)
            .map_err(|error| ApiError::invalid(format!("读取解析包条目失败：{error}")))?;
        let out_path = target.join(&plan.relative);
        if plan.is_dir {
            fs::create_dir_all(&out_path).map_err(|error| {
                ApiError::io(format!("创建目录失败（{}）：{error}", out_path.display()))
            })?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                ApiError::io(format!("创建目录失败（{}）：{error}", parent.display()))
            })?;
        }
        let mut out = File::create(&out_path).map_err(|error| {
            ApiError::io(format!("创建文件失败（{}）：{error}", out_path.display()))
        })?;
        let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|error| ApiError::invalid(format!("解压解析包失败：{error}")))?;
            if read == 0 {
                break;
            }
            written = written.saturating_add(read as u64);
            if written > MAX_TRANSFER_BYTES {
                return Err(ApiError::invalid("解析包解压后超过 512 MB 上限"));
            }
            out.write_all(&buffer[..read]).map_err(|error| {
                ApiError::io(format!("写入文件失败（{}）：{error}", out_path.display()))
            })?;
            if last_emit.elapsed() >= Duration::from_millis(PROGRESS_MIN_INTERVAL_MS) {
                progress("unzip", written, total.max(written), "正在解压解析包");
                last_emit = Instant::now();
            }
        }
    }
    progress("unzip", written, total.max(written), "解析包解压完成");
    Ok(())
}

fn validate_book_chapters(book: &Value) -> Result<(), ApiError> {
    let Some(chapter_ids) = book.get("chapterIds") else {
        return Ok(());
    };
    let Some(chapter_ids) = chapter_ids.as_array() else {
        return Err(ApiError::invalid("book.json 的 chapterIds 不是数组"));
    };
    for chapter_id in chapter_ids {
        let Some(chapter_id) = chapter_id.as_str() else {
            return Err(ApiError::invalid("book.json 的 chapterIds 含非字符串项"));
        };
        if !valid_chapter_id(chapter_id) {
            return Err(ApiError::invalid(format!(
                "book.json 含非法 chapterId：{chapter_id}"
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 导入：原文件书 / 解析包
// ---------------------------------------------------------------------------

/// 原文件导入实现（不依赖 Tauri runtime，便于单元测试）。
fn import_original_into(
    books_root: &Path,
    source_path: &Path,
    progress: &mut dyn FnMut(&str, u64, u64, &str),
) -> Result<Value, ApiError> {
    let format = format_from_path(source_path)
        .ok_or_else(|| ApiError::invalid("仅支持导入 EPUB / MOBI / PDF / TXT 格式的电子书"))?;
    let metadata = fs::metadata(source_path).map_err(|error| {
        ApiError::io(format!(
            "无法读取文件信息（{}）：{error}",
            source_path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(ApiError::invalid("请选择一个文件（不是目录）"));
    }
    let total = metadata.len();
    if total > MAX_TRANSFER_BYTES {
        return Err(ApiError::invalid("文件过大：单个文件上限 512 MB"));
    }

    let _guard = write_guard()?;
    fs::create_dir_all(books_root)
        .map_err(|error| ApiError::io(format!("创建书籍根目录失败：{error}")))?;
    let temporary = books_root.join(format!(".import-original-{}", now_millis()));
    let result = (|| -> Result<Value, ApiError> {
        progress("validate", 0, total, "正在校验文件");
        let source_dir = temporary.join("source");
        fs::create_dir_all(&source_dir).map_err(|error| {
            ApiError::io(format!(
                "创建导入临时目录失败（{}）：{error}",
                source_dir.display()
            ))
        })?;
        let file_name = sanitize_source_name(source_path, format);
        let destination = source_dir.join(&file_name);
        let (sha256, size) = copy_file_with_progress(
            source_path,
            &destination,
            "copy",
            "正在复制原文件",
            progress,
        )?;

        if let Some(existing) = find_book_by_source_sha(books_root, &sha256)? {
            return Ok(existing);
        }

        let title = source_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(&file_name)
            .to_string();
        let slug = sanitize_slug(&title);
        let hash8 = &sha256[..8.min(sha256.len())];
        let book_id = unique_book_id(books_root, &slug, hash8);
        let book = json!({
            "id": book_id,
            "title": title,
            "format": format,
            "schemaVersion": SCHEMA_VERSION,
            "parseState": "pending",
            "importedAt": now_rfc3339(),
            "volumeCount": 0,
            "chapterCount": 0,
            "chapterIds": [],
            "chapterAssets": {},
            "sourceName": file_name,
            "sourceSize": size,
            "sourceSha256": sha256,
            "source": { "fileName": file_name.clone(), "size": size, "sha256": sha256.clone() },
        });
        write_json(&temporary.join("book.json"), &book)?;
        write_json(&temporary.join("toc.json"), &json!([]))?;

        let final_dir = books_root.join(&book_id);
        commit_directory(&temporary, &final_dir)?;
        if let Err(error) = append_index_entry(books_root, &book) {
            let _ = fs::remove_dir_all(&final_dir);
            return Err(error);
        }
        progress("validate", total, total, "原文件导入完成");
        Ok(book)
    })();
    if temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

/// 解析包导入实现（不依赖 Tauri runtime，便于单元测试）。
fn import_package_into(
    books_root: &Path,
    package_path: &Path,
    progress: &mut dyn FnMut(&str, u64, u64, &str),
) -> Result<Value, ApiError> {
    let extension_ok = package_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(PACKAGE_EXTENSION));
    if !extension_ok {
        return Err(ApiError::invalid(
            "请选择 .jusong 格式的加密解析包（旧版 .zip 解析包不再支持）",
        ));
    }
    let metadata = fs::metadata(package_path).map_err(|error| {
        ApiError::io(format!(
            "无法读取文件信息（{}）：{error}",
            package_path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(ApiError::invalid("请选择一个解析包文件（不是目录）"));
    }
    let container_len = metadata.len();
    if container_len > MAX_TRANSFER_BYTES.saturating_add(PACKAGE_OVERHEAD_BYTES) {
        return Err(ApiError::invalid("解析包过大：上限 512 MB"));
    }

    let _guard = write_guard()?;
    fs::create_dir_all(books_root)
        .map_err(|error| ApiError::io(format!("创建书籍根目录失败：{error}")))?;
    let temporary = books_root.join(format!(".import-package-{}", now_millis()));
    let result = (|| -> Result<Value, ApiError> {
        progress("validate", 0, container_len, "正在校验解析包");
        let container = fs::read(package_path).map_err(|error| {
            ApiError::io(format!(
                "读取解析包失败（{}）：{error}",
                package_path.display()
            ))
        })?;
        if container.len() as u64 > MAX_TRANSFER_BYTES.saturating_add(PACKAGE_OVERHEAD_BYTES) {
            return Err(ApiError::invalid("解析包过大：上限 512 MB"));
        }
        progress("decrypt", 0, container_len, "正在解密解析包");
        let zip_bytes = decrypt_package_bytes(container)?;
        if zip_bytes.len() as u64 > MAX_TRANSFER_BYTES {
            return Err(ApiError::invalid("解析包解密后超过 512 MB 上限"));
        }
        progress("decrypt", container_len, container_len, "解析包解密完成");
        extract_package_zip(Cursor::new(zip_bytes), &temporary, progress)?;

        let Some(book) = read_json_opt(&temporary.join("book.json"))? else {
            return Err(ApiError::invalid(
                "解析包顶层缺少 book.json（不是有效的解析包）",
            ));
        };
        if !book.is_object() {
            return Err(ApiError::invalid("解析包的 book.json 不是 JSON 对象"));
        }
        if book.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
            return Err(ApiError::invalid(
                "解析包版本不支持（需要 schemaVersion 2 的书籍）",
            ));
        }
        let book_id = book.get("id").and_then(Value::as_str).unwrap_or("");
        if !valid_book_id(book_id) {
            return Err(ApiError::invalid(format!("解析包 bookId 非法：{book_id}")));
        }
        validate_book_chapters(&book)?;
        progress("validate", container_len, container_len, "正在校验书籍内容");

        // 去重 1：同 bookId 已有书（解析包重复导入 / 同库重复）。
        let existing_dir = books_root.join(book_id);
        if existing_dir.exists() {
            if let Some(mut existing) = read_json_opt(&existing_dir.join("book.json"))? {
                if existing.get("schemaVersion").and_then(Value::as_u64) == Some(SCHEMA_VERSION) {
                    existing["deduped"] = json!(true);
                    return Ok(existing);
                }
            }
            return Err(ApiError::new(
                "EXISTS",
                format!("书籍目录已存在：{book_id}"),
            ));
        }

        // 去重 2：sourceSha256 相同（解析包被改过 bookId 时仍能识别）。
        let source_sha = source_sha_of(&book)
            .map(str::to_string)
            .or_else(|| source_file_for(&temporary, &book).and_then(|path| hash_file(&path).ok()));
        if let Some(sha256) = source_sha {
            if let Some(existing) = find_book_by_source_sha(books_root, &sha256)? {
                return Ok(existing);
            }
        }

        let final_dir = books_root.join(book_id);
        commit_directory(&temporary, &final_dir)?;
        if let Err(error) = append_index_entry(books_root, &book) {
            let _ = fs::remove_dir_all(&final_dir);
            return Err(error);
        }
        progress("validate", container_len, container_len, "解析包导入完成");
        Ok(book)
    })();
    if temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}

// ---------------------------------------------------------------------------
// 导出统计与导出
// ---------------------------------------------------------------------------

fn count_digests(directory: &Path) -> usize {
    let Ok(entries) = fs::read_dir(directory.join("chapters")) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false)
                && entry.path().join("digest.json").is_file()
        })
        .count()
}

fn count_archives(directory: &Path) -> usize {
    read_json_opt(&directory.join("shared/archives.json"))
        .ok()
        .flatten()
        .and_then(|archive| {
            archive
                .get("entries")
                .and_then(Value::as_array)
                .map(Vec::len)
        })
        .unwrap_or(0)
}

fn parse_state_of(book: &Value) -> &'static str {
    match book.get("parseState").and_then(Value::as_str) {
        Some("pending") => "pending",
        Some("parsed") => "parsed",
        _ => {
            let has_chapters = book
                .get("chapterIds")
                .and_then(Value::as_array)
                .is_some_and(|ids| !ids.is_empty());
            if has_chapters {
                "parsed"
            } else {
                "pending"
            }
        }
    }
}

fn chapter_count_of(book: &Value) -> usize {
    if let Some(ids) = book.get("chapterIds").and_then(Value::as_array) {
        return ids.len();
    }
    book.get("chapterCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize
}

/// 导出页统计实现（不依赖 Tauri runtime，便于单元测试）。
fn transfer_info_into(books_root: &Path, book_id: &str) -> Result<Value, ApiError> {
    if !valid_book_id(book_id) {
        return Err(ApiError::invalid(format!("非法 bookId：{book_id}")));
    }
    let directory = books_root.join(book_id);
    let Some(book) = read_json_opt(&directory.join("book.json"))? else {
        return Err(ApiError::new("NOT_FOUND", format!("书籍不存在：{book_id}")));
    };
    if book.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
        return Err(ApiError::new(
            "NOT_FOUND",
            format!("书籍不是当前数据格式：{book_id}"),
        ));
    }

    let source_file = source_file_for(&directory, &book);
    let source_size = source_file
        .as_ref()
        .and_then(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .or_else(|| book.get("sourceSize").and_then(Value::as_u64))
        .or_else(|| {
            book.get("source")
                .and_then(|source| source.get("size"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    // 只有确实存在原文件（或 book.json 记录了非零大小）时才展示原文件名；
    // 种子书的 sourceName 是迁移来源说明，不是可导出文件。
    let source_name = if source_file.is_some() || source_size > 0 {
        source_file
            .as_ref()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| {
                book.get("sourceName")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
            })
            .or_else(|| {
                book.get("source")
                    .and_then(|source| source.get("fileName"))
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
            })
    } else {
        None
    };
    let package_size: u64 = collect_book_files(&directory)
        .map(|files| files.iter().map(|(_, size)| *size).sum())
        .unwrap_or(0);

    let mut info = Map::new();
    info.insert("bookId".to_string(), json!(book_id));
    info.insert(
        "title".to_string(),
        json!(book
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .unwrap_or(book_id)),
    );
    if let Some(author) = book
        .get("author")
        .and_then(Value::as_str)
        .filter(|author| !author.is_empty())
    {
        info.insert("author".to_string(), json!(author));
    }
    if let Some(publisher) = book
        .get("publisher")
        .and_then(Value::as_str)
        .filter(|publisher| !publisher.is_empty())
    {
        info.insert("publisher".to_string(), json!(publisher));
    }
    info.insert(
        "format".to_string(),
        json!(book.get("format").and_then(Value::as_str).unwrap_or("bin")),
    );
    if let Some(source_name) = source_name {
        info.insert("sourceName".to_string(), json!(source_name));
    }
    info.insert("sourceSize".to_string(), json!(source_size));
    info.insert("packageSize".to_string(), json!(package_size));
    info.insert("chapterCount".to_string(), json!(chapter_count_of(&book)));
    info.insert(
        "archiveCount".to_string(),
        json!(count_archives(&directory)),
    );
    info.insert("digestCount".to_string(), json!(count_digests(&directory)));
    info.insert("parseState".to_string(), json!(parse_state_of(&book)));
    Ok(Value::Object(info))
}

fn prepare_file_destination(destination: &Path) -> Result<(), ApiError> {
    if destination.as_os_str().is_empty() {
        return Err(ApiError::invalid("导出目标路径为空"));
    }
    if destination.exists() {
        if destination.is_dir() {
            return Err(ApiError::invalid(
                "导出原文件/解析包时目标必须是文件路径（「全部导出」才使用目录）",
            ));
        }
        if !destination.is_file() {
            return Err(ApiError::invalid("导出目标不是普通文件"));
        }
    }
    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| {
                ApiError::io(format!("创建导出目录失败（{}）：{error}", parent.display()))
            })?;
        }
    }
    Ok(())
}

fn file_entry(path: &Path, bytes: u64) -> Value {
    json!({ "path": path.to_string_lossy(), "bytes": bytes })
}

/// 把书籍目录打成临时 ZIP（含 source/，不含用户库 index.json / manifest.json）。
/// 只负责明文 ZIP，加密成 `.jusong` 由 [`write_encrypted_package`] 负责。
fn write_package_zip_file(
    book_directory: &Path,
    destination: &Path,
    progress: &mut dyn FnMut(&str, u64, u64, &str),
) -> Result<u64, ApiError> {
    let files = collect_book_files(book_directory)?;
    if files.is_empty() {
        return Err(ApiError::invalid("书籍目录为空，无法导出解析包"));
    }
    let total: u64 = files.iter().map(|(_, size)| *size).sum();
    prepare_file_destination(destination)?;
    let file = File::create(destination).map_err(|error| {
        ApiError::io(format!(
            "创建解析包失败（{}）：{error}",
            destination.display()
        ))
    })?;
    let mut writer = ZipWriter::new(file);
    let mut written: u64 = 0;
    let mut last_emit = Instant::now();
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    for (path, size) in files {
        // 导出目标若恰好落在书籍目录内（如重复导出到同一位置），不要把它打进包里。
        if same_path(&path, destination) {
            continue;
        }
        let relative = path.strip_prefix(book_directory).unwrap_or(&path);
        let name = relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(part) => Some(part.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        if name.is_empty() {
            continue;
        }
        let method = if size <= ZIP_DEFLATE_MAX_BYTES {
            CompressionMethod::Deflated
        } else {
            CompressionMethod::Stored
        };
        let options = SimpleFileOptions::default()
            .compression_method(method)
            .unix_permissions(0o644);
        writer
            .start_file(name, options)
            .map_err(|error| ApiError::io(format!("写入解析包失败：{error}")))?;
        let mut reader = File::open(&path).map_err(|error| {
            ApiError::io(format!("读取文件失败（{}）：{error}", path.display()))
        })?;
        loop {
            let read = reader.read(&mut buffer).map_err(|error| {
                ApiError::io(format!("读取文件失败（{}）：{error}", path.display()))
            })?;
            if read == 0 {
                break;
            }
            writer
                .write_all(&buffer[..read])
                .map_err(|error| ApiError::io(format!("写入解析包失败：{error}")))?;
            written = written.saturating_add(read as u64);
            if last_emit.elapsed() >= Duration::from_millis(PROGRESS_MIN_INTERVAL_MS) {
                progress("zip", written, total.max(written), "正在打包解析包");
                last_emit = Instant::now();
            }
        }
    }
    writer
        .finish()
        .map_err(|error| ApiError::io(format!("写入解析包失败：{error}")))?;
    progress("zip", written, total.max(written), "解析包打包完成");
    fs::metadata(destination)
        .map(|metadata| metadata.len())
        .map_err(|error| {
            ApiError::io(format!(
                "读取解析包大小失败（{}）：{error}",
                destination.display()
            ))
        })
}

/// 把书籍目录打成 ZIP 后加密为 `.jusong` 容器写入 destination；临时 ZIP 无论成败都删除。
/// 返回写入的容器字节数。
fn write_encrypted_package(
    book_directory: &Path,
    destination: &Path,
    progress: &mut dyn FnMut(&str, u64, u64, &str),
) -> Result<u64, ApiError> {
    prepare_file_destination(destination)?;
    let temporary_zip = temporary_package_zip_path(destination);
    let result = (|| -> Result<u64, ApiError> {
        let zip_size = write_package_zip_file(book_directory, &temporary_zip, progress)?;
        if zip_size > MAX_TRANSFER_BYTES {
            return Err(ApiError::invalid("解析包超过 512 MB 上限"));
        }
        progress("encrypt", 0, zip_size, "正在加密解析包");
        let plaintext = fs::read(&temporary_zip).map_err(|error| {
            ApiError::io(format!(
                "读取临时解析包失败（{}）：{error}",
                temporary_zip.display()
            ))
        })?;
        let file = File::create(destination).map_err(|error| {
            ApiError::io(format!(
                "创建解析包失败（{}）：{error}",
                destination.display()
            ))
        })?;
        let mut writer = std::io::BufWriter::new(file);
        let bytes = encrypt_package_into_writer(plaintext, &mut writer)?;
        writer.flush().map_err(|error| {
            ApiError::io(format!(
                "写入解析包失败（{}）：{error}",
                destination.display()
            ))
        })?;
        progress("encrypt", zip_size, zip_size, "解析包加密完成");
        Ok(bytes)
    })();
    // 临时 ZIP 必须清理（成功、失败都删）；删除失败不影响导出结果。
    let _ = fs::remove_file(&temporary_zip);
    result
}

/// 导出实现（不依赖 Tauri runtime，便于单元测试）。返回 `{ files: [{path, bytes}] }`。
fn export_book_into(
    books_root: &Path,
    book_id: &str,
    mode: &str,
    destination: &Path,
    progress: &mut dyn FnMut(&str, u64, u64, &str),
) -> Result<Value, ApiError> {
    let mode = mode.trim();
    if !matches!(mode, "original" | "package" | "all") {
        return Err(ApiError::invalid(format!(
            "不支持的导出方式：{mode}（可选 original / package / all）"
        )));
    }
    if !valid_book_id(book_id) {
        return Err(ApiError::invalid(format!("非法 bookId：{book_id}")));
    }
    let directory = books_root.join(book_id);
    let Some(book) = read_json_opt(&directory.join("book.json"))? else {
        return Err(ApiError::new("NOT_FOUND", format!("书籍不存在：{book_id}")));
    };
    if book.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) {
        return Err(ApiError::new(
            "NOT_FOUND",
            format!("书籍不是当前数据格式：{book_id}"),
        ));
    }
    let title = sanitize_export_stem(
        book.get("title").and_then(Value::as_str).unwrap_or(""),
        book_id,
    );
    let mut files: Vec<Value> = Vec::new();
    match mode {
        "original" => {
            let source = source_file_for(&directory, &book).ok_or_else(|| {
                ApiError::new("NOT_FOUND", "该书没有可导出的原文件（种子书没有原文件）")
            })?;
            prepare_file_destination(destination)?;
            let (_, bytes) =
                copy_file_with_progress(&source, destination, "copy", "正在导出原文件", progress)?;
            files.push(file_entry(destination, bytes));
        }
        "package" => {
            // 目标统一补 `.jusong` 扩展名（用户手输其他扩展名也不改容器格式）。
            let target = with_package_extension(destination);
            progress("validate", 0, 0, "正在校验书籍目录");
            let bytes = write_encrypted_package(&directory, &target, progress)?;
            files.push(file_entry(&target, bytes));
        }
        _ => {
            // all：destination 视为目录，分别写原文件与加密解析包。
            if destination.exists() && !destination.is_dir() {
                return Err(ApiError::invalid(
                    "「全部导出」时目标必须是目录（会写入两个文件）",
                ));
            }
            fs::create_dir_all(destination).map_err(|error| {
                ApiError::io(format!(
                    "创建导出目录失败（{}）：{error}",
                    destination.display()
                ))
            })?;
            progress("validate", 0, 0, "正在准备导出目录");
            if let Some(source) = source_file_for(&directory, &book) {
                let extension =
                    format_from_path(&source).unwrap_or_else(|| format_from_book(&book));
                let original_target = destination.join(format!("{title}.{extension}"));
                let (_, bytes) = copy_file_with_progress(
                    &source,
                    &original_target,
                    "copy",
                    "正在导出原文件",
                    progress,
                )?;
                files.push(file_entry(&original_target, bytes));
            } else {
                progress("copy", 0, 0, "该书没有原文件，跳过原文件导出");
            }
            let package_target = destination.join(format!("{title}-解析包.{PACKAGE_EXTENSION}"));
            let bytes = write_encrypted_package(&directory, &package_target, progress)?;
            files.push(file_entry(&package_target, bytes));
        }
    }
    Ok(json!({ "files": files }))
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 导入原文件书（EPUB / MOBI / PDF / TXT）：只复制原文件并建最小书籍目录，
/// 章节留空、`parseState = "pending"`，书架可见但阅读器暂无可读章节。
#[tauri::command]
pub async fn library_import_original(
    app: AppHandle,
    path: String,
    request_id: Option<String>,
) -> Result<Value, ApiError> {
    debug_log("import_original");
    let request_id = resolve_request_id(request_id);
    let progress_app = app.clone();
    let progress_request_id = request_id.clone();
    run(move || {
        let books_root = data_dir(&progress_app)?.join("books");
        let (source, temporary) = materialize_picked_source(&progress_app, &path)?;
        let mut progress = |phase: &str, current: u64, total: u64, message: &str| {
            emit_transfer_progress(
                &progress_app,
                &progress_request_id,
                "import",
                phase,
                current,
                total,
                message,
            );
        };
        let result = import_original_into(&books_root, &source, &mut progress);
        if let Some(directory) = temporary {
            let _ = fs::remove_dir_all(directory);
        }
        result
    })
    .await
}

/// 导入加密解析包（`.jusong`）：校验容器头并解密到内存，再解压校验并入库，返回 book.json。
#[tauri::command]
pub async fn library_import_package(
    app: AppHandle,
    path: String,
    request_id: Option<String>,
) -> Result<Value, ApiError> {
    debug_log("import_package");
    let request_id = resolve_request_id(request_id);
    let progress_app = app.clone();
    let progress_request_id = request_id.clone();
    run(move || {
        let books_root = data_dir(&progress_app)?.join("books");
        let (source, temporary) = materialize_picked_source(&progress_app, &path)?;
        let mut progress = |phase: &str, current: u64, total: u64, message: &str| {
            emit_transfer_progress(
                &progress_app,
                &progress_request_id,
                "import",
                phase,
                current,
                total,
                message,
            );
        };
        let result = import_package_into(&books_root, &source, &mut progress);
        if let Some(directory) = temporary {
            let _ = fs::remove_dir_all(directory);
        }
        result
    })
    .await
}

/// 导出页统计：原文件/解析包大小、章节/档案/摘要数量、解析状态。
#[tauri::command]
pub async fn library_book_transfer_info(
    app: AppHandle,
    book_id: String,
) -> Result<Value, ApiError> {
    debug_log("book_transfer_info");
    run(move || {
        let books_root = data_dir(&app)?.join("books");
        transfer_info_into(&books_root, &book_id)
    })
    .await
}

/// 导出书籍：original（原文件）/ package（含 source/ 的加密解析包 `.jusong`）/
/// all（目录内写原文件与 `.jusong` 两个文件）。
#[tauri::command]
pub async fn library_export_book(
    app: AppHandle,
    book_id: String,
    mode: String,
    destination: String,
    request_id: Option<String>,
) -> Result<Value, ApiError> {
    debug_log("export_book");
    let request_id = resolve_request_id(request_id);
    let progress_app = app.clone();
    let progress_request_id = request_id.clone();
    run(move || {
        let books_root = data_dir(&progress_app)?.join("books");
        let mut progress = |phase: &str, current: u64, total: u64, message: &str| {
            emit_transfer_progress(
                &progress_app,
                &progress_request_id,
                "export",
                phase,
                current,
                total,
                message,
            );
        };
        export_book_into(
            &books_root,
            &book_id,
            &mode,
            Path::new(&destination),
            &mut progress,
        )
    })
    .await
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "jusong-transfer-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(root.join("books")).unwrap();
        root
    }

    fn no_progress() -> impl FnMut(&str, u64, u64, &str) {
        |_, _, _, _| {}
    }

    fn sha_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    /// 回归：整目录 rename 失败后的逐项回退必须创建嵌套目标目录（source/ 等）。
    #[test]
    fn move_directory_contents_creates_nested_target_directories() {
        let root = temp_root("move-fallback");
        let source = root.join("temporary");
        fs::create_dir_all(source.join("source")).unwrap();
        fs::write(source.join("source").join("原文件.txt"), b"content").unwrap();
        fs::write(source.join("book.json"), b"{}").unwrap();
        let target = root.join("final");
        move_directory_contents(&source, &target).unwrap();
        assert_eq!(
            fs::read(target.join("source").join("原文件.txt")).unwrap(),
            b"content"
        );
        assert!(target.join("book.json").exists());
        fs::remove_dir_all(&source).unwrap();
    }

    /// 建一本完整书：book.json / toc.json / 1 章 / 1 摘要 / 2 档案 / source 原文件。
    fn write_fixture_book(books: &Path, book_id: &str) -> PathBuf {
        let directory = books.join(book_id);
        fs::create_dir_all(directory.join("chapters/ch-a")).unwrap();
        fs::create_dir_all(directory.join("shared")).unwrap();
        fs::create_dir_all(directory.join("source")).unwrap();
        let source_bytes = b"hello-source";
        fs::write(directory.join("source").join("原文件.txt"), source_bytes).unwrap();
        let book = json!({
            "id": book_id,
            "title": "测试导出书",
            "author": "作者",
            "format": "txt",
            "schemaVersion": 2,
            "parseState": "parsed",
            "chapterIds": ["ch-a"],
            "chapterCount": 1,
            "volumeCount": 1,
            "sourceName": "原文件.txt",
            "sourceSize": source_bytes.len(),
            "sourceSha256": sha_hex(source_bytes),
            "importedAt": "2026-11-16T00:00:00.000Z",
        });
        write_json(&directory.join("book.json"), &book).unwrap();
        write_json(
            &directory.join("toc.json"),
            &json!([{ "id": "ch-a", "type": "chapter", "title": "第一章", "order": 1, "chapterId": "ch-a" }]),
        )
        .unwrap();
        write_json(
            &directory.join("chapters/ch-a/chapter.json"),
            &json!({
                "id": "ch-a",
                "bookId": book_id,
                "title": "第一章",
                "blocks": [{ "id": "p1", "kind": "paragraph", "text": "正文" }],
            }),
        )
        .unwrap();
        write_json(
            &directory.join("chapters/ch-a/digest.json"),
            &json!({ "title": "第一章", "opening": "正文" }),
        )
        .unwrap();
        write_json(
            &directory.join("shared/archives.json"),
            &json!({
                "schemaVersion": 1,
                "bookId": book_id,
                "entries": [
                    { "id": "a", "title": "甲", "body": "乙" },
                    { "id": "b", "title": "丙", "body": "丁" },
                ],
            }),
        )
        .unwrap();
        write_json(
            &books.join("index.json"),
            &json!({ "schemaVersion": 2, "books": [book] }),
        )
        .unwrap();
        directory
    }

    /// 测试用 zip 条目：(路径, 内容, unix 权限)。
    type ZipEntrySpec<'a> = (&'a str, &'a [u8], Option<u32>);

    /// 内存构建明文 ZIP 字节。
    fn build_test_zip(entries: &[ZipEntrySpec<'_>]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes, mode) in entries {
            let mut options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            if let Some(mode) = mode {
                options = options.unix_permissions(*mode);
            }
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// 构建加密 `.jusong` 解析包（内部为给定 zip 条目）。
    fn write_test_package(path: &Path, entries: &[ZipEntrySpec<'_>]) {
        let zip_bytes = build_test_zip(entries);
        let mut container = Vec::new();
        encrypt_package_into_writer(zip_bytes, &mut container).unwrap();
        fs::write(path, container).unwrap();
    }

    /// 构建旧版明文 `.zip` 解析包（用于验证导入拒绝）。
    fn write_legacy_zip(path: &Path, entries: &[ZipEntrySpec<'_>]) {
        fs::write(path, build_test_zip(entries)).unwrap();
    }

    /// 读取 `.jusong` 容器并解密为 ZIP 字节（测试断言容器内容用）。
    fn decrypt_test_package(path: &Path) -> Vec<u8> {
        decrypt_package_bytes(fs::read(path).unwrap()).unwrap()
    }

    /// 导出目标同目录是否残留临时 ZIP（`.jusong-tmp-*`）。
    fn leftover_temp_zips(directory: &Path) -> Vec<String> {
        fs::read_dir(directory)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .filter(|name| name.starts_with(".jusong-tmp-"))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn import_original_creates_pending_book_and_dedupes() {
        let root = temp_root("original");
        let books = root.join("books");
        let source = root.join("原始文件书.txt");
        fs::write(&source, b"raw-book-bytes").unwrap();

        let first =
            import_original_into(&books, &source, &mut no_progress()).expect("first import");
        let book_id = first["id"].as_str().unwrap().to_string();
        assert_eq!(first["format"], "txt");
        assert_eq!(first["parseState"], "pending");
        assert_eq!(first["chapterCount"], json!(0));
        assert_eq!(first["volumeCount"], json!(0));
        assert!(first["chapterIds"].as_array().unwrap().is_empty());
        assert_eq!(first["sourceName"], "原始文件书.txt");
        assert_eq!(first["sourceSize"], json!(14));
        assert!(first["sourceSha256"].as_str().unwrap().len() == 64);

        let directory = books.join(&book_id);
        let stored = read_json_opt(&directory.join("book.json"))
            .unwrap()
            .unwrap();
        assert_eq!(stored["parseState"], "pending");
        assert!(directory.join("source").join("原始文件书.txt").exists());
        assert_eq!(
            fs::read(directory.join("source").join("原始文件书.txt")).unwrap(),
            b"raw-book-bytes"
        );
        assert_eq!(
            read_json_opt(&directory.join("toc.json")).unwrap().unwrap(),
            json!([])
        );
        let index = read_json_opt(&books.join("index.json")).unwrap().unwrap();
        let entries = index["books"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["parseState"], "pending");
        assert_eq!(entries[0]["chapterCount"], json!(0));

        // 同一文件重复导入：返回已有书，不产生第二本。
        let second =
            import_original_into(&books, &source, &mut no_progress()).expect("dedupe import");
        assert_eq!(second["id"], json!(book_id));
        assert_eq!(second["deduped"], json!(true));
        let index = read_json_opt(&books.join("index.json")).unwrap().unwrap();
        assert_eq!(index["books"].as_array().unwrap().len(), 1);

        // 不残留临时目录。
        let leftovers: Vec<String> = fs::read_dir(&books)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".import-"))
            .collect();
        assert!(leftovers.is_empty(), "临时目录未清理：{leftovers:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_original_supports_epub_mobi_pdf_txt() {
        let root = temp_root("formats");
        let books = root.join("books");
        for (extension, format) in [
            ("epub", "epub"),
            ("mobi", "mobi"),
            ("pdf", "pdf"),
            ("txt", "txt"),
        ] {
            let source = root.join(format!("样例.{extension}"));
            fs::write(&source, format!("bytes-{extension}")).unwrap();
            let meta =
                import_original_into(&books, &source, &mut no_progress()).expect("import format");
            assert_eq!(meta["format"], format);
            assert_eq!(meta["parseState"], "pending");
        }
        let index = read_json_opt(&books.join("index.json")).unwrap().unwrap();
        assert_eq!(index["books"].as_array().unwrap().len(), 4);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_original_rejects_unsupported_format() {
        let root = temp_root("unsupported");
        let books = root.join("books");
        let source = root.join("文档.docx");
        fs::write(&source, b"docx").unwrap();
        let error = import_original_into(&books, &source, &mut no_progress()).unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
        assert!(!books.join("index.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_package_rejects_zip_slip_absolute_and_symlink() {
        let root = temp_root("zip-security");
        let books = root.join("books");
        let book = json!({
            "id": "evilbook-11111111",
            "title": "恶意包",
            "schemaVersion": 2,
            "chapterIds": [],
        });
        let book_bytes = serde_json::to_vec(&book).unwrap();
        let book_json: &[u8] = &book_bytes;

        let assert_rejected = |label: &str, package: &Path| {
            let error = import_package_into(&books, package, &mut no_progress()).unwrap_err();
            assert_eq!(error.code, "INVALID_INPUT", "{label}: {error:?}");
            assert!(!root.join("escaped.txt").exists(), "{label} 写出了包外文件");
            assert!(
                !root.join("absolute.txt").exists(),
                "{label} 写出了包外文件"
            );
            assert!(
                !books.join("evilbook-11111111").exists(),
                "{label} 建立了书籍目录"
            );
        };

        let slip_entries: Vec<ZipEntrySpec<'_>> = vec![
            ("book.json", book_json, None),
            ("../escaped.txt", b"escaped", None),
        ];
        let slip = root.join("slip.jusong");
        write_test_package(&slip, &slip_entries);
        assert_rejected("slip", &slip);

        let absolute_entries: Vec<ZipEntrySpec<'_>> = vec![
            ("book.json", book_json, None),
            ("/absolute.txt", b"absolute", None),
        ];
        let absolute = root.join("absolute.jusong");
        write_test_package(&absolute, &absolute_entries);
        assert_rejected("absolute", &absolute);

        // 符号链接：`unix_permissions` 会丢弃文件类型位，必须用 add_symlink 构造后再加密。
        let symlink = root.join("symlink.jusong");
        {
            let mut zip_writer = ZipWriter::new(Cursor::new(Vec::new()));
            zip_writer
                .start_file("book.json", SimpleFileOptions::default())
                .unwrap();
            zip_writer.write_all(book_json).unwrap();
            zip_writer
                .add_symlink("link", "/etc/passwd", SimpleFileOptions::default())
                .unwrap();
            let zip_bytes = zip_writer.finish().unwrap().into_inner();
            let mut container = Vec::new();
            encrypt_package_into_writer(zip_bytes, &mut container).unwrap();
            fs::write(&symlink, container).unwrap();
        }
        assert_rejected("symlink", &symlink);

        let leftovers: Vec<String> = fs::read_dir(&books)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".import-"))
            .collect();
        assert!(leftovers.is_empty(), "临时目录未清理：{leftovers:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_package_rejects_legacy_zip_and_invalid_metadata() {
        let root = temp_root("package-invalid");
        let books = root.join("books");
        let valid_book = json!({
            "id": "metabook-11111111",
            "title": "元数据",
            "schemaVersion": 2,
            "chapterIds": [],
        });
        let valid_book_bytes = serde_json::to_vec(&valid_book).unwrap();

        // 旧版明文 .zip 解析包：直接拒绝。
        let legacy_zip = root.join("legacy.zip");
        write_legacy_zip(
            &legacy_zip,
            &[("book.json", valid_book_bytes.as_slice(), None)],
        );
        let error = import_package_into(&books, &legacy_zip, &mut no_progress()).unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
        assert!(
            error.message.contains("jusong"),
            "旧 .zip 提示应说明新扩展名：{}",
            error.message
        );

        // 缺少顶层 book.json。
        let missing = root.join("missing-book-json.jusong");
        write_test_package(
            &missing,
            &[("chapters/ch-a/chapter.json", b"{}".as_slice(), None)],
        );
        assert_eq!(
            import_package_into(&books, &missing, &mut no_progress())
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );

        // 旧 schemaVersion。
        let old_schema = root.join("old-schema.jusong");
        write_test_package(
            &old_schema,
            &[(
                "book.json",
                br#"{"id":"oldbook-11111111","schemaVersion":1}"#.as_slice(),
                None,
            )],
        );
        assert_eq!(
            import_package_into(&books, &old_schema, &mut no_progress())
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );

        // 非法 bookId。
        let bad_id = root.join("bad-id.jusong");
        write_test_package(
            &bad_id,
            &[(
                "book.json",
                br#"{"id":"UPPER ID","schemaVersion":2}"#.as_slice(),
                None,
            )],
        );
        assert_eq!(
            import_package_into(&books, &bad_id, &mut no_progress())
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );

        // 非 .jusong 扩展名（即使内容是合法的加密容器也拒绝）。
        let renamed = root.join("renamed.txt");
        write_test_package(
            &renamed,
            &[("book.json", valid_book_bytes.as_slice(), None)],
        );
        assert_eq!(
            import_package_into(&books, &renamed, &mut no_progress())
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_package_rejects_invalid_container() {
        let root = temp_root("container-invalid");
        let books = root.join("books");

        // 错误 magic。
        let bad_magic = root.join("bad-magic.jusong");
        let mut bytes = vec![0u8; PACKAGE_HEADER_BYTES + PACKAGE_TAG_BYTES + 4];
        bytes[..8].copy_from_slice(b"NOTJUSO\0");
        bytes[8] = PACKAGE_VERSION;
        fs::write(&bad_magic, &bytes).unwrap();
        assert_eq!(
            import_package_into(&books, &bad_magic, &mut no_progress())
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );

        // 版本不支持。
        let bad_version = root.join("bad-version.jusong");
        let mut bytes = vec![0u8; PACKAGE_HEADER_BYTES + PACKAGE_TAG_BYTES + 4];
        bytes[..8].copy_from_slice(PACKAGE_MAGIC);
        bytes[8] = PACKAGE_VERSION + 1;
        fs::write(&bad_version, &bytes).unwrap();
        assert_eq!(
            import_package_into(&books, &bad_version, &mut no_progress())
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );

        // 文件过短（只有 magic）。
        let truncated = root.join("truncated.jusong");
        fs::write(&truncated, PACKAGE_MAGIC).unwrap();
        assert_eq!(
            import_package_into(&books, &truncated, &mut no_progress())
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );

        // 密文被篡改（GCM tag 校验失败）。
        let tampered = root.join("tampered.jusong");
        write_test_package(
            &tampered,
            &[(
                "book.json",
                br#"{"id":"tamperbook-11111111","schemaVersion":2,"chapterIds":[]}"#.as_slice(),
                None,
            )],
        );
        let mut container = fs::read(&tampered).unwrap();
        let last = container.len() - 1;
        container[last] ^= 0xFF;
        fs::write(&tampered, &container).unwrap();
        let error = import_package_into(&books, &tampered, &mut no_progress()).unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
        assert!(
            error.message.contains("解密失败"),
            "篡改包提示应说明解密失败：{}",
            error.message
        );

        let leftovers: Vec<String> = fs::read_dir(&books)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with(".import-"))
            .collect();
        assert!(leftovers.is_empty(), "临时目录未清理：{leftovers:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_package_roundtrip_includes_source() {
        let root = temp_root("package-roundtrip");
        let books = root.join("books");
        let book_id = "testbook-11111111";
        write_fixture_book(&books, book_id);

        let package = root.join("out.jusong");
        let result = export_book_into(&books, book_id, "package", &package, &mut no_progress())
            .expect("export package");
        let files = result["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0]["path"],
            json!(package.to_string_lossy().to_string())
        );
        assert!(files[0]["bytes"].as_u64().unwrap() > 0);
        assert!(package.exists());

        // 导出文件是 `.jusong` 加密容器：magic + version + nonce，而不是可读 ZIP。
        let container = fs::read(&package).unwrap();
        assert_eq!(&container[..PACKAGE_MAGIC.len()], PACKAGE_MAGIC);
        assert_eq!(container[PACKAGE_MAGIC.len()], PACKAGE_VERSION);
        assert!(
            container.len() > PACKAGE_HEADER_BYTES + PACKAGE_TAG_BYTES,
            "容器应包含密文与 tag"
        );
        assert_ne!(
            &container[..2],
            b"PK",
            "导出文件不应是标准 ZIP（避免被解压工具直接打开）"
        );
        assert!(
            ZipArchive::new(Cursor::new(container.clone())).is_err(),
            "标准 ZipArchive 不能直接读取加密容器"
        );

        // 解密后的 ZIP 顶层是 book.json，含 source/ 与章节，但不含用户库 index.json/manifest.json。
        let zip_bytes = decrypt_test_package(&package);
        let mut archive = ZipArchive::new(Cursor::new(zip_bytes)).unwrap();
        let mut names = Vec::new();
        for index in 0..archive.len() {
            names.push(archive.by_index(index).unwrap().name().to_string());
        }
        assert!(names.iter().any(|name| name == "book.json"));
        assert!(names.iter().any(|name| name == "source/原文件.txt"));
        assert!(names
            .iter()
            .any(|name| name == "chapters/ch-a/chapter.json"));
        assert!(!names.iter().any(|name| name == "index.json"));
        assert!(!names.iter().any(|name| name == "manifest.json"));

        // 导入到新库：书籍可读。
        let books2 = root.join("books2");
        fs::create_dir_all(&books2).unwrap();
        let imported =
            import_package_into(&books2, &package, &mut no_progress()).expect("import package");
        assert_eq!(imported["id"], book_id);
        assert_eq!(imported["parseState"], "parsed");
        assert!(books2
            .join(book_id)
            .join("source")
            .join("原文件.txt")
            .exists());
        assert!(books2
            .join(book_id)
            .join("chapters/ch-a/chapter.json")
            .exists());
        let index = read_json_opt(&books2.join("index.json")).unwrap().unwrap();
        assert_eq!(index["books"].as_array().unwrap().len(), 1);

        // 重复导入同一解析包：返回已有书，不重复建目录。
        let again =
            import_package_into(&books2, &package, &mut no_progress()).expect("dedupe package");
        assert_eq!(again["deduped"], json!(true));
        let index = read_json_opt(&books2.join("index.json")).unwrap().unwrap();
        assert_eq!(index["books"].as_array().unwrap().len(), 1);
        assert_eq!(
            fs::read_dir(&books2).unwrap().count(),
            2,
            "只有书籍目录与 index.json"
        );

        // 临时 ZIP 必须清理。同一本书再次导出：随机 nonce 应产生不同密文。
        assert!(
            leftover_temp_zips(&root).is_empty(),
            "导出临时 ZIP 未清理：{:?}",
            leftover_temp_zips(&root)
        );
        let second_package = root.join("out2.jusong");
        export_book_into(
            &books,
            book_id,
            "package",
            &second_package,
            &mut no_progress(),
        )
        .expect("second export");
        assert_ne!(
            fs::read(&package).unwrap(),
            fs::read(&second_package).unwrap(),
            "每次导出应使用随机 nonce（密文不同）"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_package_appends_jusong_extension_and_reports_encrypt_progress() {
        let root = temp_root("export-extension");
        let books = root.join("books");
        let book_id = "testbook-11111111";
        write_fixture_book(&books, book_id);

        // 用户误写 .zip 扩展名：导出仍写 `.jusong`，返回路径同步更新。
        let requested = root.join("误写扩展名.zip");
        let mut phases: Vec<String> = Vec::new();
        let result = {
            let mut progress = |phase: &str, _current: u64, _total: u64, _message: &str| {
                phases.push(phase.to_string());
            };
            export_book_into(&books, book_id, "package", &requested, &mut progress)
                .expect("export package")
        };
        let exported = root.join("误写扩展名.jusong");
        assert!(exported.exists());
        assert!(!requested.exists(), "不应写出 .zip 文件");
        assert_eq!(
            result["files"][0]["path"],
            json!(exported.to_string_lossy().to_string())
        );
        assert!(phases.iter().any(|phase| phase == "zip"), "{phases:?}");
        assert!(phases.iter().any(|phase| phase == "encrypt"), "{phases:?}");
        assert!(
            leftover_temp_zips(&root).is_empty(),
            "导出临时 ZIP 未清理：{:?}",
            leftover_temp_zips(&root)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_package_reports_decrypt_progress() {
        let root = temp_root("import-progress");
        let books = root.join("books");
        let book_id = "testbook-11111111";
        write_fixture_book(&books, book_id);
        let package = root.join("out.jusong");
        export_book_into(&books, book_id, "package", &package, &mut no_progress())
            .expect("export package");

        let books2 = root.join("books2");
        fs::create_dir_all(&books2).unwrap();
        let mut phases: Vec<String> = Vec::new();
        {
            let mut progress = |phase: &str, _current: u64, _total: u64, _message: &str| {
                phases.push(phase.to_string());
            };
            import_package_into(&books2, &package, &mut progress).expect("import package");
        }
        assert!(phases.iter().any(|phase| phase == "decrypt"), "{phases:?}");
        assert!(phases.iter().any(|phase| phase == "unzip"), "{phases:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_all_writes_original_and_package() {
        let root = temp_root("export-all");
        let books = root.join("books");
        let book_id = "testbook-11111111";
        write_fixture_book(&books, book_id);

        let destination = root.join("导出目录");
        let result = export_book_into(&books, book_id, "all", &destination, &mut no_progress())
            .expect("export all");
        let files = result["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        for file in files {
            assert!(file["bytes"].as_u64().unwrap() > 0);
        }
        let original = destination.join("测试导出书.txt");
        let package = destination.join("测试导出书-解析包.jusong");
        assert!(original.exists());
        assert!(package.exists());
        assert_eq!(fs::read(&original).unwrap(), b"hello-source");
        assert_eq!(
            &fs::read(&package).unwrap()[..PACKAGE_MAGIC.len()],
            PACKAGE_MAGIC
        );
        assert!(
            leftover_temp_zips(&destination).is_empty(),
            "导出临时 ZIP 未清理：{:?}",
            leftover_temp_zips(&destination)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn export_original_handles_missing_source_gracefully() {
        let root = temp_root("export-original");
        let books = root.join("books");
        let book_id = "testbook-11111111";
        write_fixture_book(&books, book_id);

        let target = root.join("导出原文件.txt");
        export_book_into(&books, book_id, "original", &target, &mut no_progress())
            .expect("export original");
        assert_eq!(fs::read(&target).unwrap(), b"hello-source");

        // 无 source/ 的书（种子书）：导出原文件返回 NOT_FOUND，解析包仍可导出。
        let seed_id = "seedbook-22222222";
        let seed_dir = books.join(seed_id);
        fs::create_dir_all(&seed_dir).unwrap();
        write_json(
            &seed_dir.join("book.json"),
            &json!({
                "id": seed_id,
                "title": "种子书",
                "format": "seed",
                "schemaVersion": 2,
                "chapterIds": ["ch-a"],
                "chapterCount": 1,
            }),
        )
        .unwrap();
        let error = export_book_into(
            &books,
            seed_id,
            "original",
            &root.join("种子.epub"),
            &mut no_progress(),
        )
        .unwrap_err();
        assert_eq!(error.code, "NOT_FOUND");
        let package = root.join("seed.jusong");
        let result = export_book_into(&books, seed_id, "package", &package, &mut no_progress())
            .expect("seed package");
        assert!(package.exists());
        assert_eq!(
            result["files"][0]["path"],
            json!(package.to_string_lossy().to_string())
        );
        assert_eq!(
            &fs::read(&package).unwrap()[..PACKAGE_MAGIC.len()],
            PACKAGE_MAGIC
        );

        // 非法导出方式。
        let error = export_book_into(
            &books,
            book_id,
            "bad-mode",
            &root.join("x"),
            &mut no_progress(),
        )
        .unwrap_err();
        assert_eq!(error.code, "INVALID_INPUT");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transfer_info_reports_counts_and_sizes() {
        let root = temp_root("info");
        let books = root.join("books");
        let book_id = "testbook-11111111";
        let directory = write_fixture_book(&books, book_id);

        let info = transfer_info_into(&books, book_id).expect("transfer info");
        assert_eq!(info["bookId"], book_id);
        assert_eq!(info["title"], "测试导出书");
        assert_eq!(info["author"], "作者");
        assert_eq!(info["format"], "txt");
        assert_eq!(info["sourceName"], "原文件.txt");
        assert_eq!(info["sourceSize"], json!(12));
        assert_eq!(info["chapterCount"], json!(1));
        assert_eq!(info["archiveCount"], json!(2));
        assert_eq!(info["digestCount"], json!(1));
        assert_eq!(info["parseState"], "parsed");
        let expected: u64 = collect_book_files(&directory)
            .unwrap()
            .iter()
            .map(|(_, size)| *size)
            .sum();
        assert_eq!(info["packageSize"], json!(expected));
        assert!(expected > 0);

        // 未登记/非法 bookId。
        assert_eq!(
            transfer_info_into(&books, "missing-book").unwrap_err().code,
            "NOT_FOUND"
        );
        assert_eq!(
            transfer_info_into(&books, "非法 ID").unwrap_err().code,
            "INVALID_INPUT"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sanitize_zip_entry_name_rejects_escapes() {
        assert_eq!(
            sanitize_zip_entry_name("chapters/ch-a/chapter.json").unwrap(),
            vec![
                "chapters".to_string(),
                "ch-a".to_string(),
                "chapter.json".to_string()
            ]
        );
        assert!(sanitize_zip_entry_name("../evil").is_err());
        assert!(sanitize_zip_entry_name("a/../../evil").is_err());
        assert!(sanitize_zip_entry_name("/etc/passwd").is_err());
        assert!(sanitize_zip_entry_name("C:/evil").is_err());
        assert!(sanitize_zip_entry_name("\\\\server\\share").is_err());
        assert!(sanitize_zip_entry_name("a\\b").is_ok());
    }
}
