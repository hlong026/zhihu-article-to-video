import { FileSpreadsheet, Import, Play, Sparkles, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ArticleTask } from "@zhihu-video/contracts";

import { apiClient, type WorkbenchData } from "../api/client";
import { BgmSettingsCard } from "../components/BgmSettingsCard";
import { TaskTable } from "../components/TaskTable";
import { WorkbenchPreview } from "../components/WorkbenchPreview";

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

export function WorkbenchPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [workbench, setWorkbench] = useState<WorkbenchData | null>(null);
  const [selectedTask, setSelectedTask] = useState<ArticleTask | null>(null);
  const [tailNote, setTailNote] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isSavingTailNote, setIsSavingTailNote] = useState(false);
  const [isSavingManualContent, setIsSavingManualContent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void apiClient
      .getWorkbench()
      .then((data) => {
        setWorkbench(data);
        const task = getInitialSelectedTask(data?.tasks ?? []);
        setSelectedTask(task);
        setTailNote(task?.tailNote ?? "");
      })
      .catch((error: unknown) =>
        setNotice(error instanceof Error ? error.message : "读取任务失败。"),
      )
      .finally(() => setIsLoading(false));
  }, []);

  function selectTask(task: ArticleTask) {
    setSelectedTask(task);
    setTailNote(task.tailNote);
  }

  async function handleImport(file?: File) {
    if (!window.desktop && !file) return;

    setIsImporting(true);
    try {
      const result = await apiClient.importExcel(file);
      if (!result) return;
      await apiClient.startBatch(result.batchId);
      const nextWorkbench = await apiClient.getWorkbench();
      if (!nextWorkbench) {
        throw new Error("Excel 已上传，但尚未创建任务批次。");
      }
      const nextTask = getInitialSelectedTask(nextWorkbench.tasks);
      setWorkbench(nextWorkbench);
      setSelectedTask(nextTask);
      setTailNote(nextTask?.tailNote ?? "");
      setNotice(`已导入 ${result.createdCount} 条文章任务，正在创建批次。`);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "导入失败，请检查 Excel 格式。",
      );
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function openImportDialog(): void {
    if (window.desktop) {
      void handleImport();
      return;
    }
    fileInputRef.current?.click();
  }

  async function handleSaveTailNote() {
    if (!selectedTask) return;

    setIsSavingTailNote(true);
    try {
      const updatedTask = await apiClient.updateTailNote(
        selectedTask.id,
        tailNote.trim(),
      );
      setSelectedTask(updatedTask);
      setWorkbench((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === updatedTask.id ? updatedTask : task,
              ),
            }
          : current,
      );
      setNotice("尾注已保存，当前任务将重新渲染最后一页。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "尾注保存失败。");
    } finally {
      setIsSavingTailNote(false);
    }
  }

  async function handleRetry(task: ArticleTask) {
    try {
      const updatedTask = await apiClient.retryTask(task.id);
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
      selectTask(updatedTask);
      setNotice("任务已加入处理队列。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "任务重试失败。");
    }
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
      setNotice("正文已保存，任务已跳过读取步骤重新处理。");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "正文保存失败，请重试。",
      );
    } finally {
      setIsSavingManualContent(false);
    }
  }

  async function handleDownload(task: ArticleTask, asset: "video" | "images") {
    // The desktop shell blocks window.open, so downloads go through the
    // preload bridge and a native save dialog instead.
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

  if (isLoading) {
    return <div className="page-loading">正在加载当前批次…</div>;
  }

  const pendingCount =
    workbench?.tasks.filter(
      (task) =>
        task.status === "pending" ||
        task.status === "fetching" ||
        task.status === "summarizing" ||
        task.status === "rendering_images" ||
        task.status === "rendering_video",
    ).length ?? 0;

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
            onChange={(event) => void handleImport(event.target.files?.[0])}
          />
          <button
            type="button"
            className="button button-dark import-button"
            onClick={openImportDialog}
            disabled={isImporting}
          >
            <Import size={17} />
            {isImporting ? "正在导入…" : "导入 Excel"}
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

      <BgmSettingsCard onNotice={setNotice} />

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
                <span>{workbench.batch.totalCount} 篇文章 · 已开始处理</span>
              </div>
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
            />
            <WorkbenchPreview
              task={selectedTask}
              tailNote={tailNote}
              isSaving={isSavingTailNote}
              isSavingManualContent={isSavingManualContent}
              onTailNoteChange={setTailNote}
              onSaveTailNote={() => void handleSaveTailNote()}
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
    </div>
  );
}
