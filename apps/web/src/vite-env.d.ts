/// <reference types="vite/client" />

import type {
  ArticleTask,
  ArticleTaskDetail,
  BatchDetailView,
  BatchSummary,
  BgmSettingsView,
  ImportPreview,
  ProcessingSettings,
} from "@zhihu-video/contracts";

interface DesktopBatch extends BatchSummary {
  tasks: ArticleTask[];
}

declare global {
  interface Window {
    desktop?: {
      /** Opens a file dialog and returns the chosen workbook path. */
      selectExcel(): Promise<string | null>;
      listBatches(): Promise<DesktopBatch[]>;
      getBatch(batchId: string): Promise<BatchDetailView>;
      getTask(taskId: string): Promise<ArticleTaskDetail>;
      previewImport(path: string): Promise<ImportPreview>;
      importExcel(input: {
        path: string;
        startRow?: number;
        endRow?: number;
      }): Promise<DesktopBatch>;
      startBatch(batchId: string): Promise<DesktopBatch>;
      updateKeyword(
        taskId: string,
        articleKeyword: string,
      ): Promise<ArticleTask>;
      rerenderTail(taskId: string): Promise<ArticleTask>;
      saveManualContent(
        taskId: string,
        title: string,
        content: string,
      ): Promise<ArticleTask>;
      retryTask(taskId: string): Promise<ArticleTask>;
      /** Returns the first rendered card's bytes for previewing. */
      taskPreviewImage(taskId: string): Promise<{
        contentType: string;
        contents: Uint8Array;
      }>;
      /** Opens a save dialog and writes the asset; null when cancelled. */
      downloadVideo(taskId: string): Promise<string | null>;
      downloadImages(taskId: string): Promise<string | null>;
      downloadBatch(batchId: string): Promise<string | null>;
      downloadResultWorkbook(batchId: string): Promise<string | null>;
      getBgm(): Promise<BgmSettingsView>;
      updateBgm(patch: {
        enabled?: boolean;
        presetId?: string;
        volume?: number;
        fadeOutSeconds?: number;
      }): Promise<BgmSettingsView>;
      /** Opens a file dialog, uploads the chosen track; null when cancelled. */
      uploadBgm(): Promise<BgmSettingsView | null>;
      /** Returns the current track's bytes and MIME type for previewing. */
      previewBgm(): Promise<{ contentType: string; contents: Uint8Array }>;
      clearBgm(): Promise<BgmSettingsView>;
      getProcessing(): Promise<ProcessingSettings>;
      updateProcessing(patch: {
        concurrency: number;
      }): Promise<ProcessingSettings>;
    };
  }
}
