import { useEffect, useState } from "react";

import { AgentConsole } from "../agent/AgentConsole";
import type { AgentPrefillInput } from "../agent/AgentComposer";
import type { HomeGuideTarget } from "../../lib/home-guide";

export interface GuideAgentViewProps {
  /** 兼容 HomePage 传入；AGENT 常驻视图现只保留对话，不再提供「直达入口」提示卡。 */
  onOpen?: (target: HomeGuideTarget) => void;
}

/** 导入页交接的 AGENT 预填词：sessionStorage 键与自定义事件名（见 ImportBooksView）。 */
const AGENT_PREFILL_STORAGE_KEY = "jusong.agent.prefill";
const AGENT_PREFILL_EVENT = "jusong-agent-prefill";

interface AgentPrefillDetail {
  prompt?: string;
  bookId?: string;
  bookTitle?: string;
}

/**
 * 首页常驻「AGENT」视图：仅对话界面。
 * 原「直达入口」搜索卡片已按用户要求移除；入口/设置项检索统一走常驻「检索」。
 *
 * 导入 EPUB 后「通过 AGENT 建知识库」会先写 sessionStorage / 发事件再导航到首页；
 * 这里消费一次并作为 `prefill` 交给 AgentConsole（只填输入框，不自动发送）。
 */
export function GuideAgentView({ onOpen }: GuideAgentViewProps) {
  void onOpen;
  const [prefill, setPrefill] = useState<AgentPrefillInput | null>(null);

  useEffect(() => {
    let alive = true;
    const apply = (detail: AgentPrefillDetail | null | undefined) => {
      const text = detail?.prompt?.trim();
      if (!alive || !text) return;
      setPrefill({ text, nonce: Date.now() });
    };

    // 1) 导入页在 navigate 之前写入的一次性交接（先读后删，避免重复预填）。
    try {
      const raw = window.sessionStorage.getItem(AGENT_PREFILL_STORAGE_KEY);
      if (raw) {
        window.sessionStorage.removeItem(AGENT_PREFILL_STORAGE_KEY);
        apply(JSON.parse(raw) as AgentPrefillDetail);
      }
    } catch {
      // 隐私模式/非法 JSON：忽略，不影响 AGENT 正常使用。
    }

    // 2) AGENT 已经挂载时，导入页的事件通道直接生效。
    const onPrefill = (event: Event) => {
      apply((event as CustomEvent<AgentPrefillDetail>).detail);
    };
    window.addEventListener(AGENT_PREFILL_EVENT, onPrefill);
    return () => {
      alive = false;
      window.removeEventListener(AGENT_PREFILL_EVENT, onPrefill);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <AgentConsole className="h-full" prefill={prefill ?? undefined} />
    </div>
  );
}
