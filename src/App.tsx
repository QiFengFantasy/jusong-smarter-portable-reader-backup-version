import { useLayoutEffect } from "react";
import { Route, Routes } from "react-router-dom";

import { LibraryProvider } from "./lib/library";
import { SettingsProvider, useSettings } from "./lib/settings";
import { applyTheme } from "./lib/theme";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ReaderPage } from "./pages/ReaderPage";
import { ExportBookView } from "./components/home/ExportBookView";

/**
 * 主题同步器：把设置里的强调色（`--cinnabar`）与封面占位色（`--cover-*`）
 * 写入 `documentElement` 的 CSS 变量，全应用即时生效。
 *
 * - 首帧：SettingsProvider 的初始 state 就是默认朱红，与 index.css 的 :root 默认值一致，
 *   所以不会先闪一下别的颜色；本 effect 只是幂等地再写一遍同样的值。
 * - 设置异步加载完成、「恢复默认」、设置页里改色，都会让 settings 变化，在本 effect 中重新应用；
 *   用 useLayoutEffect 是为了在浏览器绘制该次 React 提交之前完成换色，避免一帧旧色。
 */
function ThemeSync() {
  const { settings } = useSettings();
  const { accentColor, coverColor } = settings;

  useLayoutEffect(() => {
    applyTheme({ accentColor, coverColor });
  }, [accentColor, coverColor]);

  return null;
}

export function App() {
  return (
    <SettingsProvider>
      <ThemeSync />
      <LibraryProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/export" element={<ExportBookView />} />
          <Route path="/export/:bookId" element={<ExportBookView />} />
          <Route path="/read/:bookId" element={<ReaderPage />} />
          <Route path="/read/:bookId/:chapterId" element={<ReaderPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </LibraryProvider>
    </SettingsProvider>
  );
}
