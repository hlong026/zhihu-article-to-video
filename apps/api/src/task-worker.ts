import { join } from "node:path";

import {
  buildPreparedVideo,
  type FfmpegAudioOptions,
  type SummaryGenerator,
  type ZhihuContentReader,
} from "@zhihu-video/pipeline";

import { renderVideoAssets } from "./media-renderer.js";
import { TaskRepository } from "./repository.js";

export class TaskWorker {
  constructor(
    private readonly repository: TaskRepository,
    private readonly dependencies: {
      reader: ZhihuContentReader;
      generator: SummaryGenerator;
      outputDirectory: string;
      /** Resolves the background-music track for each render, if configured. */
      resolveAudio?: () => FfmpegAudioOptions | null;
    },
  ) {}

  async runBatch(batchId: string): Promise<void> {
    const batch = this.repository.getBatch(batchId);
    if (!batch) return;
    for (const task of batch.tasks.filter(
      (item) => item.status === "fetching",
    )) {
      await this.runTask(task.id);
    }
  }

  async runTask(taskId: string): Promise<void> {
    const task = this.repository.getTask(taskId);
    if (!task) return;
    const outputDirectory = join(this.dependencies.outputDirectory, taskId);
    try {
      const prepared = await buildPreparedVideo(
        {
          sourceUrl: task.sourceUrl,
          sourceType: task.sourceType,
          articleKeyword: task.articleKeyword,
          manualContent: task.manualContent,
          snapshotDir: outputDirectory,
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
      });
      this.repository.saveTaskArtifacts(taskId, {
        finalTitle: prepared.summary.videoTitle,
        finalTags: prepared.summary.tags,
        outputDirectory,
      });
      this.repository.updateTaskExecution(taskId, {
        kind: "advance",
        to: "rendering_video",
        message: "图片已生成，视频已合成",
      });
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
}
