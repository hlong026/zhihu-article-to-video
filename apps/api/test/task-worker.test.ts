import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SourcePageMeta,
  SourceReadResult,
  SummaryGenerator,
  ZhihuContentReader,
} from "@zhihu-video/pipeline";

import { openDatabase } from "../src/database.js";
import type { ImportTaskInput } from "../src/importer.js";
import { renderVideoAssets } from "../src/media-renderer.js";
import { TaskRepository } from "../src/repository.js";
import { TaskWorker } from "../src/task-worker.js";

vi.mock("../src/media-renderer.js", () => ({
  renderVideoAssets: vi.fn(),
}));

const renderVideoAssetsMock = vi.mocked(renderVideoAssets);

let outputDirectory: string;

beforeEach(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "zhihu-video-worker-"));
  renderVideoAssetsMock.mockReset();
});

afterEach(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
});

const longParagraph =
  "这一段正文内容足够长，能够撑过分页与三十八字符的校验要求，因此继续多写一些文字确保通过。";

const missingReader: ZhihuContentReader = {
  read: async (): Promise<SourceReadResult> => ({
    ok: false,
    failure: { code: "SOURCE_NOT_FOUND", message: "内容不存在" },
  }),
};

const silentGenerator: SummaryGenerator = {
  summarize: async () => ({ videoTitle: "视频标题", tags: ["知乎"] }),
};

function taskInput(overrides: Partial<ImportTaskInput> = {}): ImportTaskInput {
  return {
    rowNumber: 2,
    sourceUrl: "https://www.zhihu.com/answer/1",
    sourceType: "answer",
    inputTitle: "输入标题",
    articleKeyword: "测试口令",
    sourceDate: null,
    needsReview: false,
    ...overrides,
  };
}

function createRepository(): TaskRepository {
  return new TaskRepository(openDatabase(":memory:"));
}

describe("runBatch worker pool", () => {
  function delayedFailingReader(onChange: (delta: 1 | -1) => void) {
    const reader: ZhihuContentReader = {
      read: async (): Promise<SourceReadResult> => {
        onChange(1);
        await new Promise((resolve) => setTimeout(resolve, 30));
        onChange(-1);
        return {
          ok: false,
          failure: { code: "SOURCE_NOT_FOUND", message: "内容不存在" },
        };
      },
    };
    return reader;
  }

  function batchWithTasks(repository: TaskRepository, count: number): string {
    const batch = repository.createBatch(
      "tasks.xlsx",
      Array.from({ length: count }, (_, index) =>
        taskInput({
          rowNumber: index + 2,
          sourceUrl: `https://www.zhihu.com/answer/${index + 1}`,
          articleKeyword: `口令${index + 1}`,
        }),
      ),
      [],
    );
    repository.startBatch(batch.id);
    return batch.id;
  }

  it("caps in-flight tasks at the configured concurrency", async () => {
    const repository = createRepository();
    const batchId = batchWithTasks(repository, 6);
    let inFlight = 0;
    let maxInFlight = 0;
    const reader = delayedFailingReader((delta) => {
      inFlight += delta;
      maxInFlight = Math.max(maxInFlight, inFlight);
    });
    const summarize = vi.fn(silentGenerator.summarize);
    const worker = new TaskWorker(repository, {
      reader,
      generator: { summarize },
      outputDirectory,
      resolveConcurrency: () => 3,
    });

    await worker.runBatch(batchId);

    expect(maxInFlight).toBe(3);
    // Reads failed before the AI stage, so no task ever reached the generator
    // or the renderer.
    expect(summarize).not.toHaveBeenCalled();
    expect(renderVideoAssetsMock).not.toHaveBeenCalled();
    const batch = repository.getBatch(batchId)!;
    expect(batch.tasks.every((task) => task.status === "failed")).toBe(true);
    expect(batch.tasks[0]?.failureCode).toBe("SOURCE_NOT_FOUND");
  });

  it("runs serially when no concurrency is configured", async () => {
    const repository = createRepository();
    const batchId = batchWithTasks(repository, 3);
    let inFlight = 0;
    let maxInFlight = 0;
    const reader = delayedFailingReader((delta) => {
      inFlight += delta;
      maxInFlight = Math.max(maxInFlight, inFlight);
    });
    const worker = new TaskWorker(repository, {
      reader,
      generator: silentGenerator,
      outputDirectory,
    });

    await worker.runBatch(batchId);

    expect(maxInFlight).toBe(1);
  });
});

describe("runTask progress reporting", () => {
  it("streams fine-grained progress while a task completes", async () => {
    const repository = createRepository();
    const batch = repository.createBatch("tasks.xlsx", [taskInput()], []);
    repository.startBatch(batch.id);
    const taskId = repository.getBatch(batch.id)!.tasks[0]!.id;

    const reader: ZhihuContentReader = {
      read: async (): Promise<SourceReadResult> => ({
        ok: true,
        content: { title: "原文标题", paragraphs: [longParagraph] },
      }),
    };
    renderVideoAssetsMock.mockImplementation(async (input) => {
      input.onImageProgress?.(1, 2);
      input.onImageProgress?.(2, 2);
      input.onVideoEncodingStart?.();
      return {
        imagePaths: ["1-cover.png", "2-body.png"],
        videoPath: "video.mp4",
        durationSeconds: 3,
      };
    });
    const progressRecords: number[] = [];
    const original = repository.reportTaskProgress.bind(repository);
    repository.reportTaskProgress = (id, progress, message) => {
      progressRecords.push(progress);
      original(id, progress, message);
    };
    const worker = new TaskWorker(repository, {
      reader,
      generator: silentGenerator,
      outputDirectory,
    });

    await worker.runTask(taskId);

    const task = repository.getTask(taskId)!;
    expect(task.status).toBe("completed");
    expect(task.progress).toBe(100);
    expect(task.finalTitle).toBe("视频标题");
    expect(renderVideoAssetsMock.mock.calls[0]![0].scrollSpeed).toBe(3);
    // 5 → 35 → per-card 60/70 → encoding 80 → wrap-up 95, then the
    // completed transition pins the stored progress to 100.
    expect(progressRecords).toEqual([5, 35, 60, 70, 80, 95]);
  });
});

describe("rerenderTail", () => {
  it("rejects unknown tasks, invalid states and missing keywords", async () => {
    const repository = createRepository();
    const worker = new TaskWorker(repository, {
      reader: missingReader,
      generator: silentGenerator,
      outputDirectory,
    });

    expect(await worker.rerenderTail("missing-task")).toEqual({
      ok: false,
      code: "TASK_NOT_FOUND",
      message: "任务不存在。",
    });

    const batch = repository.createBatch(
      "tasks.xlsx",
      [
        taskInput({ sourceUrl: "https://www.zhihu.com/answer/1" }),
        taskInput({
          rowNumber: 3,
          sourceUrl: "https://www.zhihu.com/answer/2",
          articleKeyword: null,
          needsReview: true,
        }),
      ],
      [],
    );
    const [withKeyword, withoutKeyword] = batch.tasks;

    expect(withKeyword!.status).toBe("pending");
    expect(await worker.rerenderTail(withKeyword!.id)).toMatchObject({
      ok: false,
      code: "INVALID_TASK_STATE",
    });

    expect(withoutKeyword!.status).toBe("needs_review");
    expect(await worker.rerenderTail(withoutKeyword!.id)).toMatchObject({
      ok: false,
      code: "KEYWORD_REQUIRED",
    });
  });

  it("requires a snapshot or manual content before rendering", async () => {
    const repository = createRepository();
    const worker = new TaskWorker(repository, {
      reader: missingReader,
      generator: silentGenerator,
      outputDirectory,
    });
    const batch = repository.createBatch("tasks.xlsx", [taskInput()], []);
    const task = batch.tasks[0]!;
    repository.updateTaskExecution(task.id, {
      kind: "needs_review",
      code: "SUMMARY_REVIEW",
      message: "需要人工确认",
    });

    expect(await worker.rerenderTail(task.id)).toMatchObject({
      ok: false,
      code: "SNAPSHOT_MISSING",
    });
    expect(renderVideoAssetsMock).not.toHaveBeenCalled();
  });

  it("re-renders from manual content without touching the reader or the AI", async () => {
    const repository = createRepository();
    const read = vi.fn(missingReader.read);
    const summarize = vi.fn(silentGenerator.summarize);
    const worker = new TaskWorker(repository, {
      reader: { read },
      generator: { summarize },
      outputDirectory,
    });
    const batch = repository.createBatch(
      "tasks.xlsx",
      [taskInput({ articleKeyword: "新口令", needsReview: true })],
      [],
    );
    const task = batch.tasks[0]!;
    expect(task.status).toBe("needs_review");
    repository.editTask(task.id, {
      finalTitle: "保留标题",
      finalTags: ["知乎"],
    });
    repository.saveManualContent(task.id, {
      title: "人工标题",
      paragraphs: [longParagraph],
    });
    renderVideoAssetsMock.mockImplementation(async (input) => {
      input.onImageProgress?.(2, 2);
      input.onVideoEncodingStart?.();
      return {
        imagePaths: ["1-cover.png", "2-body.png"],
        videoPath: "video.mp4",
        durationSeconds: 3,
      };
    });

    const result = await worker.rerenderTail(task.id);

    expect(result).toEqual({ ok: true });
    expect(read).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(renderVideoAssetsMock).toHaveBeenCalledTimes(1);
    const renderInput = renderVideoAssetsMock.mock.calls[0]![0];
    expect(renderInput.keyword).toBe("新口令");
    expect(renderInput.summary.videoTitle).toBe("保留标题");
    expect(renderInput.summary.tags).toEqual(["知乎"]);
    const after = repository.getTask(task.id)!;
    // A needs_review task keeps its state and previous progress.
    expect(after.status).toBe("needs_review");
    expect(after.progress).toBe(0);
    expect(after.finalTitle).toBe("保留标题");
  });

  async function createCompletedTaskWithSnapshot(
    repository: TaskRepository,
    meta?: SourcePageMeta,
  ): Promise<string> {
    const batch = repository.createBatch("tasks.xlsx", [taskInput()], []);
    repository.startBatch(batch.id);
    const taskId = repository.getBatch(batch.id)!.tasks[0]!.id;
    for (const to of [
      "summarizing",
      "rendering_images",
      "rendering_video",
      "completed",
    ] as const) {
      repository.updateTaskExecution(taskId, { kind: "advance", to });
    }
    const taskOutputDirectory = join(outputDirectory, taskId);
    await mkdir(taskOutputDirectory, { recursive: true });
    await writeFile(
      join(taskOutputDirectory, "source.json"),
      JSON.stringify({
        title: "快照标题",
        paragraphs: [longParagraph],
        ...(meta ? { meta } : {}),
      }),
    );
    repository.saveTaskArtifacts(taskId, {
      finalTitle: "旧标题",
      finalTags: ["旧标签"],
      outputDirectory: taskOutputDirectory,
    });
    return taskId;
  }

  it("re-renders a completed task from the stored snapshot", async () => {
    const repository = createRepository();
    const worker = new TaskWorker(repository, {
      reader: missingReader,
      generator: silentGenerator,
      outputDirectory,
    });
    const taskId = await createCompletedTaskWithSnapshot(repository);
    renderVideoAssetsMock.mockResolvedValue({
      imagePaths: ["1-cover.png"],
      videoPath: "video.mp4",
      durationSeconds: 3,
    });

    const result = await worker.rerenderTail(taskId);

    expect(result).toEqual({ ok: true });
    const renderInput = renderVideoAssetsMock.mock.calls[0]![0];
    expect(renderInput.keyword).toBe("测试口令");
    // The existing cover (title/tags) is preserved for tail-only rerenders.
    expect(renderInput.summary.videoTitle).toBe("旧标题");
    expect(renderInput.summary.tags).toEqual(["旧标签"]);
    // Legacy snapshots carry no page metadata: the cover falls back to
    // its tags-only layout.
    expect(renderInput.summary.coverMeta).toBeNull();
    const after = repository.getTask(taskId)!;
    expect(after.status).toBe("completed");
    expect(after.progress).toBe(100);
  });

  it("restores the cover metadata from the stored snapshot", async () => {
    const repository = createRepository();
    const worker = new TaskWorker(repository, {
      reader: missingReader,
      generator: silentGenerator,
      outputDirectory,
    });
    const meta: SourcePageMeta = {
      authorName: "摸鱼作家",
      authorBadge: "互联网行业 软件工程师",
      answerCount: "278",
      followCount: "623",
      avatarDataUri: "data:image/jpeg;base64,QUJD",
    };
    const taskId = await createCompletedTaskWithSnapshot(repository, meta);
    renderVideoAssetsMock.mockResolvedValue({
      imagePaths: ["1-cover.png"],
      videoPath: "video.mp4",
      durationSeconds: 3,
    });

    const result = await worker.rerenderTail(taskId);

    expect(result).toEqual({ ok: true });
    const renderInput = renderVideoAssetsMock.mock.calls[0]![0];
    // The author card survives keyword-only rerenders.
    expect(renderInput.summary.coverMeta).toEqual(meta);
  });

  it("restores the previous progress when rendering fails", async () => {
    const repository = createRepository();
    const worker = new TaskWorker(repository, {
      reader: missingReader,
      generator: silentGenerator,
      outputDirectory,
    });
    const taskId = await createCompletedTaskWithSnapshot(repository);
    renderVideoAssetsMock.mockRejectedValue(new Error("渲染失败"));

    const result = await worker.rerenderTail(taskId);

    expect(result).toMatchObject({ ok: false, code: "RENDER_FAILED" });
    const after = repository.getTask(taskId)!;
    expect(after.status).toBe("completed");
    expect(after.progress).toBe(100);
  });
});
