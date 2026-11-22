//! OpenAI 兼容 provider（当前实现面向 DeepSeek `/chat/completions`）。
//!
//! 分层意图与 deepseek-harness 的 provider / streaming 思路一致，但只保留轻量版本：
//! - 会话与命令层（`agent.rs`）只依赖 `ChatMessage` / `AssistantTurn` / `OpenAiCompat`；
//! - provider 负责「请求编码 → SSE 流解析 → 增量回调 → 错误归一」；
//! - tool 调用协议已预留（`ToolSpec` / `ToolCallDelta`，流式解析可用），v1 不执行工具，
//!   因此 `stream_chat` 收到的 `tools` 为空、解析到的 tool_calls 仅随 `AssistantTurn` 返回。
//!
//! 安全：密钥只放进 Authorization 头；错误信息只取 HTTP 状态与响应体文本，
//! 不含请求头；调用方负责把可能回显的密钥做遮蔽。

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::library::ApiError;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 单次请求（含流式读取）的总上限，防挂死。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// 流式读取空闲上限：超过该时间没有任何数据即超时。
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// 取消检查间隔：决定「停止」按钮的响应延迟。
const CANCEL_POLL: Duration = Duration::from_millis(250);
const MAX_ERROR_BODY_CHARS: usize = 600;
const MAX_TOOL_CALLS: usize = 8;

#[derive(Debug, Clone)]
pub(crate) struct ChatMessage {
    pub(crate) role: String,
    pub(crate) content: String,
}

/// v1 预留：当前不注册任何工具。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct ToolSpec {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) parameters: Value,
}

/// v1 预留：流式解析出的工具调用请求（不执行）。
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub(crate) struct ToolCallDelta {
    pub(crate) index: usize,
    pub(crate) id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) arguments: String,
}

/// 一次 assistant 回合：正文 +（预留的）工具调用。
#[derive(Debug, Default)]
pub(crate) struct AssistantTurn {
    pub(crate) text: String,
    pub(crate) tool_calls: Vec<ToolCallDelta>,
}

/// 校验模型服务确实返回了有效内容。
///
/// 部分兼容服务会在 HTTP 200 下返回空 choices / 只有 `[DONE]` / 只回错误 JSON，
/// 这时不能当作「成功但没有回答」静默处理，统一报 `EMPTY_RESPONSE` 让界面提示用户
/// （检查模型名、额度或接口地址），而不是显示空白回答。
pub(crate) fn ensure_turn_non_empty(turn: AssistantTurn) -> Result<AssistantTurn, ApiError> {
    if turn.text.trim().is_empty() && turn.tool_calls.is_empty() {
        return Err(ApiError::new(
            "EMPTY_RESPONSE",
            "模型服务没有返回有效内容，请检查模型配置、额度或接口地址后重试",
        ));
    }
    Ok(turn)
}

/// 把 baseUrl 归一成 `/chat/completions` 终点。
/// 允许用户填 `https://api.deepseek.com`、`.../v1`，或直接粘贴完整终点。
pub(crate) fn chat_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn http_client() -> Result<reqwest::Client, ApiError> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .user_agent(concat!("Jusong/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|error| error.to_string())
        })
        .clone()
        .map_err(|error| ApiError::new("NETWORK", format!("初始化网络客户端失败：{error}")))
}

fn network_error(error: &reqwest::Error) -> ApiError {
    if error.is_timeout() {
        ApiError::new("TIMEOUT", "请求模型服务超时，请稍后重试")
    } else if error.is_connect() {
        ApiError::new("NETWORK", "无法连接模型服务，请检查网络或接口地址")
    } else {
        ApiError::new("NETWORK", "接收模型响应失败，请检查网络后重试")
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut result: String = text.chars().take(max).collect();
    result.push('…');
    result
}

fn extract_error_message(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        for pointer in ["/error/message", "/error/detail", "/message", "/detail"] {
            if let Some(message) = value.pointer(pointer).and_then(Value::as_str) {
                let message = message.trim();
                if !message.is_empty() {
                    return Some(truncate_chars(message, MAX_ERROR_BODY_CHARS));
                }
            }
        }
    }
    Some(truncate_chars(trimmed, MAX_ERROR_BODY_CHARS))
}

/// HTTP 状态 → 统一错误码。响应体只作为附加说明，长度有上限。
pub(crate) fn map_status_error(status: u16, body: &str) -> ApiError {
    let detail = extract_error_message(body)
        .map(|message| format!("：{message}"))
        .unwrap_or_default();
    match status {
        400 => ApiError::new("BAD_REQUEST", format!("模型请求参数有误{detail}")),
        401 | 403 => ApiError::new(
            "UNAUTHORIZED",
            "API Key 无效或没有访问权限，请在设置中检查后重试",
        ),
        404 => ApiError::new(
            "NOT_FOUND",
            format!("接口地址不存在{detail}，请检查 Base URL 是否为 https://api.deepseek.com（或 .../v1）"),
        ),
        429 => ApiError::new("RATE_LIMIT", "请求过于频繁或额度不足，请稍后再试"),
        500..=599 => ApiError::new(
            "UPSTREAM",
            format!("模型服务暂时不可用（HTTP {status}）{detail}"),
        ),
        _ => ApiError::new("HTTP_ERROR", format!("模型请求失败（HTTP {status}）{detail}")),
    }
}

// ---------------------------------------------------------------------------
// SSE 解析
// ---------------------------------------------------------------------------

/// 增量 SSE 解析器：把任意切分的字节流还原成完整事件的 `data:` 负载。
#[derive(Default)]
pub(crate) struct SseParser {
    buffer: String,
}

impl SseParser {
    /// 推入一段解码后的文本，返回本次已完整的事件负载（可能多个）。
    pub(crate) fn push(&mut self, chunk: &str) -> Vec<String> {
        // 统一换行；跨 chunk 的 `\r\n` 会退化成两个 `\n`，只会多出空事件，不影响数据行。
        let normalized = chunk.replace("\r\n", "\n").replace('\r', "\n");
        self.buffer.push_str(&normalized);
        let mut payloads = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let event = self.buffer[..index].to_string();
            self.buffer.drain(..index + 2);
            if let Some(data) = event_data(&event) {
                payloads.push(data);
            }
        }
        payloads
    }
}

fn event_data(event: &str) -> Option<String> {
    let mut lines = Vec::new();
    for line in event.lines() {
        let line = line.trim_end();
        let Some(rest) = line.strip_prefix("data:") else {
            // 注释行（": keep-alive"）与其它字段忽略。
            continue;
        };
        let value = rest.strip_prefix(' ').unwrap_or(rest);
        lines.push(value);
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

#[derive(Debug)]
pub(crate) enum SsePayload {
    /// 收到 `[DONE]` 或该事件无可用增量。
    Done,
    Delta(String),
    ToolCall(ToolCallDelta),
    Ignore,
}

fn parse_tool_calls(delta: &Value) -> Vec<ToolCallDelta> {
    let Some(items) = delta.get("tool_calls").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .map(|(position, item)| {
            let index = item
                .get("index")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(position);
            let function = item.get("function");
            ToolCallDelta {
                index,
                id: item.get("id").and_then(Value::as_str).map(str::to_string),
                name: function
                    .and_then(|value| value.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                arguments: function
                    .and_then(|value| value.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            }
        })
        .collect()
}

/// 解析一条 SSE `data:` 负载；无法解析的负载按忽略处理（保持流继续）。
pub(crate) fn parse_sse_payload(data: &str) -> SsePayload {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return SsePayload::Ignore;
    }
    if trimmed == "[DONE]" {
        return SsePayload::Done;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return SsePayload::Ignore;
    };
    let Some(choice) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return SsePayload::Ignore;
    };
    let Some(delta) = choice.get("delta") else {
        return SsePayload::Ignore;
    };
    let tool_calls = parse_tool_calls(delta);
    if let Some(tool_call) = tool_calls.into_iter().next() {
        return SsePayload::ToolCall(tool_call);
    }
    let content = delta
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if content.is_empty() {
        SsePayload::Ignore
    } else {
        SsePayload::Delta(content.to_string())
    }
}

fn merge_tool_call(calls: &mut Vec<ToolCallDelta>, call: ToolCallDelta) {
    if let Some(existing) = calls.iter_mut().find(|item| item.index == call.index) {
        if call.id.is_some() {
            existing.id = call.id;
        }
        if call.name.is_some() {
            existing.name = call.name;
        }
        existing.arguments.push_str(&call.arguments);
        return;
    }
    if calls.len() < MAX_TOOL_CALLS {
        calls.push(call);
    }
}

// ---------------------------------------------------------------------------
// 请求执行
// ---------------------------------------------------------------------------

pub(crate) struct OpenAiCompat<'a> {
    endpoint: String,
    model: &'a str,
    api_key: &'a str,
}

impl<'a> OpenAiCompat<'a> {
    pub(crate) fn new(base_url: &str, model: &'a str, api_key: &'a str) -> Self {
        Self {
            endpoint: chat_endpoint(base_url),
            model,
            api_key,
        }
    }

    fn request_body(&self, messages: &[ChatMessage], tools: &[ToolSpec]) -> Value {
        let wire_messages: Vec<Value> = messages
            .iter()
            .map(|message| json!({ "role": message.role, "content": message.content }))
            .collect();
        let mut body = json!({
            "model": self.model,
            "messages": wire_messages,
            "stream": true,
            "temperature": 0.3,
        });
        if !tools.is_empty() {
            let specs: Vec<Value> = tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect();
            body["tools"] = Value::Array(specs);
        }
        body
    }

    /// 发起一次流式对话：`on_delta` 接收正文增量，`is_cancelled` 允许外部中止。
    /// 成功返回完整回合；取消返回 `CANCELLED`，网络/服务端错误返回统一错误码。
    pub(crate) async fn stream_chat<F, C>(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        mut on_delta: F,
        is_cancelled: C,
    ) -> Result<AssistantTurn, ApiError>
    where
        F: FnMut(&str),
        C: Fn() -> bool,
    {
        let client = http_client()?;
        let response = client
            .post(&self.endpoint)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Accept", "text/event-stream")
            .json(&self.request_body(messages, tools))
            .send()
            .await
            .map_err(|error| network_error(&error))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(map_status_error(status.as_u16(), &body));
        }

        let mut stream = response.bytes_stream();
        let mut parser = SseParser::default();
        let mut turn = AssistantTurn::default();
        let mut last_activity = Instant::now();
        let mut finished = false;

        while !finished {
            if is_cancelled() {
                return Err(ApiError::new("CANCELLED", "已停止生成"));
            }
            match tokio::time::timeout(CANCEL_POLL, stream.next()).await {
                // 这段时间没有新数据：继续检查取消与空闲超时。
                Err(_) => {
                    if last_activity.elapsed() > IDLE_TIMEOUT {
                        return Err(ApiError::new(
                            "TIMEOUT",
                            "模型长时间没有返回数据，已停止等待",
                        ));
                    }
                }
                Ok(None) => finished = true,
                Ok(Some(Err(error))) => return Err(network_error(&error)),
                Ok(Some(Ok(bytes))) => {
                    last_activity = Instant::now();
                    let text = String::from_utf8_lossy(&bytes);
                    for data in parser.push(&text) {
                        match parse_sse_payload(&data) {
                            SsePayload::Done => {
                                finished = true;
                                break;
                            }
                            SsePayload::Delta(delta) => {
                                turn.text.push_str(&delta);
                                on_delta(&delta);
                            }
                            SsePayload::ToolCall(call) => {
                                merge_tool_call(&mut turn.tool_calls, call);
                            }
                            SsePayload::Ignore => {}
                        }
                    }
                }
            }
        }

        ensure_turn_non_empty(turn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_endpoint_is_normalized() {
        assert_eq!(
            chat_endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            chat_endpoint("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            chat_endpoint("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn sse_parser_reassembles_split_events() {
        let mut parser = SseParser::default();
        let first = parser.push("data: {\"choices\":[{\"delta\":{\"content\":\"你");
        assert!(first.is_empty());
        let second =
            parser.push("好\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"！\"}}]}\n\n");
        assert_eq!(second.len(), 2);
        assert!(matches!(parse_sse_payload(&second[0]), SsePayload::Delta(text) if text == "你好"));
        assert!(matches!(parse_sse_payload(&second[1]), SsePayload::Delta(text) if text == "！"));
    }

    #[test]
    fn sse_parser_handles_crlf_and_done() {
        let mut parser = SseParser::default();
        let payloads = parser.push(
            "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n",
        );
        assert_eq!(payloads.len(), 2);
        assert!(matches!(parse_sse_payload(&payloads[0]), SsePayload::Delta(text) if text == "a"));
        assert!(matches!(parse_sse_payload(&payloads[1]), SsePayload::Done));
    }

    #[test]
    fn sse_parser_ignores_comments_and_bad_json() {
        let mut parser = SseParser::default();
        let payloads = parser.push(": keep-alive\n\ndata: not-json\n\ndata: {\"choices\":[]}\n\n");
        // ": keep-alive" 没有 data 行 → 不产生负载；后两条是 data 行。
        assert_eq!(payloads.len(), 2);
        assert!(matches!(
            parse_sse_payload(&payloads[0]),
            SsePayload::Ignore
        ));
        assert!(matches!(
            parse_sse_payload(&payloads[1]),
            SsePayload::Ignore
        ));
    }

    #[test]
    fn tool_call_fragments_are_merged_by_index() {
        let mut calls = Vec::new();
        merge_tool_call(
            &mut calls,
            ToolCallDelta {
                index: 0,
                id: Some("call_1".into()),
                name: Some("lookup".into()),
                arguments: "{\"a\"".into(),
            },
        );
        merge_tool_call(
            &mut calls,
            ToolCallDelta {
                index: 0,
                id: None,
                name: None,
                arguments: ":1}".into(),
            },
        );
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].arguments, "{\"a\":1}");
    }

    #[test]
    fn status_errors_map_to_stable_codes() {
        assert_eq!(map_status_error(401, "").code, "UNAUTHORIZED");
        assert_eq!(map_status_error(403, "").code, "UNAUTHORIZED");
        assert_eq!(map_status_error(429, "").code, "RATE_LIMIT");
        assert_eq!(map_status_error(503, "upstream down").code, "UPSTREAM");
        let bad = map_status_error(400, "{\"error\":{\"message\":\"bad model\"}}");
        assert_eq!(bad.code, "BAD_REQUEST");
        assert!(bad.message.contains("bad model"));
    }

    #[test]
    fn error_body_is_parsed_and_truncated() {
        assert_eq!(
            extract_error_message("{\"error\":{\"message\":\"invalid key\"}}").as_deref(),
            Some("invalid key")
        );
        let long = "x".repeat(MAX_ERROR_BODY_CHARS + 50);
        let parsed = extract_error_message(&long).unwrap();
        assert!(parsed.chars().count() <= MAX_ERROR_BODY_CHARS + 1);
    }

    #[test]
    fn request_body_sets_stream_and_model() {
        let provider = OpenAiCompat::new("https://api.deepseek.com", "deepseek-chat", "k");
        let body = provider.request_body(
            &[ChatMessage {
                role: "user".into(),
                content: "你好".into(),
            }],
            &[],
        );
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn empty_model_response_is_reported_as_error() {
        // HTTP 200 但没有任何正文/工具调用：不能静默成功。
        let error = ensure_turn_non_empty(AssistantTurn::default()).unwrap_err();
        assert_eq!(error.code, "EMPTY_RESPONSE");
        assert!(error.message.contains("没有返回有效内容"));

        let whitespace = AssistantTurn {
            text: "  \n\t".into(),
            ..AssistantTurn::default()
        };
        assert_eq!(
            ensure_turn_non_empty(whitespace).unwrap_err().code,
            "EMPTY_RESPONSE"
        );

        let text = AssistantTurn {
            text: "有效回答".into(),
            ..AssistantTurn::default()
        };
        assert_eq!(ensure_turn_non_empty(text).unwrap().text, "有效回答");

        // 只返回工具调用的回合仍算有效（v1 不执行工具但仍应提示已返回内容）。
        let tool_only = AssistantTurn {
            text: String::new(),
            tool_calls: vec![ToolCallDelta::default()],
        };
        assert!(ensure_turn_non_empty(tool_only).is_ok());
    }
}
