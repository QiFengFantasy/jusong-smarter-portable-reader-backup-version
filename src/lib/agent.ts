/**
 * AGENT 交互客户端（Tauri IPC）。
 *
 * 与 Rust `agent_*` 命令对应：配置（baseUrl/model/密钥状态）、消息发送（流式增量）、
 * 取消、单会话持久化。密钥只存在用户库，前端只能看到 `configured` 状态，永远拿不到明文。
 *
 * 流式协议：发送前订阅 `agent-delta`（`{ requestId, delta }`），`agent_chat` 命令在流结束后
 * 返回最终文本；失败时命令 reject（`{ code, message }`），同时 Rust 侧也会发 `agent-error`。
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** AGENT 配置状态（不含密钥明文）。 */
export interface AgentConfigStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
}

export type AgentRole = "user" | "assistant" | "system";

export interface AgentContext {
  bookId?: string;
  bookTitle?: string;
  chapterId?: string;
  chapterTitle?: string;
  /** 用户点「插入当前章节」时附带的章节片段（有长度上限）。 */
  excerpt?: string;
  /** 用户划词选中的原文（仅在显式引用时随本轮消息注入）。 */
  quote?: string;
  /** 选中原文所属章节标题（用于给模型标注来源；缺省沿用 chapterTitle）。 */
  quoteChapterTitle?: string;
}

export interface AgentMessage {
  id: string;
  role: AgentRole;
  text: string;
  createdAt: string;
  /** 请求失败/未配置时标记为系统提示（界面用警示样式）。 */
  error?: boolean;
  /** 用户消息附带过的章节引用（界面显示为引用块）。 */
  context?: AgentContext;
  /** 阅读器入口下，这条助手回答是否已手动保存到知识库（随会话持久化，防重复保存）。 */
  knowledgeSaved?: boolean;
}

export interface AgentSendOptions {
  messages: AgentMessage[];
  context?: AgentContext;
  /** 流式增量回调。 */
  onDelta?: (delta: string) => void;
  /** 前端可据此取消。 */
  requestId?: string;
}

/** 单会话持久化结构（Rust 原样存取）。 */
export interface AgentSession {
  messages: AgentMessage[];
  updatedAt?: number | null;
}

export const AGENT_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const AGENT_DEFAULT_MODEL = "deepseek-chat";

/** 归一化后的 AGENT 错误：`code` 与 Rust `ApiError.code` 对齐。 */
export class AgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

interface AgentDeltaPayload {
  requestId: string;
  delta: string;
}

interface AgentChatResult {
  text?: string;
  message?: { text?: string };
}

function isDesktop(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** 把 Rust/未知来源的错误统一成 AgentError（保留 code）。 */
export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : "AGENT 请求失败，请稍后重试";
    if (typeof record.code === "string" && record.code.trim()) {
      return new AgentError(record.code, message);
    }
    return new AgentError("UNKNOWN", message);
  }
  if (typeof error === "string" && error.trim()) {
    return new AgentError("UNKNOWN", error);
  }
  return new AgentError("UNKNOWN", "AGENT 请求失败，请稍后重试");
}

/** 生成前端本地 id（消息/请求）。 */
export function createAgentId(prefix = "msg"): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`;
    }
  } catch {
    // 忽略不支持 randomUUID 的环境。
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 读取 AGENT 配置状态（Rust：agent_status）。 */
export async function fetchAgentConfig(): Promise<AgentConfigStatus> {
  if (!isDesktop()) {
    return {
      configured: false,
      baseUrl: AGENT_DEFAULT_BASE_URL,
      model: AGENT_DEFAULT_MODEL,
    };
  }
  try {
    const status = await invoke<unknown>("agent_status");
    const record = (status ?? {}) as Record<string, unknown>;
    return {
      configured: record.configured === true,
      baseUrl:
        typeof record.baseUrl === "string" && record.baseUrl.trim()
          ? record.baseUrl
          : AGENT_DEFAULT_BASE_URL,
      model:
        typeof record.model === "string" && record.model.trim()
          ? record.model
          : AGENT_DEFAULT_MODEL,
    };
  } catch (error) {
    throw toAgentError(error);
  }
}

/** 保存 AGENT 配置；apiKey 留空表示不修改已保存的密钥（Rust：agent_set_config）。 */
export async function updateAgentConfig(input: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): Promise<AgentConfigStatus> {
  if (!isDesktop()) {
    throw new AgentError("NOT_TAURI", "浏览器调试模式不支持保存 AGENT 配置，请在桌面应用中使用。");
  }
  try {
    const args: Record<string, string> = {};
    if (typeof input.apiKey === "string") args.apiKey = input.apiKey;
    if (typeof input.baseUrl === "string") args.baseUrl = input.baseUrl;
    if (typeof input.model === "string") args.model = input.model;
    await invoke("agent_set_config", args);
  } catch (error) {
    throw toAgentError(error);
  }
  return fetchAgentConfig();
}

/** 清除已保存的密钥（Rust：agent_clear_key）。 */
export async function clearAgentConfig(): Promise<AgentConfigStatus> {
  if (!isDesktop()) {
    throw new AgentError("NOT_TAURI", "浏览器调试模式不支持清除 AGENT 配置，请在桌面应用中使用。");
  }
  try {
    await invoke("agent_clear_key");
  } catch (error) {
    throw toAgentError(error);
  }
  return fetchAgentConfig();
}

function toWireMessages(messages: AgentMessage[]): Array<{ role: AgentRole; text: string }> {
  return messages
    .filter((message) => message.text.trim().length > 0)
    .map((message) => ({ role: message.role, text: message.text }));
}

/** 发送一轮对话，返回最终 assistant 消息（流式增量通过 onDelta 回调）。 */
export async function sendAgentChat(options: AgentSendOptions): Promise<AgentMessage> {
  if (!isDesktop()) {
    throw new AgentError("NOT_TAURI", "浏览器调试模式不支持 AGENT 请求，请在桌面应用中运行。");
  }
  if (options.messages.length === 0) {
    throw new AgentError("INVALID_INPUT", "消息不能为空");
  }

  const requestId = options.requestId ?? createAgentId("req");
  let unlisten: UnlistenFn | null = null;
  let streamed = "";
  try {
    unlisten = await listen<AgentDeltaPayload>("agent-delta", (event) => {
      const payload = event.payload;
      if (!payload || payload.requestId !== requestId) return;
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if (!delta) return;
      streamed += delta;
      options.onDelta?.(delta);
    });

    const result = await invoke<AgentChatResult>("agent_chat", {
      requestId,
      messages: toWireMessages(options.messages),
      context: options.context ?? null,
    });
    const text =
      typeof result?.text === "string"
        ? result.text
        : typeof result?.message?.text === "string"
          ? result.message.text
          : streamed;
    return {
      id: createAgentId("assistant"),
      role: "assistant",
      text,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    throw toAgentError(error);
  } finally {
    unlisten?.();
  }
}

/** 取消进行中的请求（Rust：agent_cancel）。取消是尽力而为，最终以 agent_chat reject 为准。 */
export async function cancelAgentChat(requestId: string): Promise<void> {
  if (!isDesktop() || !requestId) return;
  try {
    await invoke("agent_cancel", { requestId });
  } catch (error) {
    // 取消失败不改变界面状态：请求仍会被超时/服务端结束。
    console.warn("[jusong] 取消 AGENT 请求失败：", toAgentError(error).message);
  }
}

function normalizeStoredMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: AgentMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const role = record.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const text = typeof record.text === "string" ? record.text : "";
    if (!text.trim()) continue;
    const context = record.context as AgentContext | undefined;
    messages.push({
      id: typeof record.id === "string" && record.id ? record.id : createAgentId("stored"),
      role,
      text,
      createdAt:
        typeof record.createdAt === "string" && record.createdAt
          ? record.createdAt
          : new Date().toISOString(),
      error: record.error === true,
      knowledgeSaved: record.knowledgeSaved === true,
      ...(context && typeof context === "object" ? { context } : {}),
    });
  }
  return messages;
}

/** 读取单会话历史（Rust：agent_get_session）；命令不可用时返回空会话。 */
export async function fetchAgentSession(): Promise<AgentSession> {
  if (!isDesktop()) return { messages: [] };
  try {
    const stored = await invoke<unknown>("agent_get_session");
    const record = (stored ?? {}) as Record<string, unknown>;
    return {
      messages: normalizeStoredMessages(record.messages),
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : null,
    };
  } catch {
    // 会话持久化是增强能力：读取失败按空会话处理，不影响对话。
    return { messages: [] };
  }
}

/** 保存单会话历史（Rust：agent_save_session）；失败只告警不打断对话。 */
export async function saveAgentSession(messages: AgentMessage[]): Promise<void> {
  if (!isDesktop()) return;
  try {
    await invoke("agent_save_session", { messages });
  } catch (error) {
    console.warn("[jusong] 保存 AGENT 会话失败：", toAgentError(error).message);
  }
}
