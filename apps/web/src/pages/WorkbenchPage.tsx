import {
  FileSpreadsheet,
  Images,
  Import,
  Play,
  Upload,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ArticleTask, ArticleTaskDetail } from "@zhihu-video/contracts";

import {
  apiClient,
  isTerminalTaskStatus,
  type ImportRangeSelection,
  type PreparedImport,
  type WorkbenchData,
} from "../api/client";
import { BgmSettingsCard } from "../components/BgmSettingsCard";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ImportRangeDialog } from "../components/ImportRangeDialog";
import { ProcessingSettingsCard } from "../components/ProcessingSettingsCard";
import { TaskTable } from "../components/TaskTable";
import { useToast } from "../components/Toast";
import { WorkbenchPreview } from "../components/WorkbenchPreview";

const POLL_INTERVAL_MS = 2_000;

function getInitialSelectedTask(tasks: ArticleTask[]): ArticleTask | null {
  return tasks.find((task) => task.status === "completed") ?? tasks[0] ?? null;
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "success" | "warning";
}) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <i />
    </article>
  );
}

interface DeleteConfirmState {
  type: "single" | "batch";
  taskIds: string[];
  title: string;
}

export function WorkbenchPage() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [workbench, setWorkbench] = useState<WorkbenchData | null>(null);
  const [selectedTask, setSelectedTask] = useState<ArticleTask | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<ArticleTaskDetail | null>(null);
  const [keyword, setKeyword] = useState("");
  const [tailTemplate, setTailTemplate] = useState("");
  const keywordTaskIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPreparingImport, setIsPreparingImport] = useState(false);
  const [preparedImport, setPreparedImport] = useState<PreparedImport | null>(
    null,
  );
  const [isImporting, setIsImporting] = useState(false);
  const [isSavingKeyword, setIsSavingKeyword] = useState(false);
  const [isSavingManualContent, setIsSavingManualContent] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const syncKeyword = useCallback((task: ArticleTask | null) => {
    if (task && keywordTaskIdRef.current !== task.id) {
      keywordTaskIdRef.current = task.id;
      setKeyword(task.articleKeyword ?? "");
      setTailTemplate(
        task.tailNoteTemplate ?? "来知乎搜索🔍{文章口令}可以看到全文",
      );
    }
    if (!task) {
      keywordTaskIdRef.current = null;
      setKeyword("");
      setTailTemplate("");
    }
  }, []);

  const refresh = useCallback(async () => {
    const data = await apiClient.getWorkbench();
    setWorkbench(data);
    setSelectedTask((current) => {
      const next = data
        ? ((current && data.tasks.find((task) => task.id === current.id)) ??
          getInitialSelectedTask(data.tasks))
        : current;
      syncKeyword(next);
      return next;
    });
  }, [syncKeyword]);

  useEffect(() => {
    refresh()
      .catch((error: unknown) =>
        toast(
          error instanceof Error ? error.message : "读取任务失败。",
          "error",
        ),
      )
      .finally(() => setIsLoading(false));
  }, [refresh, toast]);

  const hasActiveTasks =
    workbench?.tasks.some((task) => !isTerminalTaskStatus(task.status)) ??
    false;
  useEffect(() => {
    if (!hasActiveTasks) return;
    const timer = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveTasks, refresh]);

  const selectedTaskId = selectedTask?.id ?? null;
  const selectedTaskUpdatedAt = selectedTask?.updatedAt ?? null;
  useEffect(() => {
    if (!selectedTaskId) {
      setSelectedDetail(null);
      return;
    }
    let cancelled = false;
    apiClient
      .getTask(selectedTaskId)
      .then((detail) => {
        if (!cancelled) setSelectedDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setSelectedDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, selectedTaskUpdatedAt]);

  function selectTask(task: ArticleTask) {
    keywordTaskIdRef.current = task.id;
    setKeyword(task.articleKeyword ?? "");
    setTailTemplate(
      task.tailNoteTemplate ?? "来知乎搜索🔍{文章口令}可以看到全文",
    );
    setSelectedTask(task);
  }

  function replaceTask(updatedTask: ArticleTask): void {
    setWorkbench((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.map((candidate) =>
              candidate.id === updatedTask.id ? updatedTask : candidate,
            ),
          }
        : current,
    );
    setSelectedTask(updatedTask);
  }

  async function beginPrepareImport(file?: File) {
    if (!window.desktop && !file) return;
    setIsPreparingImport(true);
    try {
      const prepared = await apiClient.prepareImport(file);
      if (prepared) setPreparedImport(prepared);
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Excel 解析失败，请检查文件格式。",
        "error",
      );
    } finally {
      setIsPreparingImport(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function openImportDialog(): void {
    if (window.desktop) {
      void beginPrepareImport();
      return;
    }
    fileInputRef.current?.click();
  }

  async function handleConfirmImport(range: ImportRangeSelection) {
    if (!preparedImport) return;
    setIsImporting(true);
    try {
      const result = await apiClient.confirmImport(preparedImport, range);
      await apiClient.startBatch(result.batchId);
      await refresh();
      setPreparedImport(null);
      toast(
        `已导入 ${result.createdCount} 条文章任务，批次已开始处理。`,
        "success",
      );
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "导入失败，请检查 Excel 格式。",
        "error",
      );
    } finally {
      setIsImporting(false);
    }
  }

  async function handleSaveKeyword() {
    if (!selectedTask) return;
    const nextKeyword = keyword.trim();
    if (nextKeyword.length < 2) {
      toast("口令至少需要 2 个字符。", "error");
      return;
    }
    const nextTemplate = tailTemplate.trim() || undefined;

    setIsSavingKeyword(true);
    try {
      const updatedTask = await apiClient.updateKeyword(
        selectedTask.id,
        nextKeyword,
        nextTemplate,
      );
      replaceTask(updatedTask);
      syncKeyword(updatedTask);

      if (
        updatedTask.status === "completed" ||
        updatedTask.status === "needs_review"
      ) {
        try {
          const rerendered = await apiClient.rerenderTail(updatedTask.id);
          replaceTask(rerendered);
          toast("已保存，尾页与视频已按新配置重新渲染。", "success");
        } catch (error) {
          toast(
            `已保存，但尾页重渲失败（${
              error instanceof Error ? error.message : "未知错误"
            }），可稍后重试。`,
            "error",
          );
        }
      } else {
        toast("已保存，任务生成尾页时将使用新配置。", "success");
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败。", "error");
    } finally {
      setIsSavingKeyword(false);
    }
  }

  async function handleRetry(task: ArticleTask) {
    try {
      const updatedTask = await apiClient.retryTask(task.id);
      replaceTask(updatedTask);
      syncKeyword(updatedTask);
      toast("任务已加入处理队列。", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "任务重试失败。", "error");
    }
  }

  async function handleAbort(task: ArticleTask) {
    try {
      await apiClient.abortTask(task.id);
      await refresh();
      toast("任务已取消。", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "取消任务失败。", "error");
    }
  }

  async function handleSaveManualContent(title: string, content: string) {
    if (!selectedTask) return;

    setIsSavingManualContent(true);
    try {
      const savedTask = await apiClient.saveManualContent(
        selectedTask.id,
        title,
        content,
      );
      replaceTask(savedTask);
      const retriedTask = await apiClient.retryTask(savedTask.id);
      replaceTask(retriedTask);
      toast("正文已保存，任务已跳过读取步骤重新处理。", "success");
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "正文保存失败，请重试。",
        "error",
      );
    } finally {
      setIsSavingManualContent(false);
    }
  }

  async function handleDownload(task: ArticleTask, asset: "video" | "images") {
    if (window.desktop) {
      try {
        const savedPath =
          asset === "video"
            ? await window.desktop.downloadVideo(task.id)
            : await window.desktop.downloadImages(task.id);
        toast(
          savedPath ? `已保存到：${savedPath}` : "已取消保存。",
          savedPath ? "success" : "info",
        );
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "下载失败，请稍后再试。",
          "error",
        );
      }
      return;
    }
    window.open(
      apiClient.getDownloadUrl(task.id, asset),
      "_blank",
      "noopener,noreferrer",
    );
  }

  function requestDeleteTask(task: ArticleTask) {
    const title = task.fetchedTitle ?? task.inputTitle ?? "未命名文章";
    setDeleteConfirm({ type: "single", taskIds: [task.id], title });
  }

  function requestBatchDelete(taskIds: string[]) {
    setDeleteConfirm({
      type: "batch",
      taskIds,
      title: `${taskIds.length} 个任务`,
    });
  }

  async function confirmDelete() {
    if (!deleteConfirm) return;
    setIsDeleting(true);
    try {
      if (deleteConfirm.type === "single") {
        await apiClient.deleteTask(deleteConfirm.taskIds[0]);
        toast("任务已删除。", "success");
      } else {
        const result = await apiClient.batchDeleteTasks(deleteConfirm.taskIds);
        toast(`已删除 ${result.deletedCount} 个任务。`, "success");
      }
      // Remove from local state
      const deletedSet = new Set(deleteConfirm.taskIds);
      setWorkbench((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.filter((t) => !deletedSet.has(t.id)),
            }
          : current,
      );
      if (selectedTask && deletedSet.has(selectedTask.id)) {
        setSelectedTask(null);
        setSelectedDetail(null);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除失败。", "error");
    } finally {
      setIsDeleting(false);
      setDeleteConfirm(null);
    }
  }

  if (isLoading) {
    return <div className="page-loading">正在加载当前批次…</div>;
  }

  const tasks = workbench?.tasks ?? [];
  const pendingCount = tasks.filter(
    (task) => !isTerminalTaskStatus(task.status),
  ).length;
  const terminalCount = tasks.length - pendingCount;
  const overallPercent =
    tasks.length > 0 ? Math.round((terminalCount / tasks.length) * 100) : 0;

  return (
    <div className="workbench-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">批量内容生产</p>
          <h1>工作台</h1>
          <p className="header-description">
            导入知乎链接，生成可审核的 3:4 图文视频。
          </p>
        </div>
        <div className="header-actions">
          <input
            ref={fileInputRef}
            className="visually-hidden"
            id="excel-import"
            type="file"
            accept=".xlsx,.xls"
            onChange={(event) =>
              void beginPrepareImport(event.target.files?.[0])
            }
          />
          <button
            type="button"
            className="button button-dark import-button"
            onClick={openImportDialog}
            disabled={isPreparingImport || isImporting}
          >
            <Import size={17} />
            {isPreparingImport ? "正在解析…" : "导入 Excel"}
          </button>
        </div>
      </header>

      <BgmSettingsCard onNotice={(msg) => toast(msg, "info")} />
      <ProcessingSettingsCard onNotice={(msg) => toast(msg, "info")} />

      {workbench && selectedTask ? (
        <>
          <section
            className="batch-summary"
            aria-labelledby="batch-summary-title"
          >
            <div className="batch-file">
              <span className="file-icon">
                <FileSpreadsheet size={22} />
              </span>
              <div>
                <p className="eyebrow" id="batch-summary-title">
                  当前批次
                </p>
                <strong>{workbench.batch.sourceFileName}</strong>
                <span>{workbench.batch.totalCount} 篇文章</span>
              </div>
            </div>
            <div className="batch-overall">
              <div className="batch-overall-label">
                <span>总体进度</span>
                <strong>
                  {terminalCount}/{tasks.length}（{overallPercent}%）
                </strong>
              </div>
              <div
                className="batch-overall-track"
                role="progressbar"
                aria-valuenow={overallPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="批次总体进度"
              >
                <i style={{ width: `${overallPercent}%` }} />
              </div>
              <Link
                className="text-button"
                to={`/history/${workbench.batch.id}`}
              >
                查看详情
              </Link>
              <button
                type="button"
                className="button button-primary button-sm"
                onClick={() => {
                  if (window.desktop) {
                    window.desktop
                      .downloadBatchVideos(workbench.batch.id)
                      .then((savedPath) =>
                        toast(
                          savedPath ? `已保存到：${savedPath}` : "已取消保存。",
                          savedPath ? "success" : "info",
                        ),
                      )
                      .catch((error: unknown) =>
                        toast(
                          error instanceof Error ? error.message : "下载失败。",
                          "error",
                        ),
                      );
                  } else {
                    window.open(
                      apiClient.getBatchVideosDownloadUrl(workbench.batch.id),
                      "_blank",
                      "noopener,noreferrer",
                    );
                  }
                }}
                disabled={workbench.batch.completedCount === 0}
              >
                <Video size={14} />
                下载全部视频
              </button>
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => {
                  if (window.desktop) {
                    window.desktop
                      .downloadBatchImages(workbench.batch.id)
                      .then((savedPath) =>
                        toast(
                          savedPath ? `已保存到：${savedPath}` : "已取消保存。",
                          savedPath ? "success" : "info",
                        ),
                      )
                      .catch((error: unknown) =>
                        toast(
                          error instanceof Error ? error.message : "下载失败。",
                          "error",
                        ),
                      );
                  } else {
                    window.open(
                      apiClient.getBatchImagesDownloadUrl(workbench.batch.id),
                      "_blank",
                      "noopener,noreferrer",
                    );
                  }
                }}
                disabled={workbench.batch.completedCount === 0}
              >
                <Images size={14} />
                下载全部图片
              </button>
            </div>
            <div className="metrics-row">
              <MetricCard label="待处理" value={pendingCount} tone="neutral" />
              <MetricCard
                label="已生成"
                value={workbench.batch.completedCount}
                tone="success"
              />
              <MetricCard
                label="需人工确认"
                value={workbench.batch.needsReviewCount}
                tone="warning"
              />
            </div>
          </section>

          <div className="workbench-grid">
            <TaskTable
              tasks={workbench.tasks}
              selectedTaskId={selectedTask.id}
              onSelect={selectTask}
              onRetry={(task) => void handleRetry(task)}
              onDownload={(task, asset) => void handleDownload(task, asset)}
              onDelete={requestDeleteTask}
              onBatchDelete={requestBatchDelete}
            />
            <WorkbenchPreview
              task={selectedTask}
              detail={selectedDetail}
              keyword={keyword}
              tailTemplate={tailTemplate}
              isSavingKeyword={isSavingKeyword}
              isSavingManualContent={isSavingManualContent}
              onKeywordChange={setKeyword}
              onTailTemplateChange={setTailTemplate}
              onSaveKeyword={() => void handleSaveKeyword()}
              onSaveManualContent={(title, content) =>
                void handleSaveManualContent(title, content)
              }
              onDownload={(asset) => void handleDownload(selectedTask, asset)}
            />
          </div>

          <section className="dropzone" aria-label="拖放导入区域">
            <Upload size={20} />
            <span>也可以将 Excel 文件拖到这里导入</span>
            <button
              type="button"
              className="text-button"
              onClick={openImportDialog}
            >
              <Play size={14} fill="currentColor" />
              选择文件
            </button>
          </section>
        </>
      ) : (
        <section className="empty-workbench" aria-label="空工作台">
          <FileSpreadsheet size={32} />
          <h2>先导入知乎文章链接</h2>
          <p>
            选择包含 URL、文章口令和发布日期的 Excel
            文件，即可创建本地任务批次。
          </p>
          <button
            type="button"
            className="button button-dark"
            onClick={openImportDialog}
          >
            <Import size={17} />
            选择 Excel 文件
          </button>
        </section>
      )}

      {preparedImport ? (
        <ImportRangeDialog
          prepared={preparedImport}
          isImporting={isImporting}
          onConfirm={(range) => void handleConfirmImport(range)}
          onCancel={() => setPreparedImport(null)}
        />
      ) : null}

      {deleteConfirm ? (
        <ConfirmDialog
          title="确认删除"
          description={`确定要删除「${deleteConfirm.title}」吗？删除后产物文件也会被清理，此操作不可撤销。`}
          confirmLabel="删除"
          danger
          isLoading={isDeleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteConfirm(null)}
        />
      ) : null}
    </div>
  );
}
