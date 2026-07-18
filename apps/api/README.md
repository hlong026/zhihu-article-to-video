# API 服务

这是本机单操作者使用的 Fastify API：负责 Excel 导入、SQLite 批次/任务持久化，以及为内容读取、AI 摘要、图片渲染和视频合成提供可恢复的任务状态接口。本目录不实现知乎抓取、AI 调用或 FFmpeg；这些由后续流水线适配器调用 `TaskRepository.updateTaskExecution()` 推进状态。

## 运行

在仓库根目录安装依赖后：

```bash
pnpm --filter @zhihu-video/api dev
```

默认监听 `http://127.0.0.1:3001`，SQLite 默认写入 `data/zhihu-video.sqlite`。可用 `API_PORT` 和 `DATA_DIR` 覆盖。运行环境要求 Node.js `>=22.13.0`；本模块本身不要求 Chromium、FFmpeg 或 AI 密钥。

## 已提供 API

- `POST /api/batches/import`：上传 `.xlsx`（multipart 字段名 `file`），或发送原始 xlsx body；原始 body 可用 `X-File-Name` 指定文件名。
- `GET /api/batches`、`GET /api/batches/:id`：查询批次、任务和导入行错误。
- `POST /api/batches/:id/start`：将可执行的 `pending` 任务排入 `fetching`。
- `GET /api/tasks/:id`：查询任务详情及步骤日志。
- `PATCH /api/tasks/:id`：编辑 `articleKeyword`、`finalTitle`、`finalTags`、`tailNote`。
- `POST /api/tasks/:id/retry`：仅允许 `failed`/`needs_review` 任务从记录步骤重新排队。

导入接受第一个非空工作表，要求 `链接` 列；可识别 `日期`、`知乎标题`、`文章口令`。只接收知乎回答和专栏 URL。非法行保留在 `importErrors` 中，不会阻塞同批次有效任务。口令为空会创建 `needs_review` 任务，绝不自动发布。

## 任务状态边界

`pending → fetching → summarizing → rendering_images → rendering_video → completed`；任一处理中步骤可以转为 `failed` 或 `needs_review`。重试恢复至 `current_step`，因此不会要求上游步骤重复执行。任务步骤日志存储于 SQLite 的 `task_attempts` 表。

## 验证

```bash
pnpm --filter @zhihu-video/api typecheck
pnpm --filter @zhihu-video/api test
pnpm --filter @zhihu-video/api lint
```
