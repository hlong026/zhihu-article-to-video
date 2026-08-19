import { createReadStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import multipart from "@fastify/multipart";
import { ZipArchive } from "archiver";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";

import type {
  AiSettingsView,
  ImageExportRatio,
  ProcessingSettings,
  TaskArtifactsSummary,
} from "@zhihu-video/contracts";
import {
  paginateParagraphs,
  truncateVideoTitle,
  writePngCardsAtRatio,
  type VideoSummary,
} from "@zhihu-video/pipeline";

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
import {
  OpenAiCompatibleSummaryGenerator,
  defaultAiBaseUrl,
  defaultAiModel,
  resolveAiConfiguration,
} from "./openai-summary.js";
import { resolveBrowserLaunch } from "./browser-resolver.js";
import { resolveFfmpegExecutable } from "./ffmpeg-resolver.js";
import {
  DEFAULT_BGM_SETTINGS,
  TaskRepository,
  type TaskDownloadInfo,
} from "./repository.js";
import { TaskStateError } from "./task-state.js";
import {
  TaskWorker,
  readSnapshotContent,
  type RerenderTailResult,
} from "./task-worker.js";
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

const importRangeQuerySchema = z
  .object({
    startRow: z.coerce.number().int().min(1).optional(),
    endRow: z.coerce.number().int().min(1).optional(),
  })
  .refine(
    (value) =>
      value.startRow === undefined ||
      value.endRow === undefined ||
      value.startRow <= value.endRow,
    { message: "导入起始条数不能大于结束条数" },
  );

const bgmUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    presetId: z.string().trim().min(1).optional(),
    volume: z.number().min(0).max(1).optional(),
    fadeOutSeconds: z.number().min(0).max(10).optional(),
  })
  .strict();

const processingUpdateSchema = z
  .object({
    concurrency: z
      .number()
      .int()
      .refine((value) => [5, 10, 15, 20].includes(value), {
        message: "并发数仅支持 5 / 10 / 15 / 20",
      })
      .optional(),
    coverPageDurationSeconds: z
      .number()
      .int()
      .refine((value) => [1, 2, 3, 4, 5].includes(value), {
        message: "封面页时长仅支持 1 / 2 / 3 / 4 / 5 秒",
      })
      .optional(),
    bodyPageDurationSeconds: z
      .number()
      .int()
      .refine((value) => [3, 4, 5, 6].includes(value), {
        message: "正文页时长仅支持 3 / 4 / 5 / 6 秒",
      })
      .optional(),
    fullContentOutput: z.boolean().optional(),
    videoMode: z.enum(["slide", "scroll"]).optional(),
    scrollSpeed: z.number().int().min(1).max(5).optional(),
    imageExportRatio: z.enum(["9:16", "3:4"]).optional(),
    hideInteractionButtons: z.boolean().optional(),
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
    rerenderTail?(taskId: string): Promise<RerenderTailResult>;
    abortTask?(taskId: string): Promise<boolean>;
  };
  outputDirectory?: string;
  /** Absolute path of the Chromium executable bundled with the desktop app. */
  bundledChromiumExecutable?: string;
  /** Absolute path of the FFmpeg executable bundled with the desktop app. */
  bundledFfmpegExecutable?: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  loadLocalEnvironment();
  const app = Fastify({ logger: options.logger ?? false });
  const database = openDatabase(options.databasePath);
  const repository = new TaskRepository(database);
  // The persistent browser profile lives next to the database so the desktop
  // app keeps the operator's Zhihu session inside its userData directory.
  const browserConfig = readBrowserConfiguration();
  const browserResolution = resolveBrowserLaunch({
    explicitExecutablePath: browserConfig.executablePath,
    explicitChannel: browserConfig.channel,
    bundledExecutablePath:
      options.bundledChromiumExecutable ??
      process.env.ZHIHU_BUNDLED_CHROMIUM_EXECUTABLE?.trim() ??
      undefined,
  });
  for (const warning of browserResolution.warnings) {
    app.log.warn({ warning }, "zhihu reader browser fallback");
  }
  if (options.outputDirectory) {
    app.log.info(
      {
        source: browserResolution.source,
        channel: browserResolution.channel,
        executablePath: browserResolution.executablePath,
      },
      "zhihu reader browser resolved",
    );
  }
  const contentReader = options.outputDirectory
    ? new PlaywrightZhihuContentReader({
        sessionDirectory: join(
          dirname(options.databasePath),
          "browser-session",
        ),
        channel: browserResolution.channel,
        executablePath: browserResolution.executablePath,
        headless: browserConfig.headless,
        minIntervalMs: browserConfig.minIntervalMs,
        interactiveWaitMs: browserConfig.interactiveWaitMs,
        onEscalate: (reason) =>
          app.log.warn(
            { reason },
            "zhihu reader escalated to a visible browser window",
          ),
        onInteractiveWait: (reason) =>
          app.log.warn(
            { reason },
            "zhihu reader waiting for operator login/verification",
          ),
      })
    : null;
  const ffmpegExecutable = resolveFfmpegExecutable(
    options.bundledFfmpegExecutable ??
      process.env.ZHIHU_BUNDLED_FFMPEG_EXECUTABLE?.trim() ??
      undefined,
  );
  const taskWorker =
    options.taskWorker ??
    (contentReader && options.outputDirectory
      ? new TaskWorker(repository, {
          reader: contentReader,
          generator: new OpenAiCompatibleSummaryGenerator(() =>
            resolveAiConfiguration(repository.getAiSettings()),
          ),
          outputDirectory: options.outputDirectory,
          ffmpegExecutable,
          resolveAudio: () =>
            resolveAudioOptions(
              repository.getBgmSettings(),
              options.databasePath,
            ),
          resolveConcurrency: () => {
            // TASK_CONCURRENCY overrides the stored setting (any 1-20 int);
            // the UI offers the 5/10/15/20 presets persisted in SQLite.
            const override = Number(process.env.TASK_CONCURRENCY);
            if (Number.isInteger(override) && override >= 1) {
              return Math.min(20, override);
            }
            return repository.getProcessingSettings().concurrency;
          },
          resolveVideoSettings: () => {
            const settings = repository.getProcessingSettings();
            return {
              coverPageDurationSeconds: settings.coverPageDurationSeconds,
              bodyPageDurationSeconds: settings.bodyPageDurationSeconds,
              fullContentOutput: settings.fullContentOutput,
              videoMode: settings.videoMode,
              scrollSpeed: settings.scrollSpeed,
            };
          },
        })
      : null);

  /**
   * Re-renders a completed task's card images at the requested aspect ratio,
   * rebuilding the summary from the persisted article snapshot. Returns the
   * directory holding the freshly rendered PNGs, or null when the task has
   * no reusable snapshot/keyword (caller should fall back to existing PNGs).
   */
  const renderExportImages = async (
    taskId: string,
    outputDirectory: string,
    ratio: ImageExportRatio,
    hideButtons: boolean,
    fullContentOutput: boolean,
    tempRoot: string,
  ): Promise<string | null> => {
    const task = repository.getTask(taskId);
    if (!task) return null;
    const keyword = task.articleKeyword?.trim();
    if (!keyword) return null;
    const snapshot = task.manualContent
      ? null
      : await readSnapshotContent(outputDirectory);
    const content = task.manualContent ?? snapshot;
    if (!content) return null;
    // 3:4 canvas is shorter, so fewer lines fit per body page.
    const { pages, truncated } = paginateParagraphs(content.paragraphs, {
      linesPerPage: ratio === "3:4" ? 14 : undefined,
      maxPages: fullContentOutput ? Number.POSITIVE_INFINITY : undefined,
    });
    const summary: VideoSummary = {
      sourceTitle: content.title,
      videoTitle: task.finalTitle ?? truncateVideoTitle(content.title),
      tags: task.finalTags,
      pages,
      truncated,
      riskFlags: [],
      coverMeta: snapshot?.meta ?? null,
    };
    const targetDir = join(tempRoot, taskId);
    await writePngCardsAtRatio(
      targetDir,
      summary,
      keyword,
      ratio,
      hideButtons,
      task.tailNoteTemplate,
    );
    return targetDir;
  };

  /**
   * Creates the per-request temp directory for image re-renders and hooks its
   * cleanup to the archive lifecycle (archiver reads files lazily during
   * finalize, so the directory must outlive the response setup).
   */
  const createExportTempRoot = (archive: ZipArchive): string => {
    const tempRoot = join(
      options.outputDirectory ?? tmpdir(),
      `.export-images-${randomUUID()}`,
    );
    const cleanup = () =>
      rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    archive.once("end", cleanup);
    archive.once("error", cleanup);
    return tempRoot;
  };

  /**
   * Resolves the directory whose PNGs should be archived for a completed
   * task: the renders produced at task time on the 9:16 fast path, otherwise
   * a fresh re-render at the configured ratio (falling back to existing
   * PNGs when the snapshot or keyword is unavailable).
   */
  const resolveExportImagesDir = async (
    taskId: string,
    outputDirectory: string,
    settings: ProcessingSettings,
    tempRoot: string,
  ): Promise<string | null> => {
    const existingImagesDir = join(outputDirectory, "images");
    const hasExistingImages =
      existsSync(existingImagesDir) &&
      (await readdir(existingImagesDir).catch(() => [] as string[])).some(
        (file) => file.toLowerCase().endsWith(".png"),
      );
    // Fast path: reuse the renders produced at task time when they already
    // match the requested output (9:16 with decorative buttons visible).
    if (
      settings.imageExportRatio === "9:16" &&
      !settings.hideInteractionButtons &&
      hasExistingImages
    ) {
      return existingImagesDir;
    }
    let rendered: string | null = null;
    try {
      rendered = await renderExportImages(
        taskId,
        outputDirectory,
        settings.imageExportRatio,
        settings.hideInteractionButtons,
        settings.fullContentOutput,
        tempRoot,
      );
    } catch (error) {
      app.log.warn(error, `任务 ${taskId} 图片重渲染失败，回退现有图片`);
    }
    if (rendered) return rendered;
    return hasExistingImages ? existingImagesDir : null;
  };

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

  app.post<{ Querystring: { startRow?: string; endRow?: string } }>(
    "/api/batches/import",
    async (request, reply) => {
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
      const range = importRangeQuerySchema.parse(request.query);
      const parsed = await parseImportWorkbook(uploaded.contents, {
        start: range.startRow,
        end: range.endRow,
      });
      const batch = repository.createBatch(
        uploaded.fileName,
        parsed.tasks,
        parsed.errors,
      );
      return reply.status(201).send(batch);
    },
  );

  // Dry-run counterpart of the import route: parses the workbook and reports
  // row counts without persisting anything, so the UI can offer a row-range
  // selector before the operator confirms the import.
  app.post("/api/batches/import/preview", async (request, reply) => {
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
    return {
      totalDataRows: parsed.totalDataRows,
      validCount: parsed.tasks.length,
      errorCount: parsed.errors.length,
      sample: parsed.tasks.slice(0, 5).map((task) => ({
        rowNumber: task.rowNumber,
        sourceUrl: task.sourceUrl,
        inputTitle: task.inputTitle,
        hasKeyword: Boolean(task.articleKeyword),
      })),
    };
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

  // Cancel/stop a task that is currently being processed.
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/abort",
    async (request, reply) => {
      if (!taskWorker) {
        return reply.status(501).send({
          error: "NOT_CONFIGURED",
          message: "任务系统未配置，无法执行操作。",
        });
      }
      const task = repository.getTask(request.params.id);
      if (!task) {
        return reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
      }
      const activeStatuses = [
        "fetching",
        "summarizing",
        "rendering_images",
        "rendering_video",
      ];
      if (!activeStatuses.includes(task.status)) {
        return reply.status(409).send({
          error: "TASK_NOT_ACTIVE",
          message: "当前任务状态不可中断，仅支持处理中的任务。",
        });
      }
      const abortResult = await taskWorker.abortTask?.(request.params.id);
      return abortResult
        ? { ok: true }
        : reply.status(500).send({
            error: "ABORT_FAILED",
            message: "终止任务失败，请查看日志详情。",
          });
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
      const settings = repository.getProcessingSettings();
      const tempRoot = createExportTempRoot(archive);
      for (const { task, index } of exportable) {
        const baseName = taskExportBaseName(task, index);
        const outputDirectory = resolve(task.outputDirectory!);
        const videoPath = join(outputDirectory, "video.mp4");
        if (existsSync(videoPath)) {
          archive.file(videoPath, { name: `${baseName}/video.mp4` });
        }
        const imagesDir = await resolveExportImagesDir(
          task.id,
          outputDirectory,
          settings,
          tempRoot,
        );
        if (imagesDir) {
          archive.directory(imagesDir, `${baseName}/images`);
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

  // Downloads only the video files of all completed tasks in a batch.
  app.get<{ Params: { id: string } }>(
    "/api/batches/:id/download-videos",
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
          message: "批次内暂无已完成任务，无法下载视频。",
        });
      }
      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on("error", (error) =>
        app.log.error(error, "批次视频 ZIP 打包失败"),
      );
      for (const { task, index } of exportable) {
        const baseName = taskExportBaseName(task, index);
        const outputDirectory = resolve(task.outputDirectory!);
        const videoPath = join(outputDirectory, "video.mp4");
        if (existsSync(videoPath)) {
          archive.file(videoPath, { name: `${baseName}.mp4` });
        }
      }
      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        contentDisposition(
          `${batchExportBaseName(batch.sourceFileName)}-全部视频.zip`,
        ),
      );
      reply.send(archive);
      void archive.finalize();
      return reply;
    },
  );

  // Downloads all rendered images of all completed tasks in a batch.
  app.get<{ Params: { id: string } }>(
    "/api/batches/:id/download-images",
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
          message: "批次内暂无已完成任务，无法下载图片。",
        });
      }

      const settings = repository.getProcessingSettings();
      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on("error", (error) =>
        app.log.error(error, "批次图片 ZIP 打包失败"),
      );
      const tempRoot = createExportTempRoot(archive);

      for (const { task, index } of exportable) {
        const baseName = taskExportBaseName(task, index);
        const outputDirectory = resolve(task.outputDirectory!);
        const imagesDir = await resolveExportImagesDir(
          task.id,
          outputDirectory,
          settings,
          tempRoot,
        );
        if (imagesDir) {
          archive.directory(imagesDir, `${baseName}/images`);
        }
      }

      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        contentDisposition(
          `${batchExportBaseName(batch.sourceFileName)}-全部图片.zip`,
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

  app.delete<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const task = repository.getTask(request.params.id);
      if (!task) {
        return reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
      }
      const activeStatuses = [
        "fetching",
        "summarizing",
        "rendering_images",
        "rendering_video",
      ];
      if (activeStatuses.includes(task.status)) {
        return reply.status(409).send({
          error: "TASK_IN_PROGRESS",
          message: "任务正在处理中，无法删除。请等待完成或失败后再操作。",
        });
      }
      const result = repository.deleteTask(request.params.id);
      if (result?.outputDirectory) {
        const dir = resolve(result.outputDirectory);
        if (isInsideOutputRoot(dir, options.outputDirectory)) {
          await rm(dir, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      }
      return { ok: true };
    },
  );

  const batchDeleteSchema = z
    .object({ taskIds: z.array(z.string().min(1)).min(1).max(200) })
    .strict();

  app.post("/api/tasks/batch-delete", async (request, reply) => {
    const { taskIds } = batchDeleteSchema.parse(request.body);
    // Verify none are actively processing
    const activeStatuses = [
      "fetching",
      "summarizing",
      "rendering_images",
      "rendering_video",
    ];
    for (const taskId of taskIds) {
      const task = repository.getTask(taskId);
      if (task && activeStatuses.includes(task.status)) {
        return reply.status(409).send({
          error: "TASK_IN_PROGRESS",
          message: `任务「${task.fetchedTitle ?? task.inputTitle ?? taskId}」正在处理中，无法删除。`,
        });
      }
    }
    const { deletedCount, outputDirectories } = repository.deleteTasks(taskIds);
    // Clean up artifact directories
    for (const dir of outputDirectories) {
      const resolved = resolve(dir);
      if (isInsideOutputRoot(resolved, options.outputDirectory)) {
        await rm(resolved, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
    return { ok: true, deletedCount };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/batches/:id",
    async (request, reply) => {
      const batch = repository.getBatch(request.params.id);
      if (!batch) {
        return reply
          .status(404)
          .send({ error: "BATCH_NOT_FOUND", message: "批次不存在" });
      }
      // Block deletion if any task is actively processing
      const activeStatuses = [
        "fetching",
        "summarizing",
        "rendering_images",
        "rendering_video",
      ];
      const hasActive = batch.tasks.some((task) =>
        activeStatuses.includes(task.status),
      );
      if (hasActive) {
        return reply.status(409).send({
          error: "BATCH_IN_PROGRESS",
          message: "批次内仍有任务正在处理中，无法删除整个批次。",
        });
      }
      const result = repository.deleteBatch(request.params.id);
      if (result) {
        for (const dir of result.outputDirectories) {
          const resolved = resolve(dir);
          if (isInsideOutputRoot(resolved, options.outputDirectory)) {
            await rm(resolved, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
        }
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const task = repository.getTask(request.params.id);
      if (!task) {
        return reply
          .status(404)
          .send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
      }
      const artifacts = await loadTaskArtifacts(
        task.id,
        repository,
        options.outputDirectory,
      );
      return { ...task, artifacts };
    },
  );

  // Re-renders only the tail page (and repacks the video) after the operator
  // corrects the article keyword. The article snapshot is reused, so neither
  // the browser nor the AI runs again and the cover stays untouched.
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/rerender-tail",
    async (request, reply) => {
      if (!taskWorker?.rerenderTail) {
        return reply.status(503).send({
          error: "WORKER_UNAVAILABLE",
          message: "任务执行器不可用。",
        });
      }
      const result = await taskWorker.rerenderTail(request.params.id);
      if (!result.ok) {
        const status =
          result.code === "TASK_NOT_FOUND"
            ? 404
            : result.code === "RENDER_FAILED"
              ? 500
              : 409;
        return reply
          .status(status)
          .send({ error: result.code, message: result.message });
      }
      return repository.getTask(request.params.id);
    },
  );

  // Streams the first rendered card (the cover) for in-app previews.
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/preview-image",
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
      const cover = (await readdir(imagesDirectory).catch(() => [] as string[]))
        .filter((file) => file.toLowerCase().endsWith(".png"))
        .sort()[0];
      if (!cover) {
        return reply.status(404).send({
          error: "ARTIFACT_NOT_FOUND",
          message: "图片产物不存在，可能已被清理，请重试该任务。",
        });
      }
      reply.header("content-type", "image/png");
      reply.header("cache-control", "no-store");
      return reply.send(createReadStream(join(imagesDirectory, cover)));
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
      const settings = repository.getProcessingSettings();
      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on("error", (error) => app.log.error(error, "图片 ZIP 打包失败"));
      const tempRoot = createExportTempRoot(archive);
      const imagesDirectory = await resolveExportImagesDir(
        task.id,
        outputDirectory,
        settings,
        tempRoot,
      );
      if (!imagesDirectory) {
        return reply.status(404).send({
          error: "ARTIFACT_NOT_FOUND",
          message: "图片产物不存在，可能已被清理，请重试该任务。",
        });
      }
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
        .send({
          error: "AUDIO_NOT_FOUND",
          message: "当前没有可试听的背景音乐。",
        });
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
          .send({
            error: "PRESET_NOT_FOUND",
            message: "所选背景音乐预设不存在",
          });
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
    const targetPath = uploadedFilePath(
      options.databasePath,
      uploaded.fileName,
    );
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

  app.get("/api/settings/processing", async () =>
    repository.getProcessingSettings(),
  );

  app.put("/api/settings/processing", async (request) => {
    const input = processingUpdateSchema.parse(request.body);
    const current = repository.getProcessingSettings();
    return repository.saveProcessingSettings({
      concurrency: input.concurrency ?? current.concurrency,
      coverPageDurationSeconds:
        input.coverPageDurationSeconds ?? current.coverPageDurationSeconds,
      bodyPageDurationSeconds:
        input.bodyPageDurationSeconds ?? current.bodyPageDurationSeconds,
      fullContentOutput: input.fullContentOutput ?? current.fullContentOutput,
      videoMode: input.videoMode ?? current.videoMode,
      scrollSpeed: input.scrollSpeed ?? current.scrollSpeed,
      imageExportRatio: input.imageExportRatio ?? current.imageExportRatio,
      hideInteractionButtons:
        input.hideInteractionButtons ?? current.hideInteractionButtons,
    });
  });

  app.get("/api/settings/ai", async (): Promise<AiSettingsView> => {
    const settings = repository.getAiSettings();
    const resolved = resolveAiConfiguration(settings);
    return {
      ...settings,
      effectiveBaseUrl: resolved?.baseUrl ?? defaultAiBaseUrl,
      effectiveModel: resolved?.model ?? defaultAiModel,
      configured: resolved !== null,
    };
  });

  const aiUpdateSchema = z
    .object({
      apiKey: z.string().max(500).nullish(),
      baseUrl: z.string().max(300).nullish(),
      model: z.string().max(100).nullish(),
    })
    .strict();

  app.put("/api/settings/ai", async (request): Promise<AiSettingsView> => {
    const input = aiUpdateSchema.parse(request.body);
    const current = repository.getAiSettings();
    const trimOrNull = (
      v: string | null | undefined,
      fallback: string | null,
    ) => (v === undefined ? fallback : (v ?? "").trim() || null);
    const next = {
      apiKey: trimOrNull(input.apiKey, current.apiKey),
      baseUrl: trimOrNull(input.baseUrl, current.baseUrl),
      model: trimOrNull(input.model, current.model),
    };
    const saved = repository.saveAiSettings(next);
    const resolved = resolveAiConfiguration(saved);
    return {
      ...saved,
      effectiveBaseUrl: resolved?.baseUrl ?? defaultAiBaseUrl,
      effectiveModel: resolved?.model ?? defaultAiModel,
      configured: resolved !== null,
    };
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
 * Computes the artifact summary shown in detail panels: rendered card count,
 * whether the video exists, and the duration written by the renderer. Legacy
 * outputs without a manifest retain the former card-based fallback.
 */
async function loadTaskArtifacts(
  taskId: string,
  repository: TaskRepository,
  outputRoot: string | undefined,
): Promise<TaskArtifactsSummary | null> {
  const info = repository.getTaskDownloadInfo(taskId);
  if (!info?.outputDirectory) return null;
  if (!isInsideOutputRoot(info.outputDirectory, outputRoot)) return null;
  const outputDirectory = resolve(info.outputDirectory);
  const files = await readdir(join(outputDirectory, "images")).catch(
    () => [] as string[],
  );
  const imageCount = files.filter((file) =>
    file.toLowerCase().endsWith(".png"),
  ).length;
  const videoReady = existsSync(join(outputDirectory, "video.mp4"));
  if (imageCount === 0 && !videoReady) return null;
  const persistedDuration = await readPersistedRenderDuration(outputDirectory);
  if (persistedDuration !== null) {
    return { imageCount, videoReady, durationSeconds: persistedDuration };
  }

  // Outputs rendered before render-manifest.json was introduced have no
  // recorded timing. Keep the best-effort calculation for those artifacts;
  // all new outputs use the exact encoder duration above.
  const settings = repository.getProcessingSettings();
  const coverDuration = settings.coverPageDurationSeconds;
  const bodyDuration = settings.bodyPageDurationSeconds;
  // Slide: cover + body pages. Scroll: total strip height / scroll speed.
  const durationSeconds =
    imageCount >= 1
      ? settings.videoMode === "scroll"
        ? Math.ceil((imageCount * 1920) / (settings.scrollSpeed * 100))
        : coverDuration + (imageCount - 1) * bodyDuration
      : 0;
  return { imageCount, videoReady, durationSeconds };
}

/** Reads a renderer-owned duration manifest, rejecting malformed disk data. */
async function readPersistedRenderDuration(
  outputDirectory: string,
): Promise<number | null> {
  try {
    const raw = await readFile(join(outputDirectory, "render-manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { durationSeconds?: unknown };
    return typeof parsed.durationSeconds === "number" &&
      Number.isFinite(parsed.durationSeconds) &&
      parsed.durationSeconds > 0
      ? parsed.durationSeconds
      : null;
  } catch {
    return null;
  }
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
