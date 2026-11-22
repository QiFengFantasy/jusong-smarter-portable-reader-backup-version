import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GlobalSearchHit } from "@jusong/core";

import type { HomeGuideTarget } from "../../lib/home-guide";
import { GlobalSearchView } from "./GlobalSearchView";

export interface HomeSearchViewProps {
  /** 界面检索命中的跳转目标（由 HomePage 处理入口/子项/常驻项切换）。 */
  onOpen: (target: HomeGuideTarget) => void;
}

/** 现有高级检索（内容检索）的命中跳转：与旧首页检索视图行为一致。 */
function openSearchHit(navigate: ReturnType<typeof useNavigate>, hit: GlobalSearchHit) {
  if (hit.kind === "book" || !hit.chapterId) {
    navigate(`/read/${hit.bookId}`);
    return;
  }
  navigate(`/read/${hit.bookId}/${hit.chapterId}`, {
    state: { openSummary: hit.kind === "knowledge" },
  });
}

/**
 * 右面板常驻「检索」对应的中间区容器（单一页面，不再有子页面）。
 *
 * 同一搜索框内用「界面入口」开关控制检索范围：
 * - 关闭（默认）：内容检索（原高级检索：正文/知识/书名/作者，最近阅读优先与查找更多）；
 * - 开启：界面检索（首页入口/导览子项/设置项，本地导航索引，点击直接跳转）。
 * 开关切换只改变结果区，不跳转页面、不改变左入口。
 */
export function HomeSearchView({ onOpen }: HomeSearchViewProps) {
  const navigate = useNavigate();
  const [interfaceMode, setInterfaceMode] = useState(false);

  return (
    <GlobalSearchView
      onOpenHit={(hit) => openSearchHit(navigate, hit)}
      interfaceSearch={{
        active: interfaceMode,
        onToggle: () => setInterfaceMode((value) => !value),
        onOpen,
      }}
    />
  );
}
