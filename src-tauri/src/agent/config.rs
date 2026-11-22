//! AGENT 配置解析与持久化。
//!
//! 优先级（密钥、baseUrl、model 分别独立判断）：
//! 1. 用户库 `agent.json`（设置页保存，正式产品口径）；
//! 2. `debug_assertions` 构建下的进程环境变量 `JUSONG_AGENT_*`；
//! 3. `debug_assertions` 构建下仓库根 `.env` 中的 `JUSONG_AGENT_*`；
//! 4. 默认值（`https://api.deepseek.com` / `deepseek-chat`）。
//!
//! 兼容 `LLM_API_KEY` / `LLM_API_BASE` / `LLM_MODEL` 作为次级回退名。
//! 生产构建不读取环境变量与 `.env`；密钥明文只存在于用户库文件与进程内存中，
//! 不进入命令返回值、事件或日志（本模块不打印任何值）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::library::{data_dir, read_json_opt, write_guard, write_json, ApiError};

pub(crate) const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
pub(crate) const DEFAULT_MODEL: &str = "deepseek-chat";

const CONFIG_FILE: &str = "agent.json";
/// 密钥 / 接口地址 / 模型名的长度上限：防误粘大段内容进配置文件。
const MAX_API_KEY_LEN: usize = 512;
const MAX_BASE_URL_LEN: usize = 512;
const MAX_MODEL_LEN: usize = 128;

/// 解析后的运行配置。含密钥明文，只在 Rust 内部流转。
#[derive(Clone, Debug)]
pub(crate) struct ResolvedConfig {
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: Option<String>,
}

/// 用户库 `agent.json` 的原始字段（全部可缺省）。
#[derive(Default)]
struct StoredConfig {
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, ApiError> {
    Ok(data_dir(app)?.join(CONFIG_FILE))
}

fn string_field(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// 读取用户库配置；文件缺失、损坏或字段非法时按未设置处理（不阻塞状态查询）。
fn read_stored(path: &Path) -> StoredConfig {
    let Ok(Some(value)) = read_json_opt(path) else {
        return StoredConfig::default();
    };
    StoredConfig {
        api_key: string_field(value.get("apiKey")),
        base_url: string_field(value.get("baseUrl")),
        model: string_field(value.get("model")),
    }
}

fn stored_value(stored: &StoredConfig) -> Value {
    let mut map = Map::new();
    if let Some(base_url) = &stored.base_url {
        map.insert("baseUrl".to_string(), json!(base_url));
    }
    if let Some(model) = &stored.model {
        map.insert("model".to_string(), json!(model));
    }
    if let Some(api_key) = &stored.api_key {
        map.insert("apiKey".to_string(), json!(api_key));
    }
    Value::Object(map)
}

fn write_stored(path: &Path, stored: &StoredConfig) -> Result<(), ApiError> {
    let _guard = write_guard()?;
    write_json(path, &stored_value(stored))
}

// ---------------------------------------------------------------------------
// 开发期回退：进程环境变量 + 仓库根 .env
// ---------------------------------------------------------------------------

const ENV_FILE_NAMES: [&str; 3] = [".env", ".env.local", ".env.development"];
const AGENT_ENV_KEYS: [(&str, &str); 3] = [
    ("JUSONG_AGENT_API_KEY", "LLM_API_KEY"),
    ("JUSONG_AGENT_BASE_URL", "LLM_API_BASE"),
    ("JUSONG_AGENT_MODEL", "LLM_MODEL"),
];

/// 仓库根 `.env` 候选路径（开发态二进制运行目录可能在 `src-tauri`）。
fn env_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = manifest.parent() {
        for name in ENV_FILE_NAMES {
            candidates.push(root.join(name));
        }
    }
    if let Ok(current) = std::env::current_dir() {
        for name in ENV_FILE_NAMES {
            candidates.push(current.join(name));
        }
    }
    candidates
}

fn read_env_file() -> HashMap<String, String> {
    for path in env_file_candidates() {
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        let parsed = parse_env_file(&contents);
        if !parsed.is_empty() {
            return parsed;
        }
    }
    HashMap::new()
}

/// 解析 `.env` 右侧值：支持单/双引号（引号后的内联注释丢弃），
/// 未加引号时按「空格 + #」截断内联注释。
fn parse_env_value(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let first = trimmed.chars().next()?;
    if first == '"' || first == '\'' {
        let rest = &trimmed[1..];
        let end = rest.find(first)?;
        let value = rest[..end].trim();
        return if value.is_empty() { None } else { Some(value) };
    }
    let value = match trimmed.find(" #") {
        Some(index) => trimmed[..index].trim_end(),
        None => trimmed,
    };
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn parse_env_file(contents: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            continue;
        }
        let Some(value) = parse_env_value(raw_value) else {
            continue;
        };
        values.insert(key.to_string(), value.to_string());
    }
    values
}

/// 仅 debug 构建允许读环境变量与 `.env`，且进程环境变量优先于 `.env`。
fn env_overrides() -> HashMap<String, String> {
    if !cfg!(debug_assertions) {
        return HashMap::new();
    }
    let mut values = read_env_file();
    for (primary, alias) in AGENT_ENV_KEYS {
        for key in [primary, alias] {
            if let Ok(raw) = std::env::var(key) {
                let value = raw.trim();
                if !value.is_empty() {
                    values.insert(key.to_string(), value.to_string());
                }
            }
        }
    }
    values
}

fn env_value(env: &HashMap<String, String>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env.get(*name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

// ---------------------------------------------------------------------------
// 校验与解析
// ---------------------------------------------------------------------------

fn has_control_or_space(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
}

pub(crate) fn normalize_base_url(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err(ApiError::invalid("接口地址不能为空"));
    }
    if value.len() > MAX_BASE_URL_LEN {
        return Err(ApiError::invalid("接口地址过长（上限 512 字符）"));
    }
    if !value.starts_with("http://") && !value.starts_with("https://") {
        return Err(ApiError::invalid("接口地址需以 http:// 或 https:// 开头"));
    }
    if has_control_or_space(value) {
        return Err(ApiError::invalid("接口地址不能包含空白字符"));
    }
    Ok(value.to_string())
}

pub(crate) fn normalize_model(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ApiError::invalid("模型名称不能为空"));
    }
    if value.len() > MAX_MODEL_LEN {
        return Err(ApiError::invalid("模型名称过长（上限 128 字符）"));
    }
    if has_control_or_space(value) {
        return Err(ApiError::invalid("模型名称不能包含空白字符"));
    }
    Ok(value.to_string())
}

fn normalize_api_key(raw: &str) -> Result<String, ApiError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ApiError::invalid("API Key 不能为空"));
    }
    if value.len() > MAX_API_KEY_LEN {
        return Err(ApiError::invalid("API Key 过长（上限 512 字符）"));
    }
    if has_control_or_space(value) {
        return Err(ApiError::invalid("API Key 不能包含空白字符"));
    }
    Ok(value.to_string())
}

/// 由「用户库原始配置 + 环境变量回退 + 是否 debug」得到最终配置。
fn resolve_from(
    stored: &StoredConfig,
    env: &HashMap<String, String>,
    debug: bool,
) -> ResolvedConfig {
    let env_opt = |names: &[&str]| if debug { env_value(env, names) } else { None };
    let base_url = stored
        .base_url
        .as_deref()
        .and_then(|raw| normalize_base_url(raw).ok())
        .or_else(|| {
            env_opt(&[AGENT_ENV_KEYS[1].0, AGENT_ENV_KEYS[1].1])
                .and_then(|raw| normalize_base_url(&raw).ok())
        })
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let model = stored
        .model
        .as_deref()
        .and_then(|raw| normalize_model(raw).ok())
        .or_else(|| {
            env_opt(&[AGENT_ENV_KEYS[2].0, AGENT_ENV_KEYS[2].1])
                .and_then(|raw| normalize_model(&raw).ok())
        })
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let api_key = stored
        .api_key
        .as_deref()
        .and_then(|raw| normalize_api_key(raw).ok())
        .or_else(|| {
            env_opt(&[AGENT_ENV_KEYS[0].0, AGENT_ENV_KEYS[0].1])
                .and_then(|raw| normalize_api_key(&raw).ok())
        });
    ResolvedConfig {
        base_url,
        model,
        api_key,
    }
}

pub(crate) fn resolve(app: &AppHandle) -> Result<ResolvedConfig, ApiError> {
    let stored = read_stored(&config_path(app)?);
    Ok(resolve_from(
        &stored,
        &env_overrides(),
        cfg!(debug_assertions),
    ))
}

fn status_value(resolved: &ResolvedConfig) -> Value {
    json!({
        "configured": resolved.api_key.is_some(),
        "baseUrl": resolved.base_url,
        "model": resolved.model,
    })
}

/// `agent_status` 的实现：只回配置状态，不回密钥。
pub(crate) fn status(app: &AppHandle) -> Result<Value, ApiError> {
    let resolved = resolve(app)?;
    Ok(status_value(&resolved))
}

/// `agent_set_config` 的实现：`None` 表示该字段不变；空字符串表示重置为默认值
/// （`apiKey` 传空表示不修改已保存密钥）。
pub(crate) fn set_config(
    app: &AppHandle,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<Value, ApiError> {
    let path = config_path(app)?;
    let mut stored = read_stored(&path);
    if let Some(raw) = api_key {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            stored.api_key = Some(normalize_api_key(trimmed)?);
        }
    }
    if let Some(raw) = base_url {
        stored.base_url = if raw.trim().is_empty() {
            None
        } else {
            Some(normalize_base_url(&raw)?)
        };
    }
    if let Some(raw) = model {
        stored.model = if raw.trim().is_empty() {
            None
        } else {
            Some(normalize_model(&raw)?)
        };
    }
    write_stored(&path, &stored)?;
    let resolved = resolve(app)?;
    Ok(json!({ "ok": true, "configured": resolved.api_key.is_some() }))
}

/// `agent_clear_key` 的实现：只删除密钥，保留 baseUrl/model。
pub(crate) fn clear_key(app: &AppHandle) -> Result<Value, ApiError> {
    let path = config_path(app)?;
    let mut stored = read_stored(&path);
    stored.api_key = None;
    write_stored(&path, &stored)?;
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn env_file_parsing_handles_comments_quotes_and_export() {
        let parsed = parse_env_file(
            "# 注释\n\nJUSONG_AGENT_API_KEY=abc123\n\
             export JUSONG_AGENT_BASE_URL=\"https://example.com/v1\" # 行尾注释\n\
             JUSONG_AGENT_MODEL='deepseek-chat'\r\n\
             INVALID-LINE\n\
             EMPTY=\n",
        );
        assert_eq!(
            parsed.get("JUSONG_AGENT_API_KEY"),
            Some(&"abc123".to_string())
        );
        assert_eq!(
            parsed.get("JUSONG_AGENT_BASE_URL"),
            Some(&"https://example.com/v1".to_string())
        );
        assert_eq!(
            parsed.get("JUSONG_AGENT_MODEL"),
            Some(&"deepseek-chat".to_string())
        );
        assert!(!parsed.contains_key("INVALID-LINE"));
        assert!(!parsed.contains_key("EMPTY"));
    }

    #[test]
    fn stored_config_wins_over_env_fallback() {
        let stored = StoredConfig {
            api_key: Some("user-key".into()),
            base_url: Some("https://user.example.com".into()),
            model: Some("user-model".into()),
        };
        let env = env(&[
            ("JUSONG_AGENT_API_KEY", "env-key"),
            ("JUSONG_AGENT_BASE_URL", "https://env.example.com"),
            ("JUSONG_AGENT_MODEL", "env-model"),
        ]);
        let resolved = resolve_from(&stored, &env, true);
        assert_eq!(resolved.api_key.as_deref(), Some("user-key"));
        assert_eq!(resolved.base_url, "https://user.example.com");
        assert_eq!(resolved.model, "user-model");
    }

    #[test]
    fn debug_falls_back_to_env_but_release_does_not() {
        let stored = StoredConfig::default();
        let env = env(&[
            ("JUSONG_AGENT_API_KEY", "env-key"),
            ("JUSONG_AGENT_BASE_URL", "https://env.example.com/"),
            ("JUSONG_AGENT_MODEL", "env-model"),
        ]);
        let debug = resolve_from(&stored, &env, true);
        assert_eq!(debug.api_key.as_deref(), Some("env-key"));
        assert_eq!(debug.base_url, "https://env.example.com");
        assert_eq!(debug.model, "env-model");

        let release = resolve_from(&stored, &env, false);
        assert_eq!(release.api_key, None);
        assert_eq!(release.base_url, DEFAULT_BASE_URL);
        assert_eq!(release.model, DEFAULT_MODEL);
    }

    #[test]
    fn legacy_llm_env_names_are_accepted_as_fallback() {
        let stored = StoredConfig::default();
        let env = env(&[
            ("LLM_API_KEY", "legacy-key"),
            ("LLM_API_BASE", "https://legacy.example.com"),
            ("LLM_MODEL", "legacy-model"),
        ]);
        let resolved = resolve_from(&stored, &env, true);
        assert_eq!(resolved.api_key.as_deref(), Some("legacy-key"));
        assert_eq!(resolved.base_url, "https://legacy.example.com");
        assert_eq!(resolved.model, "legacy-model");
    }

    #[test]
    fn invalid_stored_values_fall_back_to_defaults() {
        let stored = StoredConfig {
            api_key: Some("has space".into()),
            base_url: Some("ftp://bad".into()),
            model: Some("bad model".into()),
        };
        let resolved = resolve_from(&stored, &HashMap::new(), false);
        assert_eq!(resolved.api_key, None);
        assert_eq!(resolved.base_url, DEFAULT_BASE_URL);
        assert_eq!(resolved.model, DEFAULT_MODEL);
    }

    #[test]
    fn normalize_rejects_blank_and_accepts_https() {
        assert!(normalize_base_url("   ").is_err());
        assert!(normalize_base_url("api.deepseek.com").is_err());
        assert!(normalize_api_key("   ").is_err());
        assert_eq!(
            normalize_base_url(" https://api.deepseek.com/v1/ ").unwrap(),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(normalize_model(" deepseek-chat ").unwrap(), "deepseek-chat");
    }

    #[test]
    fn status_value_never_exposes_key() {
        let resolved = ResolvedConfig {
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-chat".into(),
            api_key: Some("secret-key".into()),
        };
        let status = status_value(&resolved);
        assert_eq!(status["configured"], Value::Bool(true));
        let rendered = status.to_string();
        assert!(!rendered.contains("secret-key"));
    }
}
