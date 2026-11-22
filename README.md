# 沮诵（Jusong）

本地优先的电子书阅读器：书架 → 导入 EPUB → 卷 / 章节索引 → 阅读 → 摘要与知识库。

## 功能

- 书架管理：导入 EPUB / PDF / TXT / MOBI，读取封面、作者、出版社与目录索引
- 阅读器：翻页、书签、章节进度记忆、主题与字号，支持划词引用
- 知识库：章节摘要、档案、地图地点与时间线，支持独立检索
- 伴读助手（可选）：对话式伴读，可在设置中配置模型接口
- 多端运行：Windows 桌面与 Android

## 技术栈

- 前端：React + Vite + TypeScript + Tailwind CSS
- 桌面 / 移动壳：Tauri 2 + Rust
- 包管理：pnpm workspace，`packages/core` 为领域库

## 结构

```text
src/                  React + Vite + Tailwind 前端 UI
packages/core/        Library 契约、EPUB 解析、摘要、知识库
src-tauri/            Tauri 2 壳 + Rust Content API
public/               前端静态资产
data/books/           书架索引与书籍数据目录
scripts/              构建与数据脚本
```

## 构建与运行

环境要求：Node.js 20+、pnpm 9+、Rust stable 工具链，以及 Tauri 2 依赖
（Windows：MSVC Build Tools + WebView2）。

```bash
pnpm install
pnpm tauri dev                        # 桌面开发运行
pnpm tauri build --bundles nsis       # 构建 Windows 安装包
```

## 许可

源码按 BSD-3-Clause 许可发布，详见 [LICENSE](LICENSE)；课程提交说明见 [SUBMISSION.md](SUBMISSION.md)。
