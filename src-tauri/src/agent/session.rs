//! AGENT 会话持久化（单会话）。
//!
//! 对话消息由前端（`src/lib/useAgent.ts`）持有完整语义（角色、文本、引用块），
//! Rust 只做「原样存 / 原样取」：不解释消息结构，避免 Rust / TS 两套消息模型漂移。
//! 文件为 `<用户库>/agent-session.json`，写入走用户库共享写锁 + tmp/rename。
//! 只保存对话内容，不包含任何密钥。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::library::{data_dir, read_json_opt, write_guard, write_json, ApiError};

const SESSION_FILE: &str = "agent-session.json";
/// 会话文件上限：单会话轻量持久化，避免异常数据撑大用户库。
const MAX_SESSION_BYTES: usize = 256 * 1024;
const MAX_SESSION_MESSAGES: usize = 200;

fn session_path(app: &AppHandle) -> Result<std::path::PathBuf, ApiError> {
    Ok(data_dir(app)?.join(SESSION_FILE))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 读取会话；文件缺失或损坏时返回空会话（不阻塞界面）。
pub(crate) fn load(app: &AppHandle) -> Result<Value, ApiError> {
    let stored = read_json_opt(&session_path(app)?).unwrap_or_default();
    let messages = stored
        .as_ref()
        .and_then(|value| value.get("messages"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let updated_at = stored
        .as_ref()
        .and_then(|value| value.get("updatedAt"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({ "messages": messages, "updatedAt": updated_at }))
}

/// 保存会话：`messages` 由前端序列化好的消息数组，原样落盘。
pub(crate) fn save(app: &AppHandle, messages: Vec<Value>) -> Result<Value, ApiError> {
    if messages.len() > MAX_SESSION_MESSAGES {
        return Err(ApiError::invalid(format!(
            "会话消息过多（上限 {MAX_SESSION_MESSAGES} 条）"
        )));
    }
    let payload = json!({ "messages": messages, "updatedAt": now_millis() });
    let encoded = serde_json::to_string(&payload)
        .map_err(|error| ApiError::io(format!("序列化会话失败：{error}")))?;
    if encoded.len() > MAX_SESSION_BYTES {
        return Err(ApiError::invalid("会话内容过大（上限 256 KB）"));
    }
    let path = session_path(app)?;
    let _guard = write_guard()?;
    write_json(&path, &payload)?;
    Ok(json!({ "ok": true }))
}
