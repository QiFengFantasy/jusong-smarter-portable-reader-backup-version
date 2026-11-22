# 课程提交说明

本仓库是「沮诵」本地优先电子书阅读器的历史版本快照，用于课程作业的源码提交与演示。

## 运行环境

- Node.js 20+ 与 pnpm 9+
- Rust stable 工具链 + Tauri 2 依赖（Windows：MSVC Build Tools + WebView2）

## 快速开始

```bash
pnpm install
pnpm tauri dev                        # 桌面开发运行
pnpm tauri build --bundles nsis       # 构建 Windows 安装包
```

## 目录速览

| 路径 | 说明 |
| --- | --- |
| `src/` | React + Vite + Tailwind 前端 UI |
| `packages/core/` | Library 契约、EPUB 解析、摘要、知识库 |
| `src-tauri/` | Tauri 2 壳与 Rust Content API |
| `data/books/` | 书架索引与书籍数据目录 |
| `scripts/` | 构建与数据脚本 |
