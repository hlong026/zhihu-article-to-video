import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  selectExcel: (): Promise<string | null> =>
    ipcRenderer.invoke("desktop:select-excel"),
  selectOutputDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("desktop:select-output-directory"),
  listBatches: () => ipcRenderer.invoke("desktop:list-batches"),
  getBatch: (batchId: string) =>
    ipcRenderer.invoke("desktop:get-batch", batchId),
  getTask: (taskId: string) => ipcRenderer.invoke("desktop:get-task", taskId),
  previewImport: (path: string) =>
    ipcRenderer.invoke("desktop:preview-import", path),
  importExcel: (input: { path: string; startRow?: number; endRow?: number }) =>
    ipcRenderer.invoke("desktop:import-excel", input),
  startBatch: (batchId: string) =>
    ipcRenderer.invoke("desktop:start-batch", batchId),
  updateKeyword: (
    taskId: string,
    articleKeyword: string,
    tailNoteTemplate?: string,
  ) =>
    ipcRenderer.invoke("desktop:update-keyword", {
      taskId,
      articleKeyword,
      tailNoteTemplate,
    }),
  rerenderTail: (taskId: string) =>
    ipcRenderer.invoke("desktop:rerender-tail", taskId),
  saveManualContent: (taskId: string, title: string, content: string) =>
    ipcRenderer.invoke("desktop:save-manual-content", {
      taskId,
      title,
      content,
    }),
  retryTask: (taskId: string) =>
    ipcRenderer.invoke("desktop:retry-task", taskId),
  deleteTask: (taskId: string) =>
    ipcRenderer.invoke("desktop:delete-task", taskId),
  batchDeleteTasks: (taskIds: string[]) =>
    ipcRenderer.invoke("desktop:batch-delete-tasks", taskIds),
  deleteBatch: (batchId: string) =>
    ipcRenderer.invoke("desktop:delete-batch", batchId),
  taskPreviewImage: (taskId: string) =>
    ipcRenderer.invoke("desktop:task-preview-image", taskId),
  streamTaskVideo: (taskId: string) =>
    ipcRenderer.invoke("desktop:stream-task-video", taskId),
  downloadVideo: (taskId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-video", taskId),
  downloadImages: (taskId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-images", taskId),
  downloadBatch: (batchId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-batch", batchId),
  downloadBatchVideos: (batchId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-batch-videos", batchId),
  downloadBatchImages: (batchId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-batch-images", batchId),
  downloadResultWorkbook: (batchId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-result-workbook", batchId),
  getBgm: () => ipcRenderer.invoke("desktop:get-bgm"),
  updateBgm: (patch: {
    enabled?: boolean;
    presetId?: string;
    volume?: number;
    fadeOutSeconds?: number;
  }) => ipcRenderer.invoke("desktop:update-bgm", patch),
  uploadBgm: () => ipcRenderer.invoke("desktop:upload-bgm"),
  previewBgm: () => ipcRenderer.invoke("desktop:preview-bgm"),
  clearBgm: () => ipcRenderer.invoke("desktop:clear-bgm"),
  getProcessing: () => ipcRenderer.invoke("desktop:get-processing"),
  updateProcessing: (patch: {
    concurrency?: number;
    coverPageDurationSeconds?: number;
    bodyPageDurationSeconds?: number;
    fullContentOutput?: boolean;
    videoMode?: "slide" | "scroll";
    scrollSpeed?: number;
    imageExportRatio?: "9:16" | "3:4";
    hideInteractionButtons?: boolean;
  }) => ipcRenderer.invoke("desktop:update-processing", patch),
});
