import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Settings2 } from "lucide-react";

import { Button } from "../ui/button";
import { insertKnowledgeEntryIntoCache } from "../../lib/knowledge-cache";
import { useLibrary } from "../../lib/library";
import { cn, getErrorMessage } from "../../lib/utils";
import { useAgent } from "../../lib/useAgent";
import type { AgentContext, AgentMessage } from "../../lib/agent";
import { AgentComposer, type AgentPrefillInput, type AgentQuoteInput } from "./AgentComposer";
import { AgentEmptyState } from "./AgentEmptyState";
import {
  AgentMessageBubble,
  AgentStreamingBubble,
  type AgentSaveStatus,
} from "./AgentMessageBubble";

export interface AgentConsoleProps {
  /** 阅读器内打开时携带当前书/章，供「插入当前章节」使用。 */
  context?: AgentContext;
  /**
   * 阅读器划词引用（可选）：`nonce` 变化时把 `text` 插入输入区（显示为可删除引用块），
   * 不自动发送；与「插入当前章节」的 context.excerpt 引用块可叠加。
   */
  quote?: AgentQuoteInput;
  /**
   * 程序化预填提示词（可选）：`nonce` 变化时把 `text` 填入输入框（不自动发送），
   * 供探索面板「其他」卡片等入口把「更新/添加」提示词交给用户确认。
   */
  prefill?: AgentPrefillInput;
  /** 侧栏等窄空间里的紧凑排版。 */
  compact?: boolean;
  className?: string;
}

/** 阅读器入口示例提问：围绕当前章节。 */
const READER_EXAMPLE_PROMPTS = [
  "这一章的写作背景是什么？",
  "本章提到的地点/路线，还出现在哪些篇目？",
  "把本章要点整理成一段可存入知识库的笔记",
];

/** 首页入口示例提问：围绕知识库检索与主题扩展。 */
const HOME_EXAMPLE_PROMPTS = [
  "在知识库里找关于统一战线的档案",
  "这本书的知识条目可以按主题归类吗？",
  "帮我把最近检索到的内容扩展成专题笔记",
];

const NOTE_TITLE_LIMIT = 60;

function firstMeaningfulLine(text: string | undefined): string {
  const line =
    text
      ?.split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.length > 0) ?? "";
  return line.length > NOTE_TITLE_LIMIT ? `${line.slice(0, NOTE_TITLE_LIMIT)}…` : line;
}

/** 知识库条目标题：优先取本轮提问首行，其次回答首行。 */
function knowledgeNoteTitle(question: string | undefined, answer: string): string {
  const base = firstMeaningfulLine(question) || firstMeaningfulLine(answer) || "AGENT 回答";
  return `${base} · AGENT 笔记`;
}

interface SaveState {
  status: AgentSaveStatus;
  error?: string;
}

/**
 * AGENT 对话界面（首页中间栏与阅读器右栏共用）。
 *
 * 数据经 Tauri IPC：`agent_status` / `agent_chat`（流式 `agent-delta`）/ `agent_cancel` /
 * `agent_get_session` / `agent_save_session`。未配置模型时展示空态并引导到设置页。
 */
export function AgentConsole({ context, quote, prefill, compact = false, className }: AgentConsoleProps) {
  const navigate = useNavigate();
  const agent = useAgent();
  const { library } = useLibrary();
  const [input, setInput] = useState("");
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const messages = agent.messages;
  const streaming = agent.streaming;
  const configured = agent.config?.configured ?? false;
  /** 阅读器入口：带当前书/章或划词上下文，示例提问与「保存到知识库」只在这里出现。 */
  const isReaderEntry = Boolean(context?.bookId) || Boolean(quote?.chapterId);

  // 新消息/流式增量时贴底；用户向上翻阅时不打扰。
  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, agent.streamingText, streaming]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottomRef.current = distance < 80;
  };

  const openSettings = () => {
    navigate("/", { state: { openView: "settings" } });
  };

  const handleSend = async (text: string, messageContext?: AgentContext) => {
    setInput("");
    stickToBottomRef.current = true;
    await agent.send(text, messageContext);
  };

  // 某条助手回答对应的本轮用户提问（用于知识库条目 title/payload）。
  const questionFor = (messageIndex: number): string | undefined => {
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate.role === "user") return candidate.text;
    }
    return undefined;
  };

  const saveToKnowledge = async (message: AgentMessage, question?: string) => {
    const bookId = context?.bookId;
    if (!bookId || message.knowledgeSaved) return;
    setSaveStates((current) => ({ ...current, [message.id]: { status: "saving" } }));
    try {
      if (!library) {
        throw new Error("知识库尚未就绪，请稍后重试。");
      }
      const created = await library.addKnowledge({
        bookId,
        chapterId: context?.chapterId,
        type: "note",
        title: knowledgeNoteTitle(question, message.text),
        body: message.text,
        payload: {
          source: "agent",
          ...(question ? { question } : {}),
          savedAt: new Date().toISOString(),
        },
      });
      // 增量更新知识内存缓存（已加载过该书时插入投影并通知首页统计/阅读器知识库，不整库重扫）。
      insertKnowledgeEntryIntoCache(created);
      setSaveStates((current) => ({ ...current, [message.id]: { status: "saved" } }));
      agent.markMessageSaved(message.id);
    } catch (error) {
      setSaveStates((current) => ({
        ...current,
        [message.id]: { status: "error", error: getErrorMessage(error) },
      }));
    }
  };

  const saveStatusFor = (message: AgentMessage): AgentSaveStatus | undefined => {
    if (message.knowledgeSaved) return "saved";
    return saveStates[message.id]?.status;
  };

  const handleClear = () => {
    setSaveStates({});
    void agent.clear();
  };

  const examplePrompts = isReaderEntry ? READER_EXAMPLE_PROMPTS : HOME_EXAMPLE_PROMPTS;

  const emptyVariant = agent.configLoading
    ? "loading"
    : agent.configError
      ? "config-error"
      : !configured
        ? "unconfigured"
        : "welcome";
  const showEmpty = messages.length === 0 && !streaming;

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-paper", className)}>
      <header
        className={cn(
          "flex shrink-0 items-center justify-between gap-2 border-b border-border/60",
          compact ? "px-3 py-1.5" : "px-5 py-3",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "grid shrink-0 place-items-center rounded-lg bg-cinnabar/10 text-cinnabar",
              compact ? "h-7 w-7" : "h-9 w-9",
            )}
          >
            <Bot className={compact ? "h-4 w-4" : "h-5 w-5"} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-serif text-sm font-semibold tracking-wide text-ink">AGENT</span>
              {configured ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-ink-soft/70">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" aria-hidden="true" />
                  <span className="truncate">{agent.config?.model}</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] text-cinnabar/80">
                  <span className="h-1.5 w-1.5 rounded-full bg-cinnabar/60" aria-hidden="true" />
                  未配置
                </span>
              )}
            </div>
            {!compact ? (
              <p className="truncate text-[11px] leading-5 text-ink-soft">
                阅读助手 · 结合章节上下文理解书中内容
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {messages.length > 0 && !streaming ? (
            <button
              type="button"
              onClick={handleClear}
              className="rounded-md px-1.5 py-1 text-[10px] text-ink-soft/70 transition-colors hover:bg-muted/70 hover:text-ink"
            >
              清空
            </button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={openSettings}
            aria-label="AGENT 设置"
            title="AGENT 设置"
          >
            <Settings2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={cn("min-h-0 flex-1 overflow-y-auto", compact ? "px-3 py-3" : "px-5 py-5")}
      >
        <div className={cn("mx-auto flex w-full flex-col gap-3", !compact && "max-w-3xl")}>
          {showEmpty ? (
            <AgentEmptyState
              variant={emptyVariant}
              compact={compact}
              configError={agent.configError}
              prompts={examplePrompts}
              onOpenSettings={openSettings}
              onRetryConfig={() => void agent.reloadConfig()}
              onPickPrompt={(prompt) => setInput(prompt)}
            />
          ) : (
            messages.map((message, index) => (
              <AgentMessageBubble
                key={message.id}
                message={message}
                compact={compact}
                onSaveToKnowledge={
                  isReaderEntry && message.role === "assistant" && !message.error
                    ? () => void saveToKnowledge(message, questionFor(index))
                    : undefined
                }
                saveStatus={saveStatusFor(message)}
                saveError={saveStates[message.id]?.error}
              />
            ))
          )}
          {streaming ? <AgentStreamingBubble text={agent.streamingText} compact={compact} /> : null}
        </div>
      </div>

      <div
        className={cn(
          "shrink-0 border-t border-border/60 bg-paper/95",
          compact ? "px-3 py-2" : "px-5 py-3",
        )}
      >
        <div className={cn("mx-auto w-full", !compact && "max-w-3xl")}>
          {agent.configError && !showEmpty ? (
            <p
              role="alert"
              className="mb-2 rounded-md border border-cinnabar/20 bg-cinnabar/5 px-2.5 py-1.5 text-[11px] leading-5 text-cinnabar"
            >
              {agent.configError}
            </p>
          ) : null}
          <AgentComposer
            compact={compact}
            disabled={!configured || agent.configLoading}
            streaming={streaming}
            context={context}
            quote={quote}
            prefill={prefill}
            value={input}
            onChange={setInput}
            onSend={(text, messageContext) => void handleSend(text, messageContext)}
            onStop={agent.stop}
          />
        </div>
      </div>
    </div>
  );
}
