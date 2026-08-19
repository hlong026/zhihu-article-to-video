import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createDesktopApi,
  type DesktopApi,
  type DownloadedAsset,
} from "./local-api.js";

// Packaged apps launched from Finder/Explorer inherit a minimal PATH, so
// common tool locations (e.g. a Homebrew-installed ffmpeg) are unreachable.
// Prepend the usual prefixes to keep the FFmpeg sidecar working locally.
if (process.platform === "darwin") {
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
  const currentEntries = (process.env.PATH ?? "").split(":");
  const missing = extraPaths.filter((entry) => !currentEntries.includes(entry));
  if (missing.length > 0) {
    process.env.PATH = `${missing.join(":")}:${process.env.PATH ?? ""}`;
  }
}

let mainWindow: BrowserWindow | null = null;
let localApi: DesktopApi | null = null;
const currentDirectory = dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    webPreferences: {
      // preload.cts compiles to preload.cjs: sandboxed renderers only accept
      // CommonJS preloads, so this file must stay out of the ESM output.
      preload: join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  // Do not rely on app.isPackaged: directly launching the packaged binary
  // (instead of `open`-ing the .app) can report isPackaged=false. Probe the
  // bundled layout relative to this file instead.
  const packagedIndex = join(currentDirectory, "web", "index.html");
  const rendererIndex = existsSync(packagedIndex)
    ? packagedIndex
    : join(currentDirectory, "../../web/dist/index.html");
  void mainWindow.loadFile(rendererIndex);
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:select-excel", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择知乎链接 Excel",
      properties: ["openFile"],
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("desktop:select-output-directory", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择成品导出目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("desktop:list-batches", async () =>
    requireApi().listBatches(),
  );

  ipcMain.handle("desktop:get-batch", async (_event, batchId: unknown) => {
    if (typeof batchId !== "string" || batchId.length === 0) {
      throw new Error("批次参数无效。");
    }
    return requireApi().getBatch(batchId);
  });

  ipcMain.handle("desktop:get-task", async (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("任务参数无效。");
    }
    return requireApi().getTask(taskId);
  });

  ipcMain.handle("desktop:preview-import", async (_event, input: unknown) => {
    if (typeof input !== "string" || input.length === 0) {
      throw new Error("Excel 文件路径无效。");
    }
    return requireApi().previewWorkbook(input);
  });

  ipcMain.handle("desktop:import-excel", async (_event, input: unknown) => {
    if (!isImportRequest(input)) throw new Error("导入参数无效。");
    return requireApi().importWorkbook(input.path, {
      startRow: input.startRow,
      endRow: input.endRow,
    });
  });

  ipcMain.handle("desktop:start-batch", async (_event, batchId: unknown) => {
    if (typeof batchId !== "string" || batchId.length === 0)
      throw new Error("批次参数无效。");
    return requireApi().startBatch(batchId);
  });

  ipcMain.handle("desktop:update-keyword", async (_event, input: unknown) => {
    if (!isKeywordUpdate(input)) throw new Error("口令参数无效。");
    return requireApi().updateKeyword(
      input.taskId,
      input.articleKeyword,
      input.tailNoteTemplate,
    );
  });

  ipcMain.handle("desktop:rerender-tail", async (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("任务参数无效。");
    }
    return requireApi().rerenderTail(taskId);
  });

  ipcMain.handle(
    "desktop:save-manual-content",
    async (_event, input: unknown) => {
      if (!isManualContentUpdate(input)) throw new Error("正文参数无效。");
      return requireApi().saveManualContent(input.taskId, {
        title: input.title,
        content: input.content,
      });
    },
  );

  ipcMain.handle("desktop:retry-task", async (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("任务参数无效。");
    }
    return requireApi().retryTask(taskId);
  });

  ipcMain.handle("desktop:delete-task", async (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("任务参数无效。");
    }
    return requireApi().deleteTask(taskId);
  });

  ipcMain.handle(
    "desktop:batch-delete-tasks",
    async (_event, taskIds: unknown) => {
      if (
        !Array.isArray(taskIds) ||
        taskIds.length === 0 ||
        !taskIds.every((id) => typeof id === "string" && id.length > 0)
      ) {
        throw new Error("批量删除参数无效。");
      }
      return requireApi().batchDeleteTasks(taskIds as string[]);
    },
  );

  ipcMain.handle("desktop:delete-batch", async (_event, batchId: unknown) => {
    if (typeof batchId !== "string" || batchId.length === 0) {
      throw new Error("批次参数无效。");
    }
    return requireApi().deleteBatch(batchId);
  });

  ipcMain.handle(
    "desktop:task-preview-image",
    async (_event, taskId: unknown) => {
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new Error("任务参数无效。");
      }
      return requireApi().taskPreviewImage(taskId);
    },
  );

  ipcMain.handle(
    "desktop:stream-task-video",
    async (_event, taskId: unknown) => {
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new Error("任务参数无效。");
      }
      const asset = await requireApi().downloadVideo(taskId);
      return { contentType: "video/mp4", contents: asset.contents };
    },
  );

  ipcMain.handle("desktop:download-video", async (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("任务参数无效。");
    }
    return saveAssetWithDialog(await requireApi().downloadVideo(taskId), {
      title: "保存视频",
      filterName: "视频",
      extensions: ["mp4"],
    });
  });

  ipcMain.handle("desktop:download-images", async (_event, taskId: unknown) => {
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error("任务参数无效。");
    }
    return saveAssetWithDialog(await requireApi().downloadImages(taskId), {
      title: "保存图片 ZIP",
      filterName: "ZIP 压缩包",
      extensions: ["zip"],
    });
  });

  ipcMain.handle("desktop:download-batch", async (_event, batchId: unknown) => {
    if (typeof batchId !== "string" || batchId.length === 0) {
      throw new Error("批次参数无效。");
    }
    return saveAssetWithDialog(await requireApi().downloadBatch(batchId), {
      title: "保存批次成品 ZIP",
      filterName: "ZIP 压缩包",
      extensions: ["zip"],
    });
  });

  ipcMain.handle(
    "desktop:download-batch-videos",
    async (_event, batchId: unknown) => {
      if (typeof batchId !== "string" || batchId.length === 0) {
        throw new Error("批次参数无效。");
      }
      return saveAssetWithDialog(
        await requireApi().downloadBatchVideos(batchId),
        {
          title: "保存全部视频 ZIP",
          filterName: "ZIP 压缩包",
          extensions: ["zip"],
        },
      );
    },
  );

  ipcMain.handle(
    "desktop:download-batch-images",
    async (_event, batchId: unknown) => {
      if (typeof batchId !== "string" || batchId.length === 0) {
        throw new Error("批次参数无效。");
      }
      return saveAssetWithDialog(
        await requireApi().downloadBatchImages(batchId),
        {
          title: "保存全部图片 ZIP",
          filterName: "ZIP 压缩包",
          extensions: ["zip"],
        },
      );
    },
  );

  ipcMain.handle(
    "desktop:download-result-workbook",
    async (_event, batchId: unknown) => {
      if (typeof batchId !== "string" || batchId.length === 0) {
        throw new Error("批次参数无效。");
      }
      return saveAssetWithDialog(
        await requireApi().downloadResultWorkbook(batchId),
        {
          title: "保存结果表",
          filterName: "Excel",
          extensions: ["xlsx"],
        },
      );
    },
  );

  ipcMain.handle("desktop:get-bgm", async () => requireApi().getBgm());

  ipcMain.handle("desktop:update-bgm", async (_event, patch: unknown) => {
    if (!isBgmPatch(patch)) throw new Error("背景音乐参数无效。");
    return requireApi().updateBgm(patch);
  });

  ipcMain.handle("desktop:upload-bgm", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择背景音乐",
      properties: ["openFile"],
      filters: [{ name: "音频", extensions: ["mp3", "m4a", "wav"] }],
    });
    const audioPath = result.canceled ? null : result.filePaths[0];
    return audioPath ? requireApi().uploadBgm(audioPath) : null;
  });

  ipcMain.handle("desktop:clear-bgm", async () => requireApi().clearBgm());

  ipcMain.handle("desktop:preview-bgm", async () => requireApi().previewBgm());

  ipcMain.handle("desktop:get-processing", async () =>
    requireApi().getProcessing(),
  );

  ipcMain.handle(
    "desktop:update-processing",
    async (_event, patch: unknown) => {
      if (!isProcessingPatch(patch)) throw new Error("处理设置参数无效。");
      return requireApi().updateProcessing(patch);
    },
  );
}

/** Prompts for a destination and writes the asset; null when cancelled. */
async function saveAssetWithDialog(
  asset: DownloadedAsset,
  options: { title: string; filterName: string; extensions: string[] },
): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: options.title,
    defaultPath: asset.fileName,
    filters: [{ name: options.filterName, extensions: options.extensions }],
  });
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, asset.contents);
  return result.filePath;
}

function requireApi(): DesktopApi {
  if (!localApi) throw new Error("本地任务服务尚未就绪。");
  return localApi;
}

function isImportRequest(
  value: unknown,
): value is { path: string; startRow?: number; endRow?: number } {
  if (typeof value !== "object" || value === null) return false;
  const patch = value as Record<string, unknown>;
  return (
    typeof patch.path === "string" &&
    patch.path.length > 0 &&
    (patch.startRow === undefined || typeof patch.startRow === "number") &&
    (patch.endRow === undefined || typeof patch.endRow === "number")
  );
}

function isKeywordUpdate(
  value: unknown,
): value is {
  taskId: string;
  articleKeyword: string;
  tailNoteTemplate?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "articleKeyword" in value &&
    typeof value.taskId === "string" &&
    typeof value.articleKeyword === "string" &&
    (!("tailNoteTemplate" in value) ||
      typeof (value as Record<string, unknown>).tailNoteTemplate === "string" ||
      (value as Record<string, unknown>).tailNoteTemplate === undefined)
  );
}

function isManualContentUpdate(
  value: unknown,
): value is { taskId: string; title: string; content: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "title" in value &&
    "content" in value &&
    typeof value.taskId === "string" &&
    typeof value.title === "string" &&
    typeof value.content === "string"
  );
}

function isProcessingPatch(value: unknown): value is {
  concurrency?: number;
  coverPageDurationSeconds?: number;
  bodyPageDurationSeconds?: number;
  fullContentOutput?: boolean;
  videoMode?: "slide" | "scroll";
  scrollSpeed?: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const patch = value as Record<string, unknown>;
  return (
    (patch.concurrency === undefined ||
      typeof patch.concurrency === "number") &&
    (patch.coverPageDurationSeconds === undefined ||
      typeof patch.coverPageDurationSeconds === "number") &&
    (patch.bodyPageDurationSeconds === undefined ||
      typeof patch.bodyPageDurationSeconds === "number") &&
    (patch.fullContentOutput === undefined ||
      typeof patch.fullContentOutput === "boolean") &&
    (patch.videoMode === undefined ||
      patch.videoMode === "slide" ||
      patch.videoMode === "scroll") &&
    (patch.scrollSpeed === undefined || typeof patch.scrollSpeed === "number")
  );
}

function isBgmPatch(value: unknown): value is {
  enabled?: boolean;
  presetId?: string;
  volume?: number;
  fadeOutSeconds?: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const patch = value as Record<string, unknown>;
  return (
    (patch.enabled === undefined || typeof patch.enabled === "boolean") &&
    (patch.presetId === undefined || typeof patch.presetId === "string") &&
    (patch.volume === undefined || typeof patch.volume === "number") &&
    (patch.fadeOutSeconds === undefined ||
      typeof patch.fadeOutSeconds === "number")
  );
}

function getApiModulePath(): string {
  // See createWindow: app.isPackaged is unreliable when the packaged binary
  // is launched directly, so probe for the bundled API module on disk.
  const packagedPath = join(currentDirectory, "api", "dist", "src", "app.js");
  if (existsSync(packagedPath)) {
    return packagedPath;
  }
  return join(currentDirectory, "../../api/dist/src/app.js");
}

/**
 * Locates the Chromium bundled by package-desktop.mjs. The manifest lives
 * next to the staged API (resources/app/api/playwright-browsers) and records
 * the executable path relative to itself; absent in dev runs, where the
 * resolver simply falls back to locally installed browsers.
 */
function getBundledChromiumExecutable(): string | undefined {
  const manifestPath = join(
    currentDirectory,
    "api",
    "playwright-browsers",
    "manifest.json",
  );
  try {
    if (!existsSync(manifestPath)) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      executableRelativePath?: string;
    };
    if (!manifest.executableRelativePath) return undefined;
    const executablePath = join(
      dirname(manifestPath),
      manifest.executableRelativePath,
    );
    return existsSync(executablePath) ? executablePath : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locates the FFmpeg bundled by package-desktop.mjs. The manifest lives
 * next to the staged API (resources/app/api/ffmpeg) and records the
 * executable filename; absent in dev runs, where the resolver falls back
 * to the system PATH.
 */
function getBundledFfmpegExecutable(): string | undefined {
  const manifestPath = join(currentDirectory, "api", "ffmpeg", "manifest.json");
  try {
    if (!existsSync(manifestPath)) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      executable?: string;
    };
    if (!manifest.executable) return undefined;
    const executablePath = join(dirname(manifestPath), manifest.executable);
    return existsSync(executablePath) ? executablePath : undefined;
  } catch {
    return undefined;
  }
}

app
  .whenReady()
  .then(async () => {
    // Remove the default application menu (File/Edit/View/...) on Windows.
    Menu.setApplicationMenu(null);

    localApi = await createDesktopApi({
      appDataDirectory: app.getPath("userData"),
      apiModulePath: getApiModulePath(),
      bundledChromiumExecutable: getBundledChromiumExecutable(),
      bundledFfmpegExecutable: getBundledFfmpegExecutable(),
    });
    registerIpcHandlers();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知启动错误";
    dialog.showErrorBox("知乎文章转视频无法启动", message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  ipcMain.removeHandler("desktop:select-excel");
  ipcMain.removeHandler("desktop:select-output-directory");
  ipcMain.removeHandler("desktop:list-batches");
  ipcMain.removeHandler("desktop:get-batch");
  ipcMain.removeHandler("desktop:get-task");
  ipcMain.removeHandler("desktop:preview-import");
  ipcMain.removeHandler("desktop:import-excel");
  ipcMain.removeHandler("desktop:start-batch");
  ipcMain.removeHandler("desktop:update-keyword");
  ipcMain.removeHandler("desktop:rerender-tail");
  ipcMain.removeHandler("desktop:save-manual-content");
  ipcMain.removeHandler("desktop:retry-task");
  ipcMain.removeHandler("desktop:delete-task");
  ipcMain.removeHandler("desktop:batch-delete-tasks");
  ipcMain.removeHandler("desktop:delete-batch");
  ipcMain.removeHandler("desktop:task-preview-image");
  ipcMain.removeHandler("desktop:download-video");
  ipcMain.removeHandler("desktop:download-images");
  ipcMain.removeHandler("desktop:download-batch");
  ipcMain.removeHandler("desktop:download-result-workbook");
  ipcMain.removeHandler("desktop:get-bgm");
  ipcMain.removeHandler("desktop:update-bgm");
  ipcMain.removeHandler("desktop:upload-bgm");
  ipcMain.removeHandler("desktop:clear-bgm");
  ipcMain.removeHandler("desktop:preview-bgm");
  ipcMain.removeHandler("desktop:get-processing");
  ipcMain.removeHandler("desktop:update-processing");
  void localApi?.close();
});
