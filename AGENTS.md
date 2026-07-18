# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## 项目概述

知乎文章转视频（MVP）：单机、单操作者的批量内容生产工具。导入含知乎链接的 Excel → 读取文章内容 → AI 生成 3:4 竖版摘要卡片 → Sharp 栅格化 PNG → FFmpeg 合成 MP4。以 Electron 桌面应用交付（Windows/macOS），无登录、无多租户、无远程服务。产品边界与验收标准以根目录《开发文档.md》为准，阶段排期以《开发计划.md》为准。

## 常用命令

所有命令在仓库根目录执行（pnpm@11.7.0，Node.js `^20.19.0 || ^22.12.0 || >=24.0.0`）：

- `pnpm dev`：并行启动 API（127.0.0.1:3001）与 Web 开发服务
- `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm format:check`：递归执行各子包对应脚本
- `pnpm desktop:dev`：先构建 api+web，再启动 Electron 开发模式；`pnpm desktop:make` 打包桌面应用
- 单包执行：`pnpm --filter @zhihu-video/api test`（包名见各自 package.json：`@zhihu-video/api`、`@zhihu-video/web`、`@zhihu-video/desktop`、`@zhihu-video/contracts`、`@zhihu-video/pipeline`）
- 运行单个测试文件（api/web 用 Vitest）：`pnpm --filter @zhihu-video/api exec vitest run test/importer.test.ts`
- pipeline 包测试不是 Vitest：`pnpm --filter @zhihu-video/pipeline test` 会先 `tsc -p tsconfig.test.json` 再执行 `node dist-test/tests/run.js`

环境配置：AI 调用需要 `.env` 中的 `AI_API_KEY`（可选 `AI_BASE_URL`、`AI_MODEL`，默认 DeepSeek 兼容端点），见 `.env.example`。API 数据默认写入 `data/zhihu-video.sqlite`，可用 `API_PORT`、`DATA_DIR` 覆盖。

## 架构要点

pnpm monorepo，四层结构，依赖方向自上而下：

- `packages/contracts`：前后端共享的 TypeScript 类型（任务状态、批次、AI 摘要结构），无运行时逻辑。
- `packages/pipeline`：纯函数内容流水线，**刻意不依赖浏览器、HTTP 客户端与凭证**。包含 URL 分类（`source.ts` 的 `classifyZhihuUrl`）、正文清洗（`cleanReadableContent`）、AI 摘要结构校验（`summary.ts` 的 `validateVideoSummary`）、卡片序列构建（`cards.ts`）、SVG 卡片模板（`svg.ts`）、FFmpeg 命令构建（`ffmpeg.ts`）。外部能力通过接口注入：`ZhihuContentReader`（内容读取）与 `SummaryGenerator`（AI 摘要）。
- `apps/api`：Fastify + better-sqlite3 任务服务。`app.ts` 装配 HTTP API；`importer.ts` 解析 Excel；`repository.ts` 持久化批次/任务/步骤日志；`task-worker.ts` 串行执行任务；`zhihu-reader.ts`、`openai-summary.ts`、`media-renderer.ts` 是 pipeline 注入接口的具体适配器。任务状态机：`pending → fetching → summarizing → rendering_images → rendering_video → completed`，任意步骤可转 `failed`/`needs_review`；重试从记录的步骤恢复，不重复上游步骤。
- `apps/web`：React 19 + Vite 工作台，仅"工作台"与"任务记录"两个页面。不得出现登录、用户管理、设置、模板中心、套餐/算力等入口。
- `apps/desktop`：Electron 主进程 + 受限 Preload。安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，页面只能通过白名单 IPC（`desktop:*` channel）访问能力；生产环境页面加载本地构建产物，不暴露本机 HTTP 管理接口。

关键数据流：`POST /api/batches/import`（Excel）→ 批次/任务入库 → `POST /api/batches/:id/start` → `TaskWorker.runTask` → `buildPreparedVideo`（读内容 → AI 摘要 → 校验，唯一决定任务可否渲染的地方）→ `renderVideoAssets`（SVG→1080×1440 PNG→FFmpeg H.264 MP4）→ 产物写入 `outputs/{batchId}/{taskId}/`。

## 必须遵守的约束

- **合规红线**：不绕过知乎登录、付费、访问限制或风控；不保存用户 Cookie、账号密码等凭证到项目数据库。读取登录后页面只能使用用户明确授权的本地浏览器会话。
- **URL 分类有两处实现**：`apps/api/src/importer.ts`（导入校验）与 `packages/pipeline/src/source.ts`（执行前复核）。两者接受的链接形态必须保持一致，修改任一处的正则时必须同步另一处及对应测试。
- **AI 输出契约**：模型必须返回符合 `videoSummaryJsonSchema` 的 JSON；校验失败、内容过短（<3 页）或口令未确认时任务进入 `needs_review`，绝不静默产出成品。Excel 导入的口令优先级高于 AI 生成物，不可被覆盖。
- **视频规则**：封面 1 秒、正文每页 1 秒、尾页 2 秒；正文卡片 3～15 页；卡片一字一校（标题 ≤22 字符、正文 ≤38 字符，以 `validateVideoSummary` 为准）。
- **失败要诚实**：内容读取失败必须分型记录（`SOURCE_NOT_FOUND`/`SOURCE_ACCESS_RESTRICTED`/`CONTENT_EMPTY`/`SOURCE_LAYOUT_CHANGED`/`NETWORK_ERROR`），不允许假装成功；单任务失败不阻塞同批次其他任务。
- **不引入的组件**：Next.js、Remotion、Redis/BullMQ、PostgreSQL、ORM、微服务、云渲染。任务队列就是 SQLite 任务表 + 单进程 Worker。
- 原生模块（better-sqlite3、sharp）在 Electron 打包时需用 `@electron/rebuild` 按目标 ABI 重建。

## 已知缺口（改动前请先读《开发计划.md》对应阶段）

- 知乎内容读取当前是裸 `fetch` 占位实现（`apps/api/src/zhihu-reader.ts`），实测会被知乎风控拦截（403 zse-ck 挑战页）。设计要求是 Playwright Chromium + 分页面类型的解析器（P3 阶段），并保存原始 HTML 快照到任务目录。
- 导入器暂不支持 `www.zhihu.com/question/{id}/answer/{id}` 长链（pipeline 层已支持）。
