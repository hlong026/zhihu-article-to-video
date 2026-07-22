import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { scrollSpeedDefault } from "@zhihu-video/contracts";
import {
  buildPreparedVideo,
  paginateParagraphs,
  truncateVideoTitle,
  validateVideoSummary,
  type FfmpegAudioOptions,
  type SourcePageMeta,
  type SummaryGenerator,
  type VideoSummary,
  type ZhihuContentReader,
} from "@zhihu-video/pipeline";

import { renderVideoAssets } from "./media-renderer.js";
import { TaskRepository } from "./repository.js";

export type RerenderTailResult =
  { ok: true } | { ok: false; code: string; message: string };

export class TaskWorker {
  constructor(
    private readonly repository: TaskRepository,
    private readonly dependencies: {
      reader: ZhihuContentReader;
      generator: SummaryGenerator;
      outputDirectory: string;
      /** Resolves the background-music track for each render, if configured. */
      resolveAudio?: () => FfmpegAudioOptions | null;
      /**
       * Resolves the batch lane count at start time. The Zhihu reader stays
       * serial internally, so concurrency only widens AI calls and rendering.
       */
      resolveConcurrency?: () => number;
      /**
       * Resolves the operator's video output preferences (body-page dwell
       * time and full-content mode) at render time.
       */
      resolveVideoSettings?: () => {
        coverPageDurationSeconds: number;
        bodyPageDurationSeconds: number;
        fullContentOutput: boolean;
        videoMode: "slide" | "scroll";
        scrollSpeed: number;
      };
      /** Resolved FFmpeg executable path (bundled or system). */
      ffmpegExecutable?: string;
    },
  ) {}

  async runBatch(batchId: string): Promise<void> {
    const batch = this.repository.getBatch(batchId);
    if (!batch) return;
    // Hand-rolled worker pool: N lanes pull task ids until the queue drains.
    // A failing task never blocks the others (runTask captures its errors).
    const queue = batch.tasks
      .filter((item) => item.status === "fetching")
      .map((item) => item.id);
    const configured = this.dependencies.resolveConcurrency?.() ?? 1;
    const concurrency = Math.max(1, Math.min(20, Math.floor(configured)));
    const lanes = Array.from(
      { length: Math.min(concurrency, queue.length) },
      async () => {
        for (let taskId = queue.shift(); taskId; taskId = queue.shift()) {
          await this.runTask(taskId);
        }
      },
    );
    await Promise.all(lanes);
  }

  async runTask(taskId: string): Promise<void> {
    const task = this.repository.getTask(taskId);
    if (!task) return;
    const outputDirectory = join(this.dependencies.outputDirectory, taskId);
    const videoSettings = this.dependencies.resolveVideoSettings?.() ?? {
      coverPageDurationSeconds: 1,
      bodyPageDurationSeconds: 3,
      fullContentOutput: false,
      videoMode: "slide" as const,
      scrollSpeed: scrollSpeedDefault,
    };
    try {
      this.repository.reportTaskProgress(taskId, 5, "开始读取文章内容");
      const prepared = await buildPreparedVideo(
        {
          sourceUrl: task.sourceUrl,
          sourceType: task.sourceType,
          articleKeyword: task.articleKeyword,
          manualContent: task.manualContent,
          snapshotDir: outputDirectory,
          fullContentOutput: videoSettings.fullContentOutput,
        },
        this.dependencies,
      );
      if (prepared.kind === "failed") {
        this.repository.updateTaskExecution(taskId, {
          kind: "failed",
          code: prepared.failure.code,
          message: prepared.failure.message,
        });
        return;
      }
      if (prepared.kind === "needs_review") {
        this.repository.updateTaskExecution(taskId, {
          kind: "needs_review",
          code: prepared.issues[0]?.code ?? "SUMMARY_REVIEW",
          message: prepared.issues.map((issue) => issue.message).join("；"),
        });
        return;
      }
      if (prepared.snapshotPath) {
        this.repository.saveRawContentPath(taskId, prepared.snapshotPath);
      }
      this.repository.updateTaskExecution(taskId, {
        kind: "advance",
        to: "summarizing",
        message: "正文分页与 AI 标题标签已完成校验",
      });
      this.repository.reportTaskProgress(taskId, 35, "标题与标签已生成");
      this.repository.updateTaskExecution(taskId, {
        kind: "advance",
        to: "rendering_images",
        message: "开始生成 9:16 图片",
      });
      await renderVideoAssets({
        outputDirectory,
        summary: prepared.summary,
        // A "ready" result implies the keyword was verified by the pipeline.
        keyword: task.articleKeyword!,
        audio: this.dependencies.resolveAudio?.() ?? undefined,
        timing: {
          coverPageDurationSeconds: videoSettings.coverPageDurationSeconds,
          bodyPageDurationSeconds: videoSettings.bodyPageDurationSeconds,
        },
        videoMode: videoSettings.videoMode,
        scrollSpeed: videoSettings.scrollSpeed,
        ffmpegExecutable: this.dependencies.ffmpegExecutable,
        tailTemplate: task.tailNoteTemplate,
        cleanedParagraphs: prepared.cleanedParagraphs,
        coverMeta: prepared.summary.coverMeta,
        fullContentOutput: videoSettings.fullContentOutput,
        onImageProgress: (done, total) =>
          this.repository.reportTaskProgress(
            taskId,
            50 + (20 * done) / Math.max(1, total),
          ),
        onVideoEncodingStart: () => {
          this.repository.updateTaskExecution(taskId, {
            kind: "advance",
            to: "rendering_video",
            message: "图片已生成，开始合成视频",
          });
          this.repository.reportTaskProgress(taskId, 80);
        },
      });
      this.repository.saveTaskArtifacts(taskId, {
        finalTitle: prepared.summary.videoTitle,
        finalTags: prepared.summary.tags,
        outputDirectory,
      });
      this.repository.reportTaskProgress(taskId, 95, "视频合成完成，正在收尾");
      this.repository.updateTaskExecution(taskId, {
        kind: "advance",
        to: "completed",
        message: "成片已完成",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务执行失败。";
      const code = message.startsWith("未配置 AI_")
        ? "AI_NOT_CONFIGURED"
        : "TASK_EXECUTION_FAILED";
      this.repository.updateTaskExecution(taskId, {
        kind: "failed",
        code,
        message,
      });
    }
  }

  /**
   * Re-renders the tail page (and repacks the video) with the current keyword,
   * reusing the stored article snapshot. Neither the browser reader nor the
   * AI runs again, and the existing cover title/tags are preserved.
   */
  async rerenderTail(taskId: string): Promise<RerenderTailResult> {
    const task = this.repository.getTask(taskId);
    if (!task) {
      return { ok: false, code: "TASK_NOT_FOUND", message: "任务不存在。" };
    }
    if (task.status !== "completed" && task.status !== "needs_review") {
      return {
        ok: false,
        code: "INVALID_TASK_STATE",
        message: "只有已完成或需人工确认的任务可以重渲尾页。",
      };
    }
    const keyword = task.articleKeyword?.trim();
    if (!keyword) {
      return {
        ok: false,
        code: "KEYWORD_REQUIRED",
        message: "请先填写并保存文章口令。",
      };
    }
    const outputDirectory = join(this.dependencies.outputDirectory, taskId);
    const videoSettings = this.dependencies.resolveVideoSettings?.() ?? {
      coverPageDurationSeconds: 1,
      bodyPageDurationSeconds: 3,
      fullContentOutput: false,
      videoMode: "slide" as const,
      scrollSpeed: scrollSpeedDefault,
    };
    const content: {
      title: string;
      paragraphs: string[];
      meta?: SourcePageMeta | null;
    } | null =
      task.manualContent ?? (await readSnapshotContent(outputDirectory));
    if (!content) {
      return {
        ok: false,
        code: "SNAPSHOT_MISSING",
        message: "缺少文章快照，无法单独重渲尾页，请使用重试重新抓取。",
      };
    }
    const { pages, truncated } = paginateParagraphs(
      content.paragraphs,
      videoSettings.fullContentOutput
        ? { maxPages: Number.POSITIVE_INFINITY }
        : {},
    );
    const summary: VideoSummary = {
      sourceTitle: content.title,
      videoTitle: task.finalTitle ?? truncateVideoTitle(content.title),
      tags: task.finalTags,
      pages,
      truncated,
      riskFlags: [],
      // Older snapshots carry no page metadata; the cover then keeps its
      // tags-only fallback layout.
      coverMeta: content.meta ?? null,
    };
    const validation = validateVideoSummary(summary, {
      hasVerifiedKeyword: true,
      allowUnlimitedPages: videoSettings.fullContentOutput,
    });
    if (validation.status === "needs_review") {
      return {
        ok: false,
        code: "SUMMARY_REVIEW",
        message: validation.issues.map((issue) => issue.message).join("；"),
      };
    }

    const previousProgress = task.progress;
    try {
      this.repository.reportTaskProgress(taskId, 50, "按新口令重新渲染图片");
      await renderVideoAssets({
        outputDirectory,
        summary,
        keyword,
        audio: this.dependencies.resolveAudio?.() ?? undefined,
        timing: {
          coverPageDurationSeconds: videoSettings.coverPageDurationSeconds,
          bodyPageDurationSeconds: videoSettings.bodyPageDurationSeconds,
        },
        videoMode: videoSettings.videoMode,
        scrollSpeed: videoSettings.scrollSpeed,
        ffmpegExecutable: this.dependencies.ffmpegExecutable,
        tailTemplate: task.tailNoteTemplate,
        cleanedParagraphs: content.paragraphs,
        coverMeta: content.meta ?? null,
        fullContentOutput: videoSettings.fullContentOutput,
        onImageProgress: (done, total) =>
          this.repository.reportTaskProgress(
            taskId,
            50 + (30 * done) / Math.max(1, total),
          ),
        onVideoEncodingStart: () =>
          this.repository.reportTaskProgress(taskId, 85, "正在重新合成视频"),
      });
    } catch (error) {
      this.repository.reportTaskProgress(taskId, previousProgress);
      return {
        ok: false,
        code: "RENDER_FAILED",
        message: error instanceof Error ? error.message : "尾页重渲失败。",
      };
    }
    this.repository.saveTaskArtifacts(taskId, {
      finalTitle: summary.videoTitle,
      finalTags: summary.tags,
      outputDirectory,
    });
    this.repository.reportTaskProgress(
      taskId,
      task.status === "completed" ? 100 : previousProgress,
      "尾页与视频已按新口令重新渲染",
    );
    return { ok: true };
  }
}

/** Reads the persisted article snapshot (written by the reader on success). */
async function readSnapshotContent(outputDirectory: string): Promise<{
  title: string;
  paragraphs: string[];
  meta: SourcePageMeta | null;
} | null> {
  try {
    const raw = await readFile(join(outputDirectory, "source.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      title?: unknown;
      paragraphs?: unknown;
      meta?: unknown;
    };
    if (typeof parsed.title !== "string" || !Array.isArray(parsed.paragraphs)) {
      return null;
    }
    const paragraphs = parsed.paragraphs.filter(
      (paragraph): paragraph is string => typeof paragraph === "string",
    );
    if (!parsed.title || paragraphs.length === 0) return null;
    return {
      title: parsed.title,
      paragraphs,
      meta: parseSnapshotMeta(parsed.meta),
    };
  } catch {
    return null;
  }
}

/** Defensively parses the optional cover metadata stored in source.json. */
function parseSnapshotMeta(value: unknown): SourcePageMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const read = (key: keyof SourcePageMeta): string | null =>
    typeof record[key] === "string" && record[key]
      ? (record[key] as string)
      : null;
  const meta: SourcePageMeta = {
    authorName: read("authorName"),
    authorBadge: read("authorBadge"),
    answerCount: read("answerCount"),
    followCount: read("followCount"),
    avatarDataUri: read("avatarDataUri"),
  };
  return (meta.authorName ?? meta.answerCount ?? meta.followCount)
    ? meta
    : null;
}
