//! 封面读取：用户库 `books/<bookId>/cover.*` 的二进制读取命令。
//!
//! 封面由 JS 在导入时缩放编码，Rust 只负责落盘（见 library.rs 导入流程）与读取；
//! 文件名/MIME 记录在 book.json 的 `coverFile`/`coverMime`。

use tauri::ipc::Response;
use tauri::AppHandle;

use crate::library::{book_dir, debug_log, read_json_opt, run, ApiError};

/// 读取书籍封面二进制；没有封面时返回空响应（前端按 null 处理）。
#[tauri::command]
pub async fn library_get_book_cover(app: AppHandle, book_id: String) -> Result<Response, ApiError> {
    debug_log("get_book_cover");
    run(move || {
        let dir = book_dir(&app, &book_id)?;
        let book = read_json_opt(&dir.join("book.json"))?;
        let Some(book) = book else {
            return Ok(Response::new(Vec::<u8>::new()));
        };
        let Some(file) = book.get("coverFile").and_then(|value| value.as_str()) else {
            return Ok(Response::new(Vec::<u8>::new()));
        };
        if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
            return Err(ApiError::invalid("封面文件名非法"));
        }
        let path = dir.join(file);
        let bytes = std::fs::read(&path).unwrap_or_default();
        Ok(Response::new(bytes))
    })
    .await
}
