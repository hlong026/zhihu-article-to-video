import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

  ipcMain.handle("desktop:import-excel", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择知乎链接 Excel",
      properties: ["openFile"],
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    const workbookPath = result.canceled ? null : result.filePaths[0];
    return workbookPath ? requireApi().importWorkbook(workbookPath) : null;
  });

  ipcMain.handle("desktop:start-batch", async (_event, batchId: unknown) => {
    if (typeof batchId !== "string" || batchId.length === 0)
      throw new Error("批次参数无效。");
    return requireApi().startBatch(batchId);
  });

  ipcMain.handle("desktop:update-tail-note", async (_event, input: unknown) => {
    if (!isTailNoteUpdate(input)) throw new Error("尾注参数无效。");
    return requireApi().updateTask(input.taskId, input.tailNote);
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

function isTailNoteUpdate(
  value: unknown,
): value is { taskId: string; tailNote: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "tailNote" in value &&
    typeof value.taskId === "string" &&
    typeof value.tailNote === "string"
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

app
  .whenReady()
  .then(async () => {
    localApi = await createDesktopApi({
      appDataDirectory: app.getPath("userData"),
      apiModulePath: getApiModulePath(),
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
  ipcMain.removeHandler("desktop:import-excel");
  ipcMain.removeHandler("desktop:start-batch");
  ipcMain.removeHandler("desktop:update-tail-note");
  ipcMain.removeHandler("desktop:save-manual-content");
  ipcMain.removeHandler("desktop:retry-task");
  ipcMain.removeHandler("desktop:download-video");
  ipcMain.removeHandler("desktop:download-images");
  ipcMain.removeHandler("desktop:download-batch");
  ipcMain.removeHandler("desktop:download-result-workbook");
  ipcMain.removeHandler("desktop:get-bgm");
  ipcMain.removeHandler("desktop:update-bgm");
  ipcMain.removeHandler("desktop:upload-bgm");
  ipcMain.removeHandler("desktop:clear-bgm");
  ipcMain.removeHandler("desktop:preview-bgm");
  void localApi?.close();
});
