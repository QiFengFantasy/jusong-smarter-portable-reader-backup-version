import { useEffect, useState } from "react";

function readViewportWidth(): number {
  if (typeof window === "undefined") return 1440;
  return window.innerWidth;
}

/**
 * 阅读器视口宽度（内联三栏断点判断用）。
 *
 * 用 resize/orientationchange 监听并在 rAF 里节流更新；与 Tailwind 断点数值保持一致
 * （READER_INLINE_LAYOUT_BREAKPOINT = 1024）。
 */
export function useReaderViewportWidth(): number {
  const [width, setWidth] = useState(readViewportWidth);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(readViewportWidth()));
    };
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return width;
}
