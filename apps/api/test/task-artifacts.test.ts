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
  workDir = await mkdtemp(join(tmpdir(), "zhihu-video-artifacts-"));
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

/** Marks the task completed with rendered cards on disk. */
async function markCompleted(
  taskId: string,
  imageNames: string[],
  options: { video?: boolean; outputRoot?: string } = {},
): Promise<void> {
  const root = options.outputRoot ?? outputDirectory;
  const taskOutputDirectory = join(root, taskId);
  await mkdir(join(taskOutputDirectory, "images"), { recursive: true });
  for (const name of imageNames) {
    await writeFile(
      join(taskOutputDirectory, "images", name),
      `content-of-${name}`,
    );
  }
  if (options.video !== false) {
    await writeFile(join(taskOutputDirectory, "video.mp4"), "fake-mp4");
  }
  const database = new Database(databasePath);
  database
    .prepare(
      `UPDATE article_tasks
       SET status = 'completed', current_step = 'completed', final_title = ?, output_dir = ?
       WHERE id = ?`,
    )
    .run("AI 生成标题", taskOutputDirectory, taskId);
  database.close();
}

describe("task preview image API", () => {
  it("serves the first rendered card as a PNG preview", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);
    await markCompleted(taskId, ["01.png", "02.png"]);

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/preview-image`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.rawPayload.toString()).toBe("content-of-01.png");
    await app.close();
  });

  it("returns 404 for unknown tasks and 409 for unfinished ones", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);

    const missing = await app.inject({
      method: "GET",
      url: "/api/tasks/not-a-task/preview-image",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "TASK_NOT_FOUND" });

    const pending = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/preview-image`,
    });
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ error: "TASK_NOT_COMPLETED" });
    await app.close();
  });

  it("returns 404 when the completed task has no rendered cards", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);
    await markCompleted(taskId, []);

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/preview-image`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "ARTIFACT_NOT_FOUND" });
    await app.close();
  });

  it("refuses artifact directories outside the output root", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);
    const outsideRoot = join(workDir, "elsewhere");
    await markCompleted(taskId, ["01.png"], { outputRoot: outsideRoot });

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/preview-image`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "ARTIFACT_NOT_FOUND" });
    await app.close();
  });
});

describe("task detail artifacts", () => {
  it("summarizes card count, video readiness and derived duration", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);
    await markCompleted(taskId, ["01.png", "02.png", "03.png"]);

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
    });

    expect(response.statusCode).toBe(200);
    // 3 cards = cover 1s + 2×body 3s, matching pipeline duration math.
    expect(response.json().artifacts).toEqual({
      imageCount: 3,
      videoReady: true,
      durationSeconds: 7,
    });
    expect(Array.isArray(response.json().attempts)).toBe(true);
    await app.close();
  });

  it("reports a missing video and null artifacts without any outputs", async () => {
    const app = buildApp({ databasePath, outputDirectory });
    const taskId = await importTask(app);

    const pending = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().artifacts).toBeNull();

    await markCompleted(taskId, ["01.png", "02.png"], { video: false });
    const withoutVideo = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}`,
    });
    expect(withoutVideo.json().artifacts).toEqual({
      imageCount: 2,
      videoReady: false,
      durationSeconds: 4,
    });
    await app.close();
  });
});
