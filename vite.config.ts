import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  // 前端静态资产走 public/（favicon、离线省界底图）；书数据在 Tauri 下只经 Rust Content API。
  // 只把应用入口作为依赖扫描起点，避免扫到 history/ 里的旧 HTML/测试文件。
  optimizeDeps: {
    entries: ["index.html"],
  },
  resolve: {
    alias: {
      "@jusong/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    fs: {
      // 旧 Web 工程存档与 .git 不对 dev server 暴露。
      deny: ["history/**", ".git/**"],
    },
  },
});
