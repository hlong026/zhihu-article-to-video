import { Download, FileSpreadsheet, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { apiClient, type WorkbenchData } from "../api/client";

export function TaskHistoryPage() {
  const [data, setData] = useState<WorkbenchData | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void apiClient.getWorkbench().then(setData);
  }, []);

  async function handleDownload(asset: "batch" | "workbook") {
    if (!data) return;
    const batchId = data.batch.id;
    // The desktop shell blocks window.open, so downloads go through the
    // preload bridge and a native save dialog instead.
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

  if (!data) return <div className="page-loading">正在读取批次记录…</div>;

  const { batch } = data;
  const createdAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(batch.createdAt));

  return (
    <div className="history-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">导入历史</p>
          <h1>任务记录</h1>
          <p className="header-description">
            按批次查看成品、失败任务和结果表。
          </p>
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

      <section className="history-card" aria-label="批次记录">
        <div className="history-file">
          <FileSpreadsheet size={22} />
          <div>
            <strong>{batch.sourceFileName}</strong>
            <span>导入于 {createdAt}</span>
          </div>
        </div>
        <dl className="history-stats">
          <div>
            <dt>总任务</dt>
            <dd>{batch.totalCount}</dd>
          </div>
          <div>
            <dt>已完成</dt>
            <dd>{batch.completedCount}</dd>
          </div>
          <div>
            <dt>失败</dt>
            <dd>{batch.failedCount}</dd>
          </div>
        </dl>
        <div className="history-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void handleDownload("workbook")}
          >
            <Download size={16} />
            下载结果表
          </button>
          <button
            type="button"
            className="button button-dark"
            onClick={() => void handleDownload("batch")}
          >
            <Download size={16} />
            下载已完成任务
          </button>
        </div>
      </section>
    </div>
  );
}
