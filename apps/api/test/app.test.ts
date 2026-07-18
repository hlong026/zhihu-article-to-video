import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { buildApp, splitManualParagraphs } from "../src/app.js";

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
