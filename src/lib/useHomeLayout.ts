import { useEffect, useState } from "react";

import { homePaneVisibility } from "./home";

export interface HomeLayoutState {
  width: number;
  height: number;
  landscape: boolean;
  canShowLeft: boolean;
  canShowRight: boolean;
}

function readLayout(): HomeLayoutState {
  const width = typeof window === "undefined" ? 1440 : window.innerWidth;
  const height = typeof window === "undefined" ? 900 : window.innerHeight;
  return { width, height, ...homePaneVisibility(width, height) };
}

/** 监听窗口尺寸/比例：横屏时不轻易隐藏侧栏，竖屏窄屏走抽屉。 */
export function useHomeLayout(): HomeLayoutState {
  const [layout, setLayout] = useState<HomeLayoutState>(readLayout);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setLayout(readLayout()));
    };
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return layout;
}
