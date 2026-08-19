import {
  ArrowLeft,
  Download,
  FileSpreadsheet,
  Images,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ArticleTask,
  ArticleTaskDetail,
  BatchDetailView,
} from "@zhihu-video/contracts";

import { apiClient, isTerminalTaskStatus } from "../api/client";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge } from "../components/StatusBadge";
import {
  AttemptTimeline,
  TaskPreviewMedia,
} from "../components/TaskPreviewMedia";
import { TaskTable } from "../components/TaskTable";
import { useToast } from "../components/Toast";

const POLL_INTERVAL_MS = 2_000;

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric-card metric-neutral">
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

export function BatchDetailPage() {
  const { toast } = useToast();
  const { batchId } = useParams<{ batchId: string }>();
  const [detail, setDetail] = useState<BatchDetailView | null>(null);
  const [selectedTask, setSelectedTask] = useState<ArticleTask | null>(null);
  const [selectedDetail, setSelectedDetail] =
    useState<ArticleTaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const refresh = useCallback(async () => {
    if (!batchId) return;
    const next = await apiClient.getBatch(batchId);
    setDetail(next);
    setSelectedTask(
      (current) =>
        (current && next.tasks.find((task) => task.id === current.id)) ??
        next.tasks.find((task) => task.status === "completed") ??
        next.tasks[0] ??
        null,
    );
  }, [batchId]);

  useEffect(() => {
    refresh().catch((error: unknown) =>
      setLoadError(
        error instanceof Error ? error.message : "读取批次详情失败。",
      ),
    );
  }, [refresh]);

  const hasActiveTasks =
    detail?.tasks.some((task) => !isTerminalTaskStatus(task.status)) ?? false;
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
      .then((task) => {
        if (!cancelled) setSelectedDetail(task);
      })
      .catch(() => {
        if (!cancelled) setSelectedDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, selectedTaskUpdatedAt]);

  async function handleRetry(task: ArticleTask) {
    try {
      await apiClient.retryTask(task.id);
      await refresh();
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

  async function handleBatchDownload(
    asset: "batch" | "workbook" | "videos" | "images",
  ) {
    if (!batchId) return;
    if (window.desktop) {
      try {
        const savedPath =
          asset === "batch"
            ? await window.desktop.downloadBatch(batchId)
            : asset === "videos"
              ? await window.desktop.downloadBatchVideos(batchId)
              : asset === "images"
                ? await window.desktop.downloadBatchImages(batchId)
                : await window.desktop.downloadResultWorkbook(batchId);
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
    const url =
      asset === "batch"
        ? apiClient.getBatchDownloadUrl(batchId)
        : asset === "videos"
          ? apiClient.getBatchVideosDownloadUrl(batchId)
          : asset === "images"
            ? apiClient.getBatchImagesDownloadUrl(batchId)
            : apiClient.getResultWorkbookUrl(batchId);
    window.open(url, "_blank", "noopener,noreferrer");
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
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除失败。", "error");
    } finally {
      setIsDeleting(false);
      setDeleteConfirm(null);
    }
  }

  if (loadError) {
    return (
      <div className="page-loading" role="alert">
        {loadError}
      </div>
    );
  }
  if (!detail) return <div className="page-loading">正在读取批次详情…</div>;

  const processingCount = detail.tasks.filter(
    (task) => !isTerminalTaskStatus(task.status),
  ).length;

  return (
    <div className="history-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">
            <Link className="back-link" to="/history">
              <ArrowLeft size={13} />
              返回任务记录
            </Link>
          </p>
          <h1>批次详情</h1>
          <p className="header-description">
            {detail.sourceFileName} · 导入于 {formatCreatedAt(detail.createdAt)}
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void handleBatchDownload("workbook")}
          >
            <Download size={16} />
            下载结果表
          </button>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void handleBatchDownload("videos")}
          >
            <Video size={16} />
            下载全部视频
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void handleBatchDownload("images")}
          >
            <Images size={16} />
            下载全部图片
          </button>
          <button
            type="button"
            className="button button-dark"
            onClick={() => void handleBatchDownload("batch")}
          >
            <Download size={16} />
            下载成品
          </button>
        </div>
      </header>

      <section className="batch-summary" aria-label="批次统计">
        <div className="batch-file">
          <span className="file-icon">
            <FileSpreadsheet size={22} />
          </span>
          <div>
            <p className="eyebrow">批次状态</p>
            <strong>{detail.sourceFileName}</strong>
            <span>{detail.totalCount} 篇文章</span>
          </div>
        </div>
        <div className="metrics-row batch-detail-metrics">
          <StatCard label="处理中" value={processingCount} />
          <StatCard label="已生成" value={detail.completedCount} />
          <StatCard label="失败" value={detail.failedCount} />
          <StatCard label="需确认" value={detail.needsReviewCount} />
        </div>
      </section>

      {detail.importErrors.length > 0 ? (
        <section
          className="task-section import-errors"
          aria-labelledby="import-errors-title"
        >
          <div className="section-header">
            <div>
              <p className="eyebrow">导入检查</p>
              <h2 id="import-errors-title">导入时跳过的行</h2>
            </div>
            <p className="section-support">
              共 {detail.importErrors.length} 行未导入
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>行号</th>
                  <th>错误类型</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {detail.importErrors.map((error) => (
                  <tr key={error.rowNumber}>
                    <td>第 {error.rowNumber} 行</td>
                    <td>
                      <code>{error.code}</code>
                    </td>
                    <td>{error.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="workbench-grid">
        <TaskTable
          tasks={detail.tasks}
          selectedTaskId={selectedTask?.id ?? null}
          onSelect={setSelectedTask}
          onRetry={(task) => void handleRetry(task)}
          onDownload={(task, asset) => void handleDownload(task, asset)}
          onDelete={requestDeleteTask}
          onBatchDelete={requestBatchDelete}
        />
        {selectedTask ? (
          <aside className="preview-panel" aria-label="任务详情">
            <div className="preview-heading">
              <div>
                <p className="eyebrow">任务详情</p>
                <h2>
                  {selectedTask.finalTitle ??
                    selectedTask.fetchedTitle ??
                    selectedTask.inputTitle ??
                    "未命名文章"}
                </h2>
              </div>
              <StatusBadge status={selectedTask.status} />
            </div>
            <TaskPreviewMedia task={selectedTask} detail={selectedDetail} />
            <dl className="detail-facts">
              <div>
                <dt>文章口令</dt>
                <dd>{selectedTask.articleKeyword ?? "未填写"}</dd>
              </div>
              <div>
                <dt>尾注</dt>
                <dd>{selectedTask.tailNote}</dd>
              </div>
            </dl>
            {selectedTask.status === "completed" ? (
              <div className="preview-downloads">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void handleDownload(selectedTask, "video")}
                >
                  <Download size={16} />
                  下载视频
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void handleDownload(selectedTask, "images")}
                >
                  <Download size={16} />
                  下载图片
                </button>
              </div>
            ) : null}
            <AttemptTimeline detail={selectedDetail} />
          </aside>
        ) : null}
      </div>

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
