/**
 * AGENT 会话状态 hook（首页 AIView 与阅读器侧栏 AgentConsole 共用）。
 *
 * - 配置：挂载时读取 `agent_status`，窗口重新获得焦点时刷新（设置页保存后返回即可生效）；
 * - 会话：挂载时读取 `agent_get_session`，消息变化时写回 `agent_save_session`（单会话）；
 * - 发送：先把用户消息入列，流式增量放在 `streamingText`（不写盘），完成后落正式消息；
 * - 取消：`stop()` 调 `agent_cancel`，Rust 侧以 `CANCELLED` 结束，保留已生成的部分文本。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  AGENT_DEFAULT_BASE_URL,
  AGENT_DEFAULT_MODEL,
  cancelAgentChat,
  createAgentId,
  fetchAgentConfig,
  fetchAgentSession,
  saveAgentSession,
  sendAgentChat,
  toAgentError,
  type AgentConfigStatus,
  type AgentContext,
  type AgentMessage,
} from "./agent";

export interface UseAgentResult {
  /** 配置状态；读取失败时为 `null`。 */
  config: AgentConfigStatus | null;
  configLoading: boolean;
  configError: string | null;
  /** 已完成的对话消息（不含正在流式输出的助手回复）。 */
  messages: AgentMessage[];
  /** 是否有请求进行中（含正在停止）。 */
  streaming: boolean;
  /** 流式输出中的助手文本。 */
  streamingText: string;
  /** 发送一轮消息；`context.excerpt` 存在时作为本轮章节引用。 */
  send: (text: string, context?: AgentContext) => Promise<void>;
  /** 停止当前请求。 */
  stop: () => void;
  /** 清空会话（同时清空持久化）。 */
  clear: () => Promise<void>;
  /** 标记某条助手回答已保存到知识库（随会话持久化，避免重复保存）。 */
  markMessageSaved: (messageId: string) => void;
  /** 重新读取配置。 */
  reloadConfig: () => Promise<void>;
}

export function useAgent(): UseAgentResult {
  const [config, setConfig] = useState<AgentConfigStatus | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");

  const mountedRef = useRef(true);
  const messagesRef = useRef<AgentMessage[]>([]);
  const streamingRef = useRef(false);
  const streamingTextRef = useRef("");
  const requestIdRef = useRef<string | null>(null);
  const sessionLoadedRef = useRef(false);

  messagesRef.current = messages;

  const updateStreamingText = useCallback((next: string) => {
    streamingTextRef.current = next;
    setStreamingText(next);
  }, []);

  const reloadConfig = useCallback(async () => {
    if (!mountedRef.current) return;
    setConfigLoading(true);
    setConfigError(null);
    try {
      const status = await fetchAgentConfig();
      if (mountedRef.current) setConfig(status);
    } catch (error) {
      if (mountedRef.current) {
        setConfigError(toAgentError(error).message);
        setConfig({
          configured: false,
          baseUrl: AGENT_DEFAULT_BASE_URL,
          model: AGENT_DEFAULT_MODEL,
        });
      }
    } finally {
      if (mountedRef.current) setConfigLoading(false);
    }
  }, []);

  // 配置 + 会话初始化：会话读回后把 sessionLoadedRef 打开，避免初始空数组覆盖已存会话。
  useEffect(() => {
    mountedRef.current = true;
    void reloadConfig();
    let alive = true;
    void (async () => {
      const session = await fetchAgentSession();
      if (!alive) return;
      if (session.messages.length > 0) setMessages(session.messages);
      sessionLoadedRef.current = true;
    })();
    return () => {
      alive = false;
      mountedRef.current = false;
    };
  }, [reloadConfig]);

  // 窗口重新获得焦点时刷新配置（用户可能刚在设置页保存/清除密钥）。
  useEffect(() => {
    const onFocus = () => {
      void reloadConfig();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadConfig]);

  // 消息变化写回单会话存储（流式增量不入库，只在完成时落一条正式消息）。
  useEffect(() => {
    if (!sessionLoadedRef.current) return;
    void saveAgentSession(messages);
  }, [messages]);

  const appendMessage = useCallback((message: AgentMessage) => {
    setMessages((current) => [...current, message]);
  }, []);

  const send = useCallback(
    async (text: string, context?: AgentContext) => {
      const question = text.trim();
      if (!question || streamingRef.current) return;

      const attachedContext =
        context &&
        ((context.excerpt && context.excerpt.trim()) ||
          (context.quote && context.quote.trim()))
          ? context
          : undefined;
      const userMessage: AgentMessage = {
        id: createAgentId("user"),
        role: "user",
        text: question,
        createdAt: new Date().toISOString(),
        ...(attachedContext ? { context: attachedContext } : {}),
      };
      const history = [...messagesRef.current, userMessage];
      setMessages(history);
      updateStreamingText("");
      streamingRef.current = true;
      setStreaming(true);

      const requestId = createAgentId("req");
      requestIdRef.current = requestId;
      try {
        const reply = await sendAgentChat({
          messages: history,
          context: attachedContext,
          requestId,
          onDelta: (delta) => {
            if (!mountedRef.current) return;
            updateStreamingText(streamingTextRef.current + delta);
          },
        });
        if (!mountedRef.current) return;
        appendMessage(reply);
      } catch (error) {
        if (!mountedRef.current) return;
        const agentError = toAgentError(error);
        const createdAt = new Date().toISOString();
        if (agentError.code === "CANCELLED") {
          const partial = streamingTextRef.current.trim();
          appendMessage({
            id: createAgentId("assistant"),
            role: "assistant",
            text: partial || "已停止生成。",
            createdAt,
            error: !partial,
          });
        } else {
          appendMessage({
            id: createAgentId("assistant"),
            role: "assistant",
            text: agentError.message,
            createdAt,
            error: true,
          });
        }
      } finally {
        streamingRef.current = false;
        requestIdRef.current = null;
        if (mountedRef.current) {
          setStreaming(false);
          updateStreamingText("");
        }
      }
    },
    [appendMessage, updateStreamingText],
  );

  const stop = useCallback(() => {
    const requestId = requestIdRef.current;
    if (!requestId) return;
    void cancelAgentChat(requestId);
  }, []);

  const clear = useCallback(async () => {
    if (streamingRef.current) return;
    setMessages([]);
    updateStreamingText("");
    await saveAgentSession([]);
  }, [updateStreamingText]);

  const markMessageSaved = useCallback((messageId: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId ? { ...message, knowledgeSaved: true } : message,
      ),
    );
  }, []);

  return {
    config,
    configLoading,
    configError,
    messages,
    streaming,
    streamingText,
    send,
    stop,
    clear,
    markMessageSaved,
    reloadConfig,
  };
}
