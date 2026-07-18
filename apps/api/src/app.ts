import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import multipart from "@fastify/multipart";
import { ZipArchive } from "archiver";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";

import { openDatabase } from "./database.js";
import {
  ALLOWED_AUDIO_EXTENSIONS,
  audioContentType,
  bgmUploadsDirectory,
  buildBgmView,
  isSupportedAudioFile,
  listPresets,
  resolveAudioFile,
  resolveAudioOptions,
  uploadedFilePath,
} from "./bgm.js";
import {
  batchExportBaseName,
  buildResultWorkbook,
  taskExportBaseName,
} from "./batch-export.js";
import { parseImportWorkbook } from "./importer.js";
import { OpenAiCompatibleSummaryGenerator } from "./openai-summary.js";
import {
  DEFAULT_BGM_SETTINGS,
  TaskRepository,
  type TaskDownloadInfo,
} from "./repository.js";
import { TaskStateError } from "./task-state.js";
import { TaskWorker } from "./task-worker.js";
import {
  PlaywrightZhihuContentReader,
  readBrowserConfiguration,
} from "./zhihu-playwright-reader.js";

const xlsxContentType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const taskEditSchema = z
  .object({
    articleKeyword: z
      .string()
      .trim()
      .min(2)
      .max(30)
      .refine((value) => !/[\r\n]/.test(value), "文章口令不能换行")
      .optional(),
    finalTitle: z.string().trim().min(1).max(24).optional(),
    finalTags: z
      .array(z.string().trim().min(1).max(20))
      .min(1)
      .max(5)
      .optional(),
    tailNote: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const manualContentSchema = z
  .object({
    title: z.string().trim().min(1, "标题不能为空").max(120),
    content: z.string().trim().min(12, "正文至少 12 个字符"),
  })
  .strict();

const bgmUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    presetId: z.string().trim().min(1).optional(),
    volume: z.number().min(0).max(1).optional(),
    fadeOutSeconds: z.number().min(0).max(10).optional(),
  })
  .strict();

/** Splits pasted article text into paragraphs, preferring blank-line breaks. */
export function splitManualParagraphs(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const byBlankLine = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (byBlankLine.length > 1) return byBlankLine;
  return normalized
    .split("\n")
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export interface BuildAppOptions {
  databasePath: string;
  logger?: boolean;
  taskWorker?: {
    runBatch(batchId: string): Promise<void>;
    runTask(taskId: string): Promise<void>;
  };
  outputDirectory?: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  loadLocalEnvironment();
  const app = Fastify({ logger: options.logger ?? false });
  const database = openDatabase(options.databasePath);
  const repository = new TaskRepository(database);
  // The persistent browser profile lives next to the database so the desktop
  // app keeps the operator's Zhihu session inside its userData directory.
  const contentReader = options.outputDirectory
    ? new PlaywrightZhihuContentReader({
        sessionDirectory: join(
          dirname(options.databasePath),
          "browser-session",
        ),
        ...readBrowserConfiguration(),
      })
    : null;
  const taskWorker =
    options.taskWorker ??
    (contentReader && options.outputDirectory
      ? new TaskWorker(repository, {
          reader: contentReader,
          generator: new OpenAiCompatibleSummaryGenerator(),
          outputDirectory: options.outputDirectory,
          resolveAudio: () =>
            resolveAudioOptions(
              repository.getBgmSettings(),
              options.databasePath,
            ),
        })
      : null);

  app.addContentTypeParser(
    xlsxContentType,
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );
  // Desktop uploads audio as a raw buffer with an x-file-name header, so the
  // common audio containers are parsed straight into a Buffer body.
  for (const audioContentType of [
    "audio/mpeg",
    "audio/mp4",
    "audio/x-m4a",
    "audio/wav",
    "audio/x-wav",
    "application/octet-stream",
  ]) {
    app.addContentTypeParser(
      audioContentType,
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }
  app.register(multipart, { limits: { files: 1, fileSize: 20 * 1024 * 1024 } });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: error.issues[0]?.message ?? "参数校验失败",
      });
    }
    if (error instanceof TaskStateError) {
      return reply
        .status(409)
        .send({ error: "INVALID_TASK_STATE", message: error.message });
    }
    if (error instanceof Error && error.message.startsWith("缺少必填列")) {
      return reply
        .status(400)
        .send({ error: "INVALID_WORKBOOK", message: error.message });
    }
    app.log.error(error, "API 请求失败");
    return reply
      .status(500)
      .send({ error: "INTERNAL_ERROR", message: "服务器处理请求失败" });
  });

  app.post("/api/batches/import", async (request, reply) => {
    const uploaded = await readUpload(request);
    if (!uploaded) {
      return reply
        .status(400)
        .send({ error: "MISSING_FILE", message: "请上传 .xlsx 文件" });
    }
    if (!uploaded.fileName.toLowerCase().endsWith(".xlsx")) {
      return reply
        .status(400)
        .send({ error: "INVALID_FILE", message: "仅支持 .xlsx 文件" });
    }
    const parsed = await parseImportWorkbook(uploaded.contents);
    const batch = repository.createBatch(
      uploaded.fileName,
      parsed.tasks,
      parsed.errors,
    );
    return reply.status(201).send(batch);
  });

  app.get("/api/batches", async () => repository.listBatches());

  app.get<{ Params: { id: string } }>(
    "/api/batches/:id",
    async (request, reply) => {
      const batch = repository.getBatch(request.params.id);
      return (
        batch ??
        reply
          .status(404)
          .send({ error: "BATCH_NOT_FOUND", message: "批次不存在" })
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/batches/:id/start",
    async (request, reply) => {
      const batch = repository.startBatch(request.params.id);
      if (batch && taskWorker) {
        void taskWorker.runBatch(batch.id).catch((error: unknown) => {
          app.log.error(error, "批次任务执行失败");
        });
      }
      return (
        batch ??
        reply
          .status(404)
          .send({ error: "BATCH_NOT_FOUND", message: "批次不存在" })
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/batches/:id/download",
    async (request, reply) => {
      const batch = repository.getBatch(request.params.id);
      if (!batch) {
        return reply
          .status(404)
          .send({ error: "BATCH_NOT_FOUND", message: "批次不存在" });
      }
      const tasks = repository.listBatchTaskExports(request.params.id);
      const exportable = tasks
        .map((task, index) => ({ task, index }))
        .filter(
          ({ task }) => task.status === "completed" && task.outputDirectory,
        )
        .filter(({ task }) =>
          isInsideOutputRoot(task.outputDirectory!, options.outputDirectory),
        );
      if (exportable.length === 0) {
        return reply.status(409).send({
          error: "BATCH_NOT_COMPLETED",
          message: "批次内暂无已完成任务，可先下载结果表查看进度。",
        });
      }
      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on("error", (error) => app.log.error(error, "批次 ZIP 打包失败"));
      archive.append(await buildResultWorkbook(tasks), { name: "result.xlsx" });
      for (const { task, index } of exportable) {
        const baseName = taskExportBaseName(task, index);
        const outputDirectory = resolve(task.outputDirectory!);
        const videoPath = join(outputDirectory, "video.mp4");
        if (existsSync(videoPath)) {
          archive.file(videoPath, { name: `${baseName}/video.mp4` });
        }
        const imagesDirectory = join(outputDirectory, "images");
        if (existsSync(imagesDirectory)) {
          archive.directory(imagesDirectory, `${baseName}/images`);
        }
      }
      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        contentDisposition(
          `${batchExportBaseName(batch.sourceFileName)}-成品.zip`,
        ),
      );
      reply.send(archive);
      void archive.finalize();
      return reply;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/batches/:id/result.xlsx",
    async (request, reply) => {
      const batch = repository.getBatch(request.params.id);
      if (!batch) {
        return reply
          .status(404)
          .send({ error: "BATCH_NOT_FOUND", message: "批次不存在" });
      }
      const tasks = repository.listBatchTaskExports(request.params.id);
      const workbookBuffer = await buildResultWorkbook(tasks);
      reply.header("content-type", xlsxContentType);
      reply.header(
        "content-disposition",
        contentDisposition(
          `${batchExportBaseName(batch.sourceFileName)}-result.xlsx`,
        ),
      );
      return reply.send(workbookBuffer);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const task = repository.getTask(request.params.id);
      return (
        task ??
        reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" })
      );
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const input = taskEditSchema.parse(request.body);
      const task = repository.editTask(request.params.id, input);
      return (
        task ??
        reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" })
      );
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/tasks/:id/manual-content",
    async (request, reply) => {
      const input = manualContentSchema.parse(request.body);
      const task = repository.getTask(request.params.id);
      if (!task) {
        return reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
      }
      if (task.status !== "failed" && task.status !== "needs_review") {
        return reply.status(409).send({
          error: "INVALID_TASK_STATE",
          message: "只有失败或需人工确认的任务可以录入正文。",
        });
      }
      const paragraphs = splitManualParagraphs(input.content);
      if (paragraphs.length === 0) {
        return reply
          .status(400)
          .send({ error: "VALIDATION_ERROR", message: "正文内容为空。" });
      }
      return repository.saveManualContent(task.id, {
        title: input.title,
        paragraphs,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/retry",
    async (request, reply) => {
      const task = repository.retryTask(request.params.id);
      if (task && taskWorker) {
        void taskWorker.runTask(task.id).catch((error: unknown) => {
          app.log.error(error, "任务重试执行失败");
        });
      }
      return (
        task ??
        reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" })
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/download/video",
    async (request, reply) => {
      const task = repository.getTaskDownloadInfo(request.params.id);
      if (!task) {
        return reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
      }
      const outputDirectory = downloadableOutputDirectory(
        task,
        options.outputDirectory,
      );
      if (typeof outputDirectory === "number") {
        return reply.status(outputDirectory).send(downloadErrorBody(task));
      }
      const videoPath = join(outputDirectory, "video.mp4");
      if (!existsSync(videoPath)) {
        return reply.status(404).send({
          error: "ARTIFACT_NOT_FOUND",
          message: "视频文件不存在，可能已被清理，请重试该任务。",
        });
      }
      reply.header("content-type", "video/mp4");
      reply.header(
        "content-disposition",
        contentDisposition(downloadFileName(task.finalTitle, task.id, ".mp4")),
      );
      return reply.send(createReadStream(videoPath));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/download/images",
    async (request, reply) => {
      const task = repository.getTaskDownloadInfo(request.params.id);
      if (!task) {
        return reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
      }
      const outputDirectory = downloadableOutputDirectory(
        task,
        options.outputDirectory,
      );
      if (typeof outputDirectory === "number") {
        return reply.status(outputDirectory).send(downloadErrorBody(task));
      }
      const imagesDirectory = join(outputDirectory, "images");
      const files = await readdir(imagesDirectory).catch(() => [] as string[]);
      if (!files.some((file) => file.toLowerCase().endsWith(".png"))) {
        return reply.status(404).send({
          error: "ARTIFACT_NOT_FOUND",
          message: "图片产物不存在，可能已被清理，请重试该任务。",
        });
      }
      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on("error", (error) => app.log.error(error, "图片 ZIP 打包失败"));
      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        contentDisposition(downloadFileName(task.finalTitle, task.id, ".zip")),
      );
      reply.send(archive);
      archive.directory(imagesDirectory, "images");
      void archive.finalize();
      return reply;
    },
  );

  app.get("/api/settings/bgm", async () =>
    buildBgmView(repository.getBgmSettings(), options.databasePath),
  );

  app.get("/api/settings/bgm/preview", async (_request, reply) => {
    const path = resolveAudioFile(
      repository.getBgmSettings(),
      options.databasePath,
    );
    if (!path) {
      return reply
        .status(404)
        .send({ error: "AUDIO_NOT_FOUND", message: "当前没有可试听的背景音乐。" });
    }
    reply.header("content-type", audioContentType(path));
    reply.header("cache-control", "no-store");
    return reply.send(createReadStream(path));
  });

  app.put("/api/settings/bgm", async (request, reply) => {
    const input = bgmUpdateSchema.parse(request.body);
    const next = { ...repository.getBgmSettings(), ...input };
    if (input.presetId !== undefined) {
      const preset = listPresets().find((item) => item.id === input.presetId);
      if (!preset) {
        return reply
          .status(400)
          .send({ error: "PRESET_NOT_FOUND", message: "所选背景音乐预设不存在" });
      }
      next.source = "preset";
      next.presetId = preset.id;
      next.fileName = preset.name;
    }
    const saved = repository.saveBgmSettings(next);
    return buildBgmView(saved, options.databasePath);
  });

  app.post("/api/settings/bgm/upload", async (request, reply) => {
    const uploaded = await readUpload(request);
    if (!uploaded) {
      return reply
        .status(400)
        .send({ error: "MISSING_FILE", message: "请上传音频文件" });
    }
    if (!isSupportedAudioFile(uploaded.fileName)) {
      return reply.status(400).send({
        error: "INVALID_FILE",
        message: "仅支持 mp3 / m4a / wav 音频文件",
      });
    }
    const directory = bgmUploadsDirectory(options.databasePath);
    await mkdir(directory, { recursive: true });
    const targetPath = uploadedFilePath(options.databasePath, uploaded.fileName);
    // A new upload replaces any prior track, including one with another
    // extension, so only a single "current" file ever remains on disk.
    for (const extension of ALLOWED_AUDIO_EXTENSIONS) {
      const previous = join(directory, `current${extension}`);
      if (previous !== targetPath && existsSync(previous)) {
        await rm(previous, { force: true });
      }
    }
    await writeFile(targetPath, uploaded.contents);
    const saved = repository.saveBgmSettings({
      ...repository.getBgmSettings(),
      enabled: true,
      source: "upload",
      presetId: null,
      fileName: uploaded.fileName,
    });
    return buildBgmView(saved, options.databasePath);
  });

  app.delete("/api/settings/bgm", async () => {
    const directory = bgmUploadsDirectory(options.databasePath);
    for (const extension of ALLOWED_AUDIO_EXTENSIONS) {
      const previous = join(directory, `current${extension}`);
      if (existsSync(previous)) await rm(previous, { force: true });
    }
    const saved = repository.saveBgmSettings({ ...DEFAULT_BGM_SETTINGS });
    return buildBgmView(saved, options.databasePath);
  });

  app.addHook("onClose", async () => {
    await contentReader?.close();
    database.close();
  });
  return app;
}

/**
 * Resolves the on-disk artifact directory for a completed task, guarding
 * against rows whose stored path escapes the configured output root.
 * Returns an HTTP status code when the task is not downloadable.
 */
function downloadableOutputDirectory(
  task: TaskDownloadInfo,
  outputRoot: string | undefined,
): string | 404 | 409 {
  if (task.status !== "completed") return 409;
  if (!task.outputDirectory) return 404;
  if (!isInsideOutputRoot(task.outputDirectory, outputRoot)) return 404;
  return resolve(task.outputDirectory);
}

function isInsideOutputRoot(
  directory: string,
  outputRoot: string | undefined,
): boolean {
  if (!outputRoot) return true;
  const root = resolve(outputRoot);
  const resolved = resolve(directory);
  return resolved === root || resolved.startsWith(`${root}${sep}`);
}

function downloadErrorBody(task: TaskDownloadInfo): {
  error: string;
  message: string;
} {
  if (task.status !== "completed") {
    return {
      error: "TASK_NOT_COMPLETED",
      message: "任务尚未生成成品，无法下载。",
    };
  }
  return {
    error: "ARTIFACT_NOT_FOUND",
    message: "未找到成品目录，可能已被清理，请重试该任务。",
  };
}

function downloadFileName(
  finalTitle: string | null,
  taskId: string,
  extension: string,
): string {
  const base = (finalTitle ?? "").replace(/[\\/:*?"<>|\r\n]+/g, "-").trim();
  const trimmed = base.length > 0 ? base.slice(0, 50) : taskId;
  return `${trimmed}${extension}`;
}

/** RFC 5987 attachment header with an ASCII fallback for older clients. */
function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x21\x23-\x7e]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function loadLocalEnvironment(): void {
  // The dev scripts run with apps/api as the working directory while the
  // operator keeps secrets in the workspace-root .env, so try both.
  for (const candidate of [".env", join("..", "..", ".env")]) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function readUpload(request: {
  isMultipart: () => boolean;
  file: () => Promise<unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}): Promise<{ fileName: string; contents: Buffer } | null> {
  if (request.isMultipart()) {
    const part = (await request.file()) as
      | {
          filename?: string;
          mimetype?: string;
          toBuffer: () => Promise<Buffer>;
        }
      | undefined;
    if (!part) return null;
    return {
      fileName: part.filename || "import.xlsx",
      contents: await part.toBuffer(),
    };
  }
  if (!Buffer.isBuffer(request.body)) return null;
  const headerName = request.headers["x-file-name"];
  const fileName = typeof headerName === "string" ? headerName : "import.xlsx";
  return { fileName, contents: request.body };
}
