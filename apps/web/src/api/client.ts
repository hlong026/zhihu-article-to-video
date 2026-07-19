import type {
  ArticleTask,
  ArticleTaskDetail,
  BatchDetailView,
  BatchSummary,
  BgmSettingsView,
  ImportPreview,
  ProcessingSettings,
  TaskStatus,
} from "@zhihu-video/contracts";

export interface WorkbenchData {
  batch: BatchSummary;
  tasks: ArticleTask[];
}

export interface ImportResult {
  batchId: string;
  createdCount: number;
}

export interface ImportRangeSelection {
  startRow?: number;
  endRow?: number;
}

/** A workbook chosen by the operator, plus its dry-run parse report. */
export interface PreparedImport {
  /** Web uploads carry the picked File through to the final import. */
  file?: File;
  /** Desktop imports reference the chosen path over IPC. */
  path?: string;
  fileName: string;
  preview: ImportPreview;
}

interface BatchDetail extends BatchSummary {
  tasks: ArticleTask[];
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
// Mock data is limited to tests and explicit visual-preview runs. Packaged apps
// always read their local task database instead of silently showing demo results.
const useMockApi =
  import.meta.env.MODE === "test" || import.meta.env.VITE_USE_MOCKS === "true";

const mockBatch: BatchSummary = {
  id: "batch-20260715-01",
  sourceFileName: "测试知乎链接.xlsx",
  totalCount: 12,
  completedCount: 5,
  needsReviewCount: 2,
  failedCount: 1,
  createdAt: "2026-07-15T09:30:00+08:00",
};

const mockHistoryBatch: BatchSummary = {
  id: "batch-20260710-01",
  sourceFileName: "上周知乎选题.xlsx",
  totalCount: 8,
  completedCount: 8,
  needsReviewCount: 0,
  failedCount: 0,
  createdAt: "2026-07-10T14:12:00+08:00",
};

const mockTasks: ArticleTask[] = [
  {
    id: "task-001",
    batchId: mockBatch.id,
    sourceUrl: "https://www.zhihu.com/answer/1899544678284474188",
    sourceType: "answer",
    inputTitle: "为什么 AI 产品总是看起来很聪明，却不一定好用？",
    fetchedTitle: "为什么 AI 产品总是看起来很聪明，却不一定好用？",
    articleKeyword: "AI 产品好用",
    manualContent: null,
    finalTitle: "AI 产品真正难的，不是模型能力",
    finalTags: ["AI产品", "产品思考", "用户体验"],
    tailNote: "来知乎搜索🔍AI 产品好用可以看到全文",
    status: "completed",
    step: "completed",
    progress: 100,
    failureCode: null,
    failureMessage: null,
    updatedAt: "2026-07-15T10:12:00+08:00",
  },
  {
    id: "task-002",
    batchId: mockBatch.id,
    sourceUrl: "https://zhuanlan.zhihu.com/p/1918601484182702048",
    sourceType: "article",
    inputTitle: "大模型时代，普通人的学习方式正在改变",
    fetchedTitle: "大模型时代，普通人的学习方式正在改变",
    articleKeyword: "大模型学习方式",
    manualContent: null,
    finalTitle: "大模型改变的，是学习的反馈速度",
    finalTags: ["大模型", "学习方法", "个人成长"],
    tailNote: "来知乎搜索🔍大模型学习方式可以看到全文",
    status: "rendering_video",
    step: "rendering_video",
    progress: 82,
    failureCode: null,
    failureMessage: null,
    updatedAt: "2026-07-15T10:10:00+08:00",
  },
  {
    id: "task-003",
    batchId: mockBatch.id,
    sourceUrl: "https://www.zhihu.com/answer/1908050221872285506",
    sourceType: "answer",
    inputTitle: "一个人如何建立稳定的内容输出系统？",
    fetchedTitle: "一个人如何建立稳定的内容输出系统？",
    articleKeyword: null,
    manualContent: null,
    finalTitle: "稳定输出，靠的不是灵感",
    finalTags: ["内容创作", "个人品牌"],
    tailNote: "来知乎搜索🔍{文章口令}可以看到全文",
    status: "needs_review",
    step: "needs_review",
    progress: 68,
    failureCode: "KEYWORD_REQUIRED",
    failureMessage: "缺少文章口令，请补充后重新生成尾页。",
    updatedAt: "2026-07-15T10:06:00+08:00",
  },
  {
    id: "task-004",
    batchId: mockBatch.id,
    sourceUrl: "https://zhuanlan.zhihu.com/p/1900727154329207301",
    sourceType: "article",
    inputTitle: "做内容前，先找到那个值得讲的问题",
    fetchedTitle: null,
    articleKeyword: "值得讲的问题",
    manualContent: null,
    finalTitle: null,
    finalTags: [],
    tailNote: "来知乎搜索🔍值得讲的问题可以看到全文",
    status: "failed",
    step: "failed",
    progress: 12,
    failureCode: "CONTENT_UNAVAILABLE",
    failureMessage: "文章正文暂时无法读取，可稍后重试。",
    updatedAt: "2026-07-15T09:56:00+08:00",
  },
  {
    id: "task-005",
    batchId: mockBatch.id,
    sourceUrl: "https://www.zhihu.com/answer/1911802157208434241",
    sourceType: "answer",
    inputTitle: "为什么真正有效的复盘，总让人有点不舒服？",
    fetchedTitle: null,
    articleKeyword: "有效复盘",
    manualContent: null,
    finalTitle: null,
    finalTags: [],
    tailNote: "来知乎搜索🔍有效复盘可以看到全文",
    status: "pending",
    step: "pending",
    progress: 0,
    failureCode: null,
    failureMessage: null,
    updatedAt: "2026-07-15T09:30:00+08:00",
  },
];

let mockBgm: BgmSettingsView = {
  enabled: false,
  source: null,
  presetId: null,
  fileName: null,
  volume: 0.3,
  fadeOutSeconds: 1,
  presets: [
    { id: "soft-ambient", name: "轻柔氛围" },
    { id: "warm-pad", name: "温暖铺底" },
  ],
  hasAudio: false,
};

let mockProcessing: ProcessingSettings = { concurrency: 5 };

function mockDelay<T>(value: T): Promise<T> {
  return new Promise((resolve) => window.setTimeout(() => resolve(value), 180));
}

function mockTaskDetail(task: ArticleTask): ArticleTaskDetail {
  const isCompleted = task.status === "completed";
  return {
    ...task,
    attempts: [
      {
        id: `${task.id}-attempt-1`,
        attemptNumber: 1,
        step: task.step ?? task.status,
        status: task.status,
        message: task.failureMessage,
        createdAt: task.updatedAt,
      },
    ],
    artifacts: isCompleted
      ? { imageCount: 8, videoReady: true, durationSeconds: 15 }
      : null,
  };
}

function mockBatchDetail(batch: BatchSummary): BatchDetailView {
  const tasks =
    batch.id === mockBatch.id
      ? mockTasks
      : mockTasks.map((task) => ({
          ...task,
          id: `${batch.id}-${task.id}`,
          batchId: batch.id,
          status: "completed" as const,
          step: "completed" as const,
          progress: 100,
          failureCode: null,
          failureMessage: null,
        }));
  return {
    ...batch,
    status: "processing",
    tasks,
    importErrors:
      batch.id === mockBatch.id
        ? [
            {
              rowNumber: 6,
              code: "DUPLICATE_URL",
              message: "与第 2 行链接重复，已跳过。",
            },
          ]
        : [],
  };
}

/** Derives the locked tail-note copy for a keyword; mirrors the API helper. */
export function renderTailNotePreview(articleKeyword: string): string {
  return `来知乎搜索🔍${articleKeyword.trim()}可以看到全文`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "请求失败，请稍后再试。");
  }

  return response.json() as Promise<T>;
}

function importQuery(range: ImportRangeSelection): string {
  const query = new URLSearchParams();
  if (range.startRow !== undefined) query.set("startRow", String(range.startRow));
  if (range.endRow !== undefined) query.set("endRow", String(range.endRow));
  const text = query.toString();
  return text ? `?${text}` : "";
}

export const apiClient = {
  async getWorkbench(): Promise<WorkbenchData | null> {
    if (useMockApi) {
      return mockDelay({ batch: mockBatch, tasks: mockTasks });
    }

    if (window.desktop) {
      const batches = await window.desktop.listBatches();
      const batch = batches[0];
      return batch ? { batch, tasks: batch.tasks } : null;
    }

    const batches = await request<BatchDetail[]>("/api/batches");
    const batch = batches[0];
    if (!batch) return null;
    return { batch, tasks: batch.tasks };
  },

  async getBatches(): Promise<BatchSummary[]> {
    if (useMockApi) return mockDelay([mockBatch, mockHistoryBatch]);
    if (window.desktop) return window.desktop.listBatches();
    return request<BatchSummary[]>("/api/batches");
  },

  async getBatch(batchId: string): Promise<BatchDetailView> {
    if (useMockApi) {
      const batch = [mockBatch, mockHistoryBatch].find(
        (candidate) => candidate.id === batchId,
      );
      if (!batch) throw new Error("批次不存在。");
      return mockDelay(mockBatchDetail(batch));
    }
    if (window.desktop) return window.desktop.getBatch(batchId);
    return request<BatchDetailView>(`/api/batches/${batchId}`);
  },

  async getTask(taskId: string): Promise<ArticleTaskDetail> {
    if (useMockApi) {
      const task = mockTasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("任务不存在。");
      return mockDelay(mockTaskDetail(task));
    }
    if (window.desktop) return window.desktop.getTask(taskId);
    return request<ArticleTaskDetail>(`/api/tasks/${taskId}`);
  },

  /**
   * Two-step import, step 1: parse the chosen workbook without persisting
   * anything so the operator can pick a row range. Returns null when the
   * desktop file dialog is cancelled.
   */
  async prepareImport(file?: File): Promise<PreparedImport | null> {
    if (useMockApi) {
      return mockDelay({
        file,
        fileName: file?.name ?? "知乎链接.xlsx",
        preview: {
          totalDataRows: 12,
          validCount: 11,
          errorCount: 1,
          sample: mockTasks.slice(0, 5).map((task, index) => ({
            rowNumber: index + 1,
            sourceUrl: task.sourceUrl,
            inputTitle: task.inputTitle,
            hasKeyword: Boolean(task.articleKeyword),
          })),
        },
      });
    }

    if (window.desktop) {
      const path = await window.desktop.selectExcel();
      if (!path) return null;
      const preview = await window.desktop.previewImport(path);
      return { path, fileName: path.split(/[\\/]/).pop() ?? path, preview };
    }

    if (!file) throw new Error("请选择 Excel 文件。");
    const body = new FormData();
    body.append("file", file);
    const preview = await request<ImportPreview>(
      "/api/batches/import/preview",
      { method: "POST", body },
    );
    return { file, fileName: file.name, preview };
  },

  /** Two-step import, step 2: import the chosen rows and create the batch. */
  async confirmImport(
    prepared: PreparedImport,
    range: ImportRangeSelection,
  ): Promise<ImportResult> {
    if (useMockApi) {
      const createdCount =
        range.startRow !== undefined || range.endRow !== undefined
          ? Math.max(
              0,
              (range.endRow ?? prepared.preview.totalDataRows) -
                (range.startRow ?? 1) +
                1,
            )
          : prepared.preview.validCount;
      return mockDelay({ batchId: mockBatch.id, createdCount });
    }

    if (window.desktop) {
      if (!prepared.path) throw new Error("请先选择 Excel 文件。");
      const batch = await window.desktop.importExcel({
        path: prepared.path,
        startRow: range.startRow,
        endRow: range.endRow,
      });
      return { batchId: batch.id, createdCount: batch.totalCount };
    }

    if (!prepared.file) throw new Error("请选择 Excel 文件。");
    const body = new FormData();
    body.append("file", prepared.file);
    const batch = await request<BatchDetail>(
      `/api/batches/import${importQuery(range)}`,
      { method: "POST", body },
    );
    return { batchId: batch.id, createdCount: batch.totalCount };
  },

  async updateKeyword(
    taskId: string,
    articleKeyword: string,
  ): Promise<ArticleTask> {
    if (useMockApi) {
      const task = mockTasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("任务不存在。");
      task.articleKeyword = articleKeyword;
      task.tailNote = renderTailNotePreview(articleKeyword);
      task.updatedAt = new Date().toISOString();
      return mockDelay({ ...task });
    }

    if (window.desktop) return window.desktop.updateKeyword(taskId, articleKeyword);

    return request<ArticleTask>(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleKeyword }),
    });
  },

  async rerenderTail(taskId: string): Promise<ArticleTask> {
    if (useMockApi) {
      const task = mockTasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("任务不存在。");
      task.updatedAt = new Date().toISOString();
      return mockDelay({ ...task });
    }

    if (window.desktop) return window.desktop.rerenderTail(taskId);

    return request<ArticleTask>(`/api/tasks/${taskId}/rerender-tail`, {
      method: "POST",
    });
  },

  async saveManualContent(
    taskId: string,
    title: string,
    content: string,
  ): Promise<ArticleTask> {
    if (useMockApi) {
      const task = mockTasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("任务不存在。");
      task.manualContent = {
        title,
        paragraphs: content.split(/\n{2,}|\n/).filter(Boolean),
      };
      task.updatedAt = new Date().toISOString();
      return mockDelay({ ...task });
    }

    if (window.desktop) {
      return window.desktop.saveManualContent(taskId, title, content);
    }

    return request<ArticleTask>(`/api/tasks/${taskId}/manual-content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
  },

  async startBatch(batchId: string): Promise<void> {
    if (useMockApi) return;
    if (window.desktop) {
      await window.desktop.startBatch(batchId);
      return;
    }
    await request<BatchDetail>(`/api/batches/${batchId}/start`, {
      method: "POST",
    });
  },

  async retryTask(taskId: string): Promise<ArticleTask> {
    if (useMockApi) {
      const task = mockTasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("任务不存在。");
      task.status = "fetching";
      task.step = "fetching";
      task.progress = 8;
      task.failureCode = null;
      task.failureMessage = null;
      return mockDelay({ ...task });
    }

    if (window.desktop) return window.desktop.retryTask(taskId);

    return request<ArticleTask>(`/api/tasks/${taskId}/retry`, {
      method: "POST",
    });
  },

  getDownloadUrl(taskId: string, asset: "video" | "images"): string {
    return `${apiBaseUrl}/api/tasks/${taskId}/download/${asset}`;
  },

  /**
   * Resolves a displayable cover-image URL for a task. Web builds point at the
   * streaming endpoint (cache-busted after re-renders); desktop receives the
   * bytes over IPC and wraps them in an object URL the caller must revoke.
   */
  async getPreviewImageSource(taskId: string): Promise<string | null> {
    if (useMockApi) return null;
    if (window.desktop) {
      const asset = await window.desktop.taskPreviewImage(taskId);
      const blob = new Blob([asset.contents as BlobPart], {
        type: asset.contentType,
      });
      return URL.createObjectURL(blob);
    }
    return `${apiBaseUrl}/api/tasks/${taskId}/preview-image?t=${Date.now()}`;
  },

  async getBgm(): Promise<BgmSettingsView> {
    if (useMockApi) return mockDelay({ ...mockBgm });
    if (window.desktop) return window.desktop.getBgm();
    return request<BgmSettingsView>("/api/settings/bgm");
  },

  async updateBgm(patch: {
    enabled?: boolean;
    presetId?: string;
    volume?: number;
    fadeOutSeconds?: number;
  }): Promise<BgmSettingsView> {
    if (useMockApi) {
      const preset = patch.presetId
        ? mockBgm.presets.find((item) => item.id === patch.presetId)
        : undefined;
      mockBgm = {
        ...mockBgm,
        ...patch,
        ...(preset
          ? { source: "preset", presetId: preset.id, fileName: preset.name }
          : {}),
        hasAudio: preset ? true : mockBgm.hasAudio,
      };
      return mockDelay({ ...mockBgm });
    }
    if (window.desktop) return window.desktop.updateBgm(patch);
    return request<BgmSettingsView>("/api/settings/bgm", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  async uploadBgm(file?: File): Promise<BgmSettingsView | null> {
    if (useMockApi) {
      mockBgm = {
        ...mockBgm,
        enabled: true,
        source: "upload",
        presetId: null,
        fileName: file?.name ?? "本地音频.mp3",
        hasAudio: true,
      };
      return mockDelay({ ...mockBgm });
    }
    if (window.desktop) return window.desktop.uploadBgm();
    if (!file) throw new Error("请选择音频文件。");
    const body = new FormData();
    body.append("file", file);
    return request<BgmSettingsView>("/api/settings/bgm/upload", {
      method: "POST",
      body,
    });
  },

  async clearBgm(): Promise<BgmSettingsView> {
    if (useMockApi) {
      mockBgm = {
        ...mockBgm,
        enabled: false,
        source: null,
        presetId: null,
        fileName: null,
        hasAudio: false,
      };
      return mockDelay({ ...mockBgm });
    }
    if (window.desktop) return window.desktop.clearBgm();
    return request<BgmSettingsView>("/api/settings/bgm", { method: "DELETE" });
  },

  /**
   * Resolves a playable source URL for the current background track. Web builds
   * point an <audio> element at the streaming endpoint (cache-busted so switching
   * tracks is reflected); the desktop app has no HTTP surface, so the bytes come
   * over IPC and are wrapped in an object URL the caller must revoke.
   */
  async getBgmPreviewSource(): Promise<string | null> {
    if (useMockApi) return null;
    if (window.desktop) {
      const asset = await window.desktop.previewBgm();
      const blob = new Blob([asset.contents as BlobPart], {
        type: asset.contentType,
      });
      return URL.createObjectURL(blob);
    }
    return `${apiBaseUrl}/api/settings/bgm/preview?t=${Date.now()}`;
  },

  async getProcessing(): Promise<ProcessingSettings> {
    if (useMockApi) return mockDelay({ ...mockProcessing });
    if (window.desktop) return window.desktop.getProcessing();
    return request<ProcessingSettings>("/api/settings/processing");
  },

  async updateProcessing(patch: {
    concurrency: number;
  }): Promise<ProcessingSettings> {
    if (useMockApi) {
      mockProcessing = { concurrency: patch.concurrency };
      return mockDelay({ ...mockProcessing });
    }
    if (window.desktop) return window.desktop.updateProcessing(patch);
    return request<ProcessingSettings>("/api/settings/processing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  getBatchDownloadUrl(batchId: string): string {
    return `${apiBaseUrl}/api/batches/${batchId}/download`;
  },

  getResultWorkbookUrl(batchId: string): string {
    return `${apiBaseUrl}/api/batches/${batchId}/result.xlsx`;
  },

  async deleteTask(taskId: string): Promise<void> {
    if (useMockApi) {
      const index = mockTasks.findIndex((t) => t.id === taskId);
      if (index !== -1) mockTasks.splice(index, 1);
      return mockDelay(undefined);
    }
    if (window.desktop) {
      await window.desktop.deleteTask(taskId);
      return;
    }
    await request<{ ok: boolean }>(`/api/tasks/${taskId}`, {
      method: "DELETE",
    });
  },

  async batchDeleteTasks(taskIds: string[]): Promise<{ deletedCount: number }> {
    if (useMockApi) {
      const idSet = new Set(taskIds);
      for (let i = mockTasks.length - 1; i >= 0; i--) {
        if (idSet.has(mockTasks[i].id)) mockTasks.splice(i, 1);
      }
      return mockDelay({ deletedCount: taskIds.length });
    }
    if (window.desktop) {
      return window.desktop.batchDeleteTasks(taskIds);
    }
    return request<{ ok: boolean; deletedCount: number }>(
      "/api/tasks/batch-delete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds }),
      },
    );
  },

  async deleteBatch(batchId: string): Promise<void> {
    if (useMockApi) return mockDelay(undefined);
    if (window.desktop) {
      await window.desktop.deleteBatch(batchId);
      return;
    }
    await request<{ ok: boolean }>(`/api/batches/${batchId}`, {
      method: "DELETE",
    });
  },
};

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "needs_review"
  );
}

/** True while the worker is actively moving the task through the pipeline. */
export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (
    status === "fetching" ||
    status === "summarizing" ||
    status === "rendering_images" ||
    status === "rendering_video"
  );
}
