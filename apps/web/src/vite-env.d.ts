/// <reference types="vite/client" />

import type { ArticleTask, BatchSummary } from "@zhihu-video/contracts";
import type { BgmSettingsView } from "@zhihu-video/contracts";

interface DesktopBatch extends BatchSummary {
  tasks: ArticleTask[];
}

declare global {
  interface Window {
    desktop?: {
      listBatches(): Promise<DesktopBatch[]>;
      importExcel(): Promise<DesktopBatch | null>;
      startBatch(batchId: string): Promise<DesktopBatch>;
      updateTailNote(taskId: string, tailNote: string): Promise<ArticleTask>;
      saveManualContent(
        taskId: string,
        title: string,
        content: string,
      ): Promise<ArticleTask>;
      retryTask(taskId: string): Promise<ArticleTask>;
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
    };
  }
}
