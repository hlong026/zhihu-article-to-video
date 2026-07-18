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
  workDir = await mkdtemp(join(tmpdir(), "zhihu-video-download-"));
  databasePath = join(workDir, "test.sqlite");
  outputDirectory = join(workDir, "outputs");
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function importTask(app: FastifyInstance): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("任务");
  sheet.addRow(["知乎标题", "链接", "文章口令"]);
  sheet.addRow(["测试回答", "https://www.zhihu.com/answer/123", "测试口令"]);
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
  expect(imported.statusCode).toBe(201);
  return imported.json().tasks[0].id as string;
}

/** Marks the task completed with artifacts on disk, bypassing the pipeline. */
async function markCompleted(taskId: string): Promise<string> {
  const taskOutputDirectory = join(outputDirectory, taskId);
  await mkdir(join(taskOutputDirectory, "images"), { recursive: true });
  await writeFile(join(taskOutputDirectory, "video.mp4"), "fake-mp4-content");
  await writeFile(join(taskOutputDirectory, "images", "01.png"), "png-1");
  await writeFile(join(taskOutputDirectory, "images", "02.png"), "png-2");
  const database = new Database(databasePath);
  database
    .prepare(
      `UPDATE article_tasks
       SET status = 'completed', current_step = 'completed', final_title = ?, output_dir = ?
       WHERE id = ?`,
    )
    .run("AI 生成标题", taskOutputDirectory, taskId);
  database.close();
  return taskOutputDirectory;
}

describe("task download APIs", () => {
  it("serves the rendered video for a completed task", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);
    await markCompleted(taskId);

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/download/video`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("video/mp4");
    const disposition = response.headers["content-disposition"];
    expect(disposition).toContain("attachment");
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent("AI 生成标题.mp4")}`,
    );
    expect(response.rawPayload.toString()).toBe("fake-mp4-content");
    await app.close();
  });

  it("serves the rendered images as a zip archive", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);
    await markCompleted(taskId);

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/download/images`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-disposition"]).toContain(
      `filename*=UTF-8''${encodeURIComponent("AI 生成标题.zip")}`,
    );
    // ZIP local file header magic: "PK\x03\x04".
    expect(response.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(response.rawPayload.length).toBeGreaterThan(100);
    await app.close();
  });

  it("rejects downloads for tasks that have not completed", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);

    const video = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/download/video`,
    });
    expect(video.statusCode).toBe(409);
    expect(video.json()).toMatchObject({ error: "TASK_NOT_COMPLETED" });

    const images = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/download/images`,
    });
    expect(images.statusCode).toBe(409);
    await app.close();
  });

  it("returns 404 when the task does not exist", async () => {
    const app = buildApp({ databasePath, outputDirectory });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/not-a-task/download/video",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "TASK_NOT_FOUND" });
    await app.close();
  });

  it("returns 404 when the video file is missing on disk", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);
    const taskOutputDirectory = join(outputDirectory, taskId);
    await mkdir(taskOutputDirectory, { recursive: true });
    const database = new Database(databasePath);
    database
      .prepare(
        `UPDATE article_tasks
         SET status = 'completed', current_step = 'completed', output_dir = ?
         WHERE id = ?`,
      )
      .run(taskOutputDirectory, taskId);
    database.close();

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/download/video`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "ARTIFACT_NOT_FOUND" });
    await app.close();
  });

  it("returns 404 when the images directory has no png cards", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);
    const taskOutputDirectory = join(outputDirectory, taskId);
    await mkdir(join(taskOutputDirectory, "images"), { recursive: true });
    const database = new Database(databasePath);
    database
      .prepare(
        `UPDATE article_tasks
         SET status = 'completed', current_step = 'completed', output_dir = ?
         WHERE id = ?`,
      )
      .run(taskOutputDirectory, taskId);
    database.close();

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/download/images`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "ARTIFACT_NOT_FOUND" });
    await app.close();
  });
});
