import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  selectExcel: (): Promise<string | null> =>
    ipcRenderer.invoke("desktop:select-excel"),
  selectOutputDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("desktop:select-output-directory"),
  listBatches: () => ipcRenderer.invoke("desktop:list-batches"),
  importExcel: () => ipcRenderer.invoke("desktop:import-excel"),
  startBatch: (batchId: string) =>
    ipcRenderer.invoke("desktop:start-batch", batchId),
  updateTailNote: (taskId: string, tailNote: string) =>
    ipcRenderer.invoke("desktop:update-tail-note", { taskId, tailNote }),
  saveManualContent: (taskId: string, title: string, content: string) =>
    ipcRenderer.invoke("desktop:save-manual-content", {
      taskId,
      title,
      content,
    }),
  retryTask: (taskId: string) =>
    ipcRenderer.invoke("desktop:retry-task", taskId),
  downloadVideo: (taskId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-video", taskId),
  downloadImages: (taskId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-images", taskId),
  downloadBatch: (batchId: string): Promise<string | null> =>
    ipcRenderer.invoke("desktop:download-batch", batchId),
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
});
