import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

let workDir: string;
let databasePath: string;
let outputDirectory: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "zhihu-video-batch-export-"));
  databasePath = join(workDir, "test.sqlite");
  outputDirectory = join(workDir, "outputs");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Imports two tasks and returns [batchId, completedTaskId, failedTaskId]. */
async function importBatch(
  app: FastifyInstance,
): Promise<[string, string, string]> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("任务");
  sheet.addRow(["知乎标题", "链接", "文章口令"]);
  sheet.addRow(["完成的文章", "https://www.zhihu.com/answer/123", "口令甲"]);
  sheet.addRow(["失败的文章", "https://www.zhihu.com/answer/456", "口令乙"]);
  const body = Buffer.from(await workbook.xlsx.writeBuffer());
  const imported = await app.inject({
    method: "POST",
    url: "/api/batches/import",
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "x-file-name": "测试知乎链接.xlsx",
    },
    payload: body,
  });
  expect(imported.statusCode).toBe(201);
  const batch = imported.json();
  return [batch.id, batch.tasks[0].id, batch.tasks[1].id];
}

/** Marks one task completed with artifacts and the other failed. */
async function finalizeTasks(
  completedTaskId: string,
  failedTaskId: string,
): Promise<void> {
  const taskOutputDirectory = join(outputDirectory, completedTaskId);
  await mkdir(join(taskOutputDirectory, "images"), { recursive: true });
  await writeFile(join(taskOutputDirectory, "video.mp4"), "fake-mp4-content");
  await writeFile(join(taskOutputDirectory, "images", "01-cover.png"), "png-1");
  const database = new Database(databasePath);
  database
    .prepare(
      `UPDATE article_tasks
       SET status = 'completed', current_step = 'completed',
           final_title = ?, final_tags_json = ?, output_dir = ?
       WHERE id = ?`,
    )
    .run(
      "AI 标题",
      JSON.stringify(["AI", "测试"]),
      taskOutputDirectory,
      completedTaskId,
    );
  database
    .prepare(
      `UPDATE article_tasks
       SET status = 'failed', failure_code = 'CONTENT_EMPTY', failure_message = ?
       WHERE id = ?`,
    )
    .run("页面未提取到公开正文。", failedTaskId);
  database.close();
}

describe("batch export APIs", () => {
  it("serves result.xlsx with per-task status and ZIP-relative paths", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const [batchId, completedTaskId, failedTaskId] = await importBatch(app);
    await finalizeTasks(completedTaskId, failedTaskId);

    const response = await app.inject({
      method: "GET",
      url: `/api/batches/${batchId}/result.xlsx`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("测试知乎链接-result.xlsx")}`,
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      response.rawPayload as unknown as Parameters<
        ExcelJS.Workbook["xlsx"]["load"]
      >[0],
    );
    const sheet = workbook.worksheets[0];
    expect(sheet.rowCount).toBe(3);
    const header = sheet.getRow(1).values as string[];
    expect(header).toContain("状态");
    expect(header).toContain("失败原因");
    expect(header).toContain("视频文件");

    const completedRow = sheet.getRow(2);
    expect(completedRow.getCell(6).value).toBe("已完成");
    expect(completedRow.getCell(4).value).toBe("AI 标题");
    expect(completedRow.getCell(5).value).toBe("AI、测试");
    expect(completedRow.getCell(8).value).toBe("01-AI 标题/video.mp4");
    expect(completedRow.getCell(9).value).toBe("01-AI 标题/images/");

    const failedRow = sheet.getRow(3);
    expect(failedRow.getCell(6).value).toBe("失败");
    expect(failedRow.getCell(7).value).toBe("页面未提取到公开正文。");
    expect(failedRow.getCell(8).value).toBe("");
    await app.close();
  });

  it("serves a batch ZIP containing result.xlsx and completed artifacts", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const [batchId, completedTaskId, failedTaskId] = await importBatch(app);
    await finalizeTasks(completedTaskId, failedTaskId);

    const response = await app.inject({
      method: "GET",
      url: `/api/batches/${batchId}/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("测试知乎链接-成品.zip")}`,
    );
    // ZIP local file header magic.
    expect(response.rawPayload.subarray(0, 2).toString()).toBe("PK");
    // Entry names are stored in plain text in the ZIP central directory.
    const payload = response.rawPayload;
    expect(payload.includes("result.xlsx")).toBe(true);
    expect(payload.includes("01-AI 标题/video.mp4")).toBe(true);
    expect(payload.includes("01-AI 标题/images/01-cover.png")).toBe(true);
    // The failed task contributes no artifact entries.
    expect(payload.includes("02-")).toBe(false);
    await app.close();
  });

  it("rejects the batch ZIP when no task has completed", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const [batchId] = await importBatch(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/batches/${batchId}/download`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "BATCH_NOT_COMPLETED" });
    await app.close();
  });

  it("still serves result.xlsx when no task has completed", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const [batchId] = await importBatch(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/batches/${batchId}/result.xlsx`,
    });

    expect(response.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      response.rawPayload as unknown as Parameters<
        ExcelJS.Workbook["xlsx"]["load"]
      >[0],
    );
    const sheet = workbook.worksheets[0];
    expect(sheet.rowCount).toBe(3);
    expect(sheet.getRow(2).getCell(6).value).toBe("待处理");
    await app.close();
  });

  it("returns 404 for unknown batches on both export routes", async () => {
    const app = buildApp({ databasePath, outputDirectory });

    const zip = await app.inject({
      method: "GET",
      url: "/api/batches/not-a-batch/download",
    });
    expect(zip.statusCode).toBe(404);

    const workbook = await app.inject({
      method: "GET",
      url: "/api/batches/not-a-batch/result.xlsx",
    });
    expect(workbook.statusCode).toBe(404);
    await app.close();
  });
});
