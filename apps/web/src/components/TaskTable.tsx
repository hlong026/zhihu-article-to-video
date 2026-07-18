import { ChevronRight, Download, Eye, RotateCw } from "lucide-react";
import type { ArticleTask } from "@zhihu-video/contracts";

import { StatusBadge, statusLabel } from "./StatusBadge";

interface TaskTableProps {
  tasks: ArticleTask[];
  selectedTaskId: string | null;
  onSelect: (task: ArticleTask) => void;
  onRetry: (task: ArticleTask) => void;
  onDownload: (task: ArticleTask, asset: "video" | "images") => void;
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function TaskActions({
  task,
  onSelect,
  onRetry,
  onDownload,
}: Omit<TaskTableProps, "tasks" | "selectedTaskId"> & { task: ArticleTask }) {
  if (task.status === "completed") {
    return (
      <div className="table-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => onSelect(task)}
        >
          <Eye size={15} />
          预览
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => onDownload(task, "video")}
        >
          <Download size={15} />
          下载
        </button>
      </div>
    );
  }

  if (task.status === "failed" || task.status === "needs_review") {
    return (
      <div className="table-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => onSelect(task)}
        >
          查看原因
        </button>
        <button
          type="button"
          className="text-button action-emphasis"
          onClick={() => onRetry(task)}
        >
          <RotateCw size={15} />
          重试
        </button>
      </div>
    );
  }

  if (task.status === "pending") {
    return (
      <button
        type="button"
        className="text-button action-emphasis"
        onClick={() => onRetry(task)}
      >
        <RotateCw size={15} />
        开始处理
      </button>
    );
  }

  return (
    <button
      type="button"
      className="text-button"
      onClick={() => onSelect(task)}
    >
      查看详情 <ChevronRight size={15} />
    </button>
  );
}

export function TaskTable({
  tasks,
  selectedTaskId,
  onSelect,
  onRetry,
  onDownload,
}: TaskTableProps) {
  return (
    <section className="task-section" aria-labelledby="task-table-title">
      <div className="section-header">
        <div>
          <p className="eyebrow">当前批次</p>
          <h2 id="task-table-title">文章任务</h2>
        </div>
        <p className="section-support">点击任意任务可在右侧查看成片与尾注</p>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th aria-label="选择">
                <input aria-label="选择全部任务" type="checkbox" />
              </th>
              <th>文章标题</th>
              <th>来源</th>
              <th>状态</th>
              <th>进度</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const title =
                task.fetchedTitle ?? task.inputTitle ?? "未命名文章";
              return (
                <tr
                  key={task.id}
                  className={task.id === selectedTaskId ? "is-selected" : ""}
                  onClick={() => onSelect(task)}
                >
                  <td onClick={(event) => event.stopPropagation()}>
                    <input aria-label={`选择 ${title}`} type="checkbox" />
                  </td>
                  <td>
                    <div className="article-title-cell">
                      <strong>{title}</strong>
                      {task.failureMessage ? (
                        <span className="failure-copy">
                          {task.failureMessage}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <span className="source-label">
                      {task.sourceType === "answer" ? "知乎回答" : "知乎专栏"}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={task.status} />
                  </td>
                  <td>
                    <div className="progress-cell">
                      <span>{task.progress}%</span>
                      <div
                        className="progress-track"
                        aria-label={`${statusLabel(task.status)} ${task.progress}%`}
                      >
                        <i style={{ width: `${task.progress}%` }} />
                      </div>
                    </div>
                  </td>
                  <td>
                    <time dateTime={task.updatedAt}>
                      {formatUpdatedAt(task.updatedAt)}
                    </time>
                  </td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <TaskActions
                      task={task}
                      onSelect={onSelect}
                      onRetry={onRetry}
                      onDownload={onDownload}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
