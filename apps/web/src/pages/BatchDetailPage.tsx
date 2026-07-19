import { ArrowLeft, Download, FileSpreadsheet, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  ArticleTask,
  ArticleTaskDetail,
  BatchDetailView,
} from "@zhihu-video/contracts";

import { apiClient, isTerminalTaskStatus } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import { AttemptTimeline, TaskPreviewMedia } from "../components/TaskPreviewMedia";
import { TaskTable } from "../components/TaskTable";

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

export function BatchDetailPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const [detail, setDetail] = useState<BatchDetailView | null>(null);
  const [selectedTask, setSelectedTask] = useState<ArticleTask | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<ArticleTaskDetail | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // Keep watching while the batch still has work in flight.
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
      setNotice("任务已加入处理队列。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "任务重试失败。");
    }
  }

  async function handleDownload(task: ArticleTask, asset: "video" | "images") {
    if (window.desktop) {
      try {
        const savedPath =
          asset === "video"
            ? await window.desktop.downloadVideo(task.id)
            : await window.desktop.downloadImages(task.id);
        setNotice(savedPath ? `已保存到：${savedPath}` : "已取消保存。");
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : "下载失败，请稍后再试。",
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

  async function handleBatchDownload(asset: "batch" | "workbook") {
    if (!batchId) return;
    if (window.desktop) {
      try {
        const savedPath =
          asset === "batch"
            ? await window.desktop.downloadBatch(batchId)
            : await window.desktop.downloadResultWorkbook(batchId);
        setNotice(savedPath ? `已保存到：${savedPath}` : "已取消保存。");
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : "下载失败，请稍后再试。",
        );
      }
      return;
    }
    const url =
      asset === "batch"
        ? apiClient.getBatchDownloadUrl(batchId)
        : apiClient.getResultWorkbookUrl(batchId);
    window.open(url, "_blank", "noopener,noreferrer");
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
            className="button button-dark"
            onClick={() => void handleBatchDownload("batch")}
          >
            <Download size={16} />
            下载成品
          </button>
        </div>
      </header>

      {notice ? (
        <div className="notice" role="status">
          <Sparkles size={16} />
          {notice}
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      ) : null}

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
        <section className="task-section import-errors" aria-labelledby="import-errors-title">
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
    </div>
  );
}
