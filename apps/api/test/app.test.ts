import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp, splitManualParagraphs } from "../src/app.js";
import type { RerenderTailResult } from "../src/task-worker.js";

const xlsxContentType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function multiRowWorkbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("任务");
  sheet.addRow(["知乎标题", "链接", "文章口令"]);
  sheet.addRow(["任务一", "https://www.zhihu.com/answer/1", "口令一"]);
  sheet.addRow(["任务二", "https://www.zhihu.com/answer/2", "口令二"]);
  sheet.addRow(["任务三", "https://www.zhihu.com/answer/3", ""]);
  sheet.addRow(["坏链接", "https://example.com/a", "口令"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function importSingleTask(app: FastifyInstance): Promise<string> {
  const body = await createWorkbookBuffer();
  const imported = await app.inject({
    method: "POST",
    url: "/api/batches/import",
    headers: { "content-type": xlsxContentType },
    payload: body,
  });
  expect(imported.statusCode).toBe(201);
  return imported.json().tasks[0].id as string;
}

async function createWorkbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("任务");
  sheet.addRow(["知乎标题", "链接", "文章口令"]);
  sheet.addRow(["测试回答", "https://www.zhihu.com/answer/123", "测试口令"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("batch and task APIs", () => {
  it("imports a batch, starts pending tasks, edits a review task and retries it", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    const body = await createWorkbookBuffer();
    const imported = await app.inject({
      method: "POST",
      url: "/api/batches/import",
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      payload: body,
    });

    expect(imported.statusCode).toBe(201);
    const batch = imported.json();
    expect(batch.totalCount).toBe(1);

    const started = await app.inject({
      method: "POST",
      url: `/api/batches/${batch.id}/start`,
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().tasks[0]).toMatchObject({
      status: "fetching",
      step: "fetching",
    });

    const taskId = started.json().tasks[0].id as string;
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      payload: {
        articleKeyword: "已确认口令",
        tailNote: "来知乎搜索🔍{文章口令}可以看到全文",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      articleKeyword: "已确认口令",
      tailNote: "来知乎搜索🔍已确认口令可以看到全文",
    });
    await app.close();
  });

  it("saves manual content for a review task and retries it through the worker", async () => {
    const runTaskCalls: string[] = [];
    const app = buildApp({
      databasePath: ":memory:",
      taskWorker: {
        runBatch: async () => undefined,
        runTask: async (taskId: string) => {
          runTaskCalls.push(taskId);
        },
      },
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("任务");
    sheet.addRow(["知乎标题", "链接", "文章口令"]);
    sheet.addRow(["测试回答", "https://www.zhihu.com/answer/123", ""]);
    const body = Buffer.from(await workbook.xlsx.writeBuffer());
    const imported = await app.inject({
      method: "POST",
      url: "/api/batches/import",
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      payload: body,
    });
    const task = imported.json().tasks[0];
    expect(task.status).toBe("needs_review");

    const saved = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/manual-content`,
      payload: {
        title: "人工录入标题",
        content: "第一段人工录入的正文内容。\n\n第二段人工录入的正文内容。",
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().manualContent).toEqual({
      title: "人工录入标题",
      paragraphs: ["第一段人工录入的正文内容。", "第二段人工录入的正文内容。"],
    });

    const retried = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/retry`,
    });
    expect(retried.statusCode).toBe(200);
    expect(runTaskCalls).toEqual([task.id]);
    await app.close();
  });

  it("rejects manual content for tasks that are still processing", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    const body = await createWorkbookBuffer();
    const imported = await app.inject({
      method: "POST",
      url: "/api/batches/import",
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      payload: body,
    });
    const task = imported.json().tasks[0];
    expect(task.status).toBe("pending");

    const rejected = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.id}/manual-content`,
      payload: { title: "标题", content: "这是一段足够长的正文内容。" },
    });
    expect(rejected.statusCode).toBe(409);
    await app.close();
  });
});

describe("import range and preview APIs", () => {
  it("imports only the requested data-row range", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    const imported = await app.inject({
      method: "POST",
      url: "/api/batches/import?startRow=2&endRow=2",
      headers: { "content-type": xlsxContentType },
      payload: await multiRowWorkbookBuffer(),
    });

    expect(imported.statusCode).toBe(201);
    const batch = imported.json();
    expect(batch.totalCount).toBe(1);
    expect(batch.tasks[0]).toMatchObject({
      sourceUrl: "https://www.zhihu.com/answer/2",
    });
    await app.close();
  });

  it("rejects inverted or non-positive ranges with a 400", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    const payload = await multiRowWorkbookBuffer();

    const inverted = await app.inject({
      method: "POST",
      url: "/api/batches/import?startRow=3&endRow=2",
      headers: { "content-type": xlsxContentType },
      payload,
    });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json()).toMatchObject({ error: "VALIDATION_ERROR" });

    const zero = await app.inject({
      method: "POST",
      url: "/api/batches/import?startRow=0",
      headers: { "content-type": xlsxContentType },
      payload,
    });
    expect(zero.statusCode).toBe(400);
    await app.close();
  });

  it("previews a workbook without persisting a batch", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    const preview = await app.inject({
      method: "POST",
      url: "/api/batches/import/preview",
      headers: { "content-type": xlsxContentType },
      payload: await multiRowWorkbookBuffer(),
    });

    expect(preview.statusCode).toBe(200);
    const result = preview.json();
    expect(result).toMatchObject({
      totalDataRows: 4,
      validCount: 3,
      errorCount: 1,
    });
    expect(result.sample).toHaveLength(3);
    expect(result.sample[0]).toMatchObject({
      rowNumber: 2,
      sourceUrl: "https://www.zhihu.com/answer/1",
      hasKeyword: true,
    });

    const batches = await app.inject({ method: "GET", url: "/api/batches" });
    expect(batches.json()).toEqual([]);
    await app.close();
  });
});

describe("processing settings API", () => {
  it("reads the default concurrency and persists an allowed preset", async () => {
    const app = buildApp({ databasePath: ":memory:" });

    const initial = await app.inject({
      method: "GET",
      url: "/api/settings/processing",
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ concurrency: 5 });

    const updated = await app.inject({
      method: "PUT",
      url: "/api/settings/processing",
      payload: { concurrency: 15 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ concurrency: 15 });

    const reread = await app.inject({
      method: "GET",
      url: "/api/settings/processing",
    });
    expect(reread.json()).toEqual({ concurrency: 15 });
    await app.close();
  });

  it("rejects concurrency values outside the preset list", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    const rejected = await app.inject({
      method: "PUT",
      url: "/api/settings/processing",
      payload: { concurrency: 7 },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: "VALIDATION_ERROR" });
    await app.close();
  });
});

describe("rerender-tail API", () => {
  it("returns the task after a successful tail rerender", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      taskWorker: {
        runBatch: async () => undefined,
        runTask: async () => undefined,
        rerenderTail: async (): Promise<RerenderTailResult> => ({ ok: true }),
      },
    });
    const taskId = await importSingleTask(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/rerender-tail`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: taskId });
    await app.close();
  });

  it("maps worker failure codes to HTTP statuses", async () => {
    const cases = [
      ["TASK_NOT_FOUND", 404],
      ["INVALID_TASK_STATE", 409],
      ["KEYWORD_REQUIRED", 409],
      ["SNAPSHOT_MISSING", 409],
      ["RENDER_FAILED", 500],
    ] as const;
    for (const [code, status] of cases) {
      const app = buildApp({
        databasePath: ":memory:",
        taskWorker: {
          runBatch: async () => undefined,
          runTask: async () => undefined,
          rerenderTail: async (): Promise<RerenderTailResult> => ({
            ok: false,
            code,
            message: "失败原因",
          }),
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/tasks/any-task/rerender-tail",
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: code });
      await app.close();
    }
  });

  it("returns 503 when the worker cannot rerender tails", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      taskWorker: {
        runBatch: async () => undefined,
        runTask: async () => undefined,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/any-task/rerender-tail",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "WORKER_UNAVAILABLE" });
    await app.close();
  });
});

describe("splitManualParagraphs", () => {
  it("prefers blank-line breaks and falls back to single newlines", () => {
    expect(splitManualParagraphs("第一段\n\n第二段\n\n\n第三段")).toEqual([
      "第一段",
      "第二段",
      "第三段",
    ]);
    expect(splitManualParagraphs("第一段\n第二段\r\n第三段")).toEqual([
      "第一段",
      "第二段",
      "第三段",
    ]);
    expect(splitManualParagraphs("只有一整段")).toEqual(["只有一整段"]);
  });
});
