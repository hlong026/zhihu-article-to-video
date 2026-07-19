import { Download, Eye, FileSpreadsheet, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { BatchSummary } from "@zhihu-video/contracts";

import { apiClient } from "../api/client";

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function TaskHistoryPage() {
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getBatches()
      .then(setBatches)
      .catch((error: unknown) =>
        setNotice(
          error instanceof Error ? error.message : "读取批次记录失败。",
        ),
      );
  }, []);

  async function handleDownload(batchId: string, asset: "batch" | "workbook") {
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

  if (!batches) return <div className="page-loading">正在读取批次记录…</div>;

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

      {batches.length === 0 ? (
        <section className="empty-workbench" aria-label="空记录">
          <FileSpreadsheet size={32} />
          <h2>还没有导入记录</h2>
          <p>回到工作台导入第一份知乎链接 Excel，这里会按批次列出处理结果。</p>
        </section>
      ) : (
        <div className="history-list">
          {batches.map((batch) => (
            <section
              className="history-card"
              aria-label={`批次 ${batch.sourceFileName}`}
              key={batch.id}
            >
              <div className="history-file">
                <FileSpreadsheet size={22} />
                <div>
                  <strong>{batch.sourceFileName}</strong>
                  <span>导入于 {formatCreatedAt(batch.createdAt)}</span>
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
                  <dt>失败/需确认</dt>
                  <dd>
                    {batch.failedCount}/{batch.needsReviewCount}
                  </dd>
                </div>
              </dl>
              <div className="history-actions">
                <Link
                  className="button button-secondary"
                  to={`/history/${batch.id}`}
                >
                  <Eye size={16} />
                  查看详情
                </Link>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void handleDownload(batch.id, "workbook")}
                >
                  <Download size={16} />
                  下载结果表
                </button>
                <button
                  type="button"
                  className="button button-dark"
                  onClick={() => void handleDownload(batch.id, "batch")}
                >
                  <Download size={16} />
                  下载成品
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
