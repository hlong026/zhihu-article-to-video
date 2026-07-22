import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/database.js";
import type { ImportTaskInput } from "../src/importer.js";
import {
  DEFAULT_PROCESSING_SETTINGS,
  TaskRepository,
  renderTailNote,
} from "../src/repository.js";

function createRepository(): TaskRepository {
  return new TaskRepository(openDatabase(":memory:"));
}

function taskInput(overrides: Partial<ImportTaskInput> = {}): ImportTaskInput {
  return {
    rowNumber: 2,
    sourceUrl: "https://www.zhihu.com/answer/1",
    sourceType: "answer",
    inputTitle: "输入标题",
    articleKeyword: "旧口令",
    sourceDate: null,
    needsReview: false,
    ...overrides,
  };
}

describe("renderTailNote", () => {
  it("locks the template around the verified keyword", () => {
    expect(renderTailNote("三个方法")).toBe("来知乎搜索🔍三个方法可以看到全文");
  });

  it("falls back to a placeholder when the keyword is missing", () => {
    expect(renderTailNote(null)).toBe("来知乎搜索🔍待人工确认口令可以看到全文");
  });
});

describe("tail note recomputation", () => {
  it("renders the locked tail note at import time", () => {
    const repository = createRepository();
    const batch = repository.createBatch("tasks.xlsx", [taskInput()], []);
    expect(batch.tasks[0]?.tailNote).toBe("来知乎搜索🔍旧口令可以看到全文");
  });

  it("recomputes the tail note when the keyword is edited", () => {
    const repository = createRepository();
    const batch = repository.createBatch("tasks.xlsx", [taskInput()], []);
    const taskId = batch.tasks[0]!.id;

    const updated = repository.editTask(taskId, { articleKeyword: "新口令" });

    expect(updated?.articleKeyword).toBe("新口令");
    expect(updated?.tailNote).toBe("来知乎搜索🔍新口令可以看到全文");
  });
});

describe("reportTaskProgress", () => {
  it("clamps and rounds progress without changing the task status", () => {
    const repository = createRepository();
    const batch = repository.createBatch("tasks.xlsx", [taskInput()], []);
    const taskId = batch.tasks[0]!.id;

    repository.reportTaskProgress(taskId, 47.6);
    expect(repository.getTask(taskId)).toMatchObject({
      progress: 48,
      status: "pending",
    });

    repository.reportTaskProgress(taskId, 140);
    expect(repository.getTask(taskId)?.progress).toBe(100);

    repository.reportTaskProgress(taskId, -3);
    const task = repository.getTask(taskId);
    expect(task?.progress).toBe(0);
    expect(task?.status).toBe("pending");
  });

  it("logs a progress attempt when a message is provided", () => {
    const repository = createRepository();
    const batch = repository.createBatch("tasks.xlsx", [taskInput()], []);
    const taskId = batch.tasks[0]!.id;

    repository.reportTaskProgress(taskId, 50, "图片生成中");

    const attempts = repository.getTask(taskId)?.attempts ?? [];
    expect(
      attempts.some(
        (attempt) =>
          attempt.status === "progress" && attempt.message === "图片生成中",
      ),
    ).toBe(true);
  });
});

describe("processing settings", () => {
  it("defaults to the serial-safe preset before anything is saved", () => {
    const repository = createRepository();
    expect(repository.getProcessingSettings()).toEqual(
      DEFAULT_PROCESSING_SETTINGS,
    );
    expect(repository.getProcessingSettings().concurrency).toBe(5);
    expect(repository.getProcessingSettings().scrollSpeed).toBe(3);
  });

  it("persists an allowed preset and reads it back", () => {
    const repository = createRepository();
    expect(
      repository.saveProcessingSettings({
        concurrency: 15,
        coverPageDurationSeconds: 3,
        bodyPageDurationSeconds: 5,
        fullContentOutput: true,
        videoMode: "scroll",
        scrollSpeed: 4,
      }),
    ).toEqual({
      concurrency: 15,
      coverPageDurationSeconds: 3,
      bodyPageDurationSeconds: 5,
      fullContentOutput: true,
      videoMode: "scroll",
      scrollSpeed: 4,
    });
    expect(repository.getProcessingSettings()).toEqual({
      concurrency: 15,
      coverPageDurationSeconds: 3,
      bodyPageDurationSeconds: 5,
      fullContentOutput: true,
      videoMode: "scroll",
      scrollSpeed: 4,
    });
  });

  it("rejects values outside the preset list", () => {
    const repository = createRepository();
    expect(() =>
      repository.saveProcessingSettings({
        concurrency: 7,
        coverPageDurationSeconds: 1,
        bodyPageDurationSeconds: 3,
        fullContentOutput: false,
        videoMode: "slide",
        scrollSpeed: 3,
      }),
    ).toThrow("并发数仅支持 5 / 10 / 15 / 20");
    expect(() =>
      repository.saveProcessingSettings({
        concurrency: 5,
        coverPageDurationSeconds: 1,
        bodyPageDurationSeconds: 2,
        fullContentOutput: false,
        videoMode: "slide",
        scrollSpeed: 3,
      }),
    ).toThrow("正文页时长仅支持 3 / 4 / 5 / 6 秒");
    expect(repository.getProcessingSettings().concurrency).toBe(5);
  });

  it("falls back to the default when the stored value is corrupt", () => {
    const database = openDatabase(":memory:");
    const repository = new TaskRepository(database);
    const insert = database.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
    );

    insert.run("processing", JSON.stringify({ concurrency: 42 }), "now");
    expect(repository.getProcessingSettings().concurrency).toBe(5);

    database
      .prepare("UPDATE app_settings SET value = ? WHERE key = ?")
      .run("not-json", "processing");
    expect(repository.getProcessingSettings().concurrency).toBe(5);
  });
});
