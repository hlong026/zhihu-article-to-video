import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ArticleTask,
  ArticleTaskDetail,
  BatchDetailView,
  BatchSummary,
  BgmSettingsView,
  ImportPreview,
  ProcessingSettings,
} from "@zhihu-video/contracts";

type ApiReply = {
  statusCode: number;
  body: string;
  rawPayload: Buffer;
  headers: Record<string, string | string[] | undefined>;
};

type LocalFastify = {
  inject(options: {
    method: "GET" | "PATCH" | "POST" | "PUT" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    payload?: Buffer | string;
  }): Promise<ApiReply>;
  close(): Promise<void>;
};

type BatchDetail = BatchSummary & { tasks: ArticleTask[] };

type ApiModule = {
  buildApp(options: {
    databasePath: string;
    outputDirectory: string;
    logger: boolean;
    bundledChromiumExecutable?: string;
    bundledFfmpegExecutable?: string;
  }): LocalFastify;
};

export interface DownloadedAsset {
  fileName: string;
  contents: Buffer;
}

export interface ImportRange {
  startRow?: number;
  endRow?: number;
}

const workbookContentType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface DesktopApi {
  listBatches(): Promise<BatchDetail[]>;
  getBatch(batchId: string): Promise<BatchDetailView>;
  getTask(taskId: string): Promise<ArticleTaskDetail>;
  previewWorkbook(workbookPath: string): Promise<ImportPreview>;
  importWorkbook(
    workbookPath: string,
    range?: ImportRange,
  ): Promise<BatchDetail>;
  startBatch(batchId: string): Promise<BatchDetail>;
  updateKeyword(taskId: string, articleKeyword: string, tailNoteTemplate?: string): Promise<ArticleTask>;
  rerenderTail(taskId: string): Promise<ArticleTask>;
  saveManualContent(
    taskId: string,
    input: { title: string; content: string },
  ): Promise<ArticleTask>;
  retryTask(taskId: string): Promise<ArticleTask>;
  deleteTask(taskId: string): Promise<{ ok: boolean }>;
  batchDeleteTasks(taskIds: string[]): Promise<{ ok: boolean; deletedCount: number }>;
  deleteBatch(batchId: string): Promise<{ ok: boolean }>;
  taskPreviewImage(taskId: string): Promise<BgmPreviewAsset>;
  downloadVideo(taskId: string): Promise<DownloadedAsset>;
  downloadImages(taskId: string): Promise<DownloadedAsset>;
  downloadBatch(batchId: string): Promise<DownloadedAsset>;
  downloadBatchVideos(batchId: string): Promise<DownloadedAsset>;
  downloadResultWorkbook(batchId: string): Promise<DownloadedAsset>;
  getBgm(): Promise<BgmSettingsView>;
  updateBgm(patch: BgmPatch): Promise<BgmSettingsView>;
  uploadBgm(audioPath: string): Promise<BgmSettingsView>;
  previewBgm(): Promise<BgmPreviewAsset>;
  clearBgm(): Promise<BgmSettingsView>;
  getProcessing(): Promise<ProcessingSettings>;
  updateProcessing(patch: ProcessingSettings): Promise<ProcessingSettings>;
  close(): Promise<void>;
}

export interface BgmPreviewAsset {
  contentType: string;
  contents: Buffer;
}

export interface BgmPatch {
  enabled?: boolean;
  presetId?: string;
  volume?: number;
  fadeOutSeconds?: number;
}

const AUDIO_CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

export async function createDesktopApi(options: {
  appDataDirectory: string;
  apiModulePath: string;
  bundledChromiumExecutable?: string;
  bundledFfmpegExecutable?: string;
}): Promise<DesktopApi> {
  const apiModule = (await import(
    pathToFileURL(options.apiModulePath).href
  )) as ApiModule;
  const app = apiModule.buildApp({
    databasePath: join(
      options.appDataDirectory,
      "zhihu-article-to-video.sqlite",
    ),
    outputDirectory: join(options.appDataDirectory, "outputs"),
    logger: false,
    bundledChromiumExecutable: options.bundledChromiumExecutable,
    bundledFfmpegExecutable: options.bundledFfmpegExecutable,
  });

  return {
    listBatches: () =>
      send<BatchDetail[]>(app, { method: "GET", url: "/api/batches" }),
    getBatch: (batchId) =>
      send<BatchDetailView>(app, {
        method: "GET",
        url: `/api/batches/${encodeURIComponent(batchId)}`,
      }),
    getTask: (taskId) =>
      send<ArticleTaskDetail>(app, {
        method: "GET",
        url: `/api/tasks/${encodeURIComponent(taskId)}`,
      }),
    async previewWorkbook(workbookPath: string): Promise<ImportPreview> {
      const contents = await readFile(workbookPath);
      return send<ImportPreview>(app, {
        method: "POST",
        url: "/api/batches/import/preview",
        headers: {
          "content-type": workbookContentType,
          "x-file-name": basename(workbookPath),
        },
        payload: contents,
      });
    },
    async importWorkbook(
      workbookPath: string,
      range: ImportRange = {},
    ): Promise<BatchDetail> {
      const contents = await readFile(workbookPath);
      const query = new URLSearchParams();
      if (range.startRow !== undefined) {
        query.set("startRow", String(range.startRow));
      }
      if (range.endRow !== undefined) {
        query.set("endRow", String(range.endRow));
      }
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return send<BatchDetail>(app, {
        method: "POST",
        url: `/api/batches/import${suffix}`,
        headers: {
          "content-type": workbookContentType,
          "x-file-name": basename(workbookPath),
        },
        payload: contents,
      });
    },
    startBatch: (batchId) =>
      send<BatchDetail>(app, {
        method: "POST",
        url: `/api/batches/${encodeURIComponent(batchId)}/start`,
      }),
    updateKeyword: (taskId, articleKeyword, tailNoteTemplate) =>
      send<ArticleTask>(app, {
        method: "PATCH",
        url: `/api/tasks/${encodeURIComponent(taskId)}`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          articleKeyword,
          ...(tailNoteTemplate !== undefined ? { tailNote: tailNoteTemplate } : {}),
        }),
      }),
    rerenderTail: (taskId) =>
      send<ArticleTask>(app, {
        method: "POST",
        url: `/api/tasks/${encodeURIComponent(taskId)}/rerender-tail`,
      }),
    saveManualContent: (taskId, input) =>
      send<ArticleTask>(app, {
        method: "PUT",
        url: `/api/tasks/${encodeURIComponent(taskId)}/manual-content`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(input),
      }),
    retryTask: (taskId) =>
      send<ArticleTask>(app, {
        method: "POST",
        url: `/api/tasks/${encodeURIComponent(taskId)}/retry`,
      }),
    deleteTask: (taskId) =>
      send<{ ok: boolean }>(app, {
        method: "DELETE",
        url: `/api/tasks/${encodeURIComponent(taskId)}`,
      }),
    batchDeleteTasks: (taskIds) =>
      send<{ ok: boolean; deletedCount: number }>(app, {
        method: "POST",
        url: "/api/tasks/batch-delete",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ taskIds }),
      }),
    deleteBatch: (batchId) =>
      send<{ ok: boolean }>(app, {
        method: "DELETE",
        url: `/api/batches/${encodeURIComponent(batchId)}`,
      }),
    taskPreviewImage: (taskId) =>
      streamAsset(app, `/api/tasks/${encodeURIComponent(taskId)}/preview-image`),
    downloadVideo: (taskId) =>
      downloadAsset(
        app,
        `/api/tasks/${encodeURIComponent(taskId)}/download/video`,
      ),
    downloadImages: (taskId) =>
      downloadAsset(
        app,
        `/api/tasks/${encodeURIComponent(taskId)}/download/images`,
      ),
    downloadBatch: (batchId) =>
      downloadAsset(
        app,
        `/api/batches/${encodeURIComponent(batchId)}/download`,
      ),
    downloadBatchVideos: (batchId) =>
      downloadAsset(
        app,
        `/api/batches/${encodeURIComponent(batchId)}/download-videos`,
      ),
    downloadResultWorkbook: (batchId) =>
      downloadAsset(
        app,
        `/api/batches/${encodeURIComponent(batchId)}/result.xlsx`,
      ),
    getBgm: () =>
      send<BgmSettingsView>(app, { method: "GET", url: "/api/settings/bgm" }),
    updateBgm: (patch) =>
      send<BgmSettingsView>(app, {
        method: "PUT",
        url: "/api/settings/bgm",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(patch),
      }),
    async uploadBgm(audioPath: string): Promise<BgmSettingsView> {
      const contents = await readFile(audioPath);
      const extension = extname(audioPath).toLowerCase();
      return send<BgmSettingsView>(app, {
        method: "POST",
        url: "/api/settings/bgm/upload",
        headers: {
          "content-type":
            AUDIO_CONTENT_TYPES[extension] ?? "application/octet-stream",
          "x-file-name": basename(audioPath),
        },
        payload: contents,
      });
    },
    clearBgm: () =>
      send<BgmSettingsView>(app, {
        method: "DELETE",
        url: "/api/settings/bgm",
      }),
    getProcessing: () =>
      send<ProcessingSettings>(app, {
        method: "GET",
        url: "/api/settings/processing",
      }),
    updateProcessing: (patch) =>
      send<ProcessingSettings>(app, {
        method: "PUT",
        url: "/api/settings/processing",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(patch),
      }),
    async previewBgm(): Promise<BgmPreviewAsset> {
      return streamAsset(app, "/api/settings/bgm/preview");
    },
    close: () => app.close(),
  };
}

async function downloadAsset(
  app: LocalFastify,
  url: string,
): Promise<DownloadedAsset> {
  const response = await app.inject({ method: "GET", url });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const payload = response.body ? (JSON.parse(response.body) as unknown) : null;
    const message = isErrorPayload(payload)
      ? payload.message
      : "成品下载失败。";
    throw new Error(message);
  }
  return {
    fileName: parseDownloadFileName(response.headers["content-disposition"]),
    contents: response.rawPayload,
  };
}

/** Streams a binary asset with its content type (previews, images). */
async function streamAsset(
  app: LocalFastify,
  url: string,
): Promise<BgmPreviewAsset> {
  const response = await app.inject({ method: "GET", url });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const payload = response.body ? (JSON.parse(response.body) as unknown) : null;
    const message = isErrorPayload(payload) ? payload.message : "读取预览失败。";
    throw new Error(message);
  }
  const contentType = response.headers["content-type"];
  return {
    contentType: Array.isArray(contentType)
      ? (contentType[0] ?? "application/octet-stream")
      : (contentType ?? "application/octet-stream"),
    contents: response.rawPayload,
  };
}

/** Reads the RFC 5987 filename* from a content-disposition header. */
function parseDownloadFileName(
  disposition: string | string[] | undefined,
): string {
  const value = Array.isArray(disposition) ? disposition[0] : disposition;
  const match = value?.match(/filename\*=UTF-8''([^;]+)/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      // Fall through to the ASCII filename when decoding fails.
    }
  }
  const ascii = value?.match(/filename="([^"]+)"/i);
  return ascii?.[1] ?? "download";
}

async function send<T>(
  app: LocalFastify,
  request: Parameters<LocalFastify["inject"]>[0],
): Promise<T> {
  const response = await app.inject(request);
  const payload = response.body ? (JSON.parse(response.body) as unknown) : null;
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const message = isErrorPayload(payload)
      ? payload.message
      : "本地任务服务请求失败。";
    throw new Error(message);
  }
  return payload as T;
}

function isErrorPayload(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}
