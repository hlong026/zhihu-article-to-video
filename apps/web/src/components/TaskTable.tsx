import {
  ChevronRight,
  Download,
  Eye,
  RotateCw,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ArticleTask, TaskStatus } from "@zhihu-video/contracts";

import { isActiveTaskStatus, isTerminalTaskStatus } from "../api/client";
import { StatusBadge, statusLabel } from "./StatusBadge";

type StatusFilter = "all" | "active" | "completed" | "failed" | "needs_review";

const filterOptions: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "处理中" },
  { id: "completed", label: "已完成" },
  { id: "failed", label: "失败" },
  { id: "needs_review", label: "需确认" },
];

interface TaskTableProps {
  tasks: ArticleTask[];
  selectedTaskId: string | null;
  onSelect: (task: ArticleTask) => void;
  onRetry: (task: ArticleTask) => void;
  onDownload: (task: ArticleTask, asset: "video" | "images") => void;
  onDelete?: (task: ArticleTask) => void;
  onBatchDelete?: (taskIds: string[]) => void;
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function matchesFilter(status: TaskStatus, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return isActiveTaskStatus(status) || status === "pending";
    case "completed":
      return status === "completed";
    case "failed":
      return status === "failed";
    case "needs_review":
      return status === "needs_review";
  }
}

function TaskActions({
  task,
  onSelect,
  onRetry,
  onDownload,
  onDelete,
}: {
  task: ArticleTask;
  onSelect: (task: ArticleTask) => void;
  onRetry: (task: ArticleTask) => void;
  onDownload: (task: ArticleTask, asset: "video" | "images") => void;
  onDelete?: (task: ArticleTask) => void;
}) {
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
        {onDelete ? (
          <button
            type="button"
            className="text-button text-button-danger"
            onClick={() => onDelete(task)}
            aria-label={`删除 ${task.fetchedTitle ?? task.inputTitle ?? "任务"}`}
          >
            <Trash2 size={15} />
          </button>
        ) : null}
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
        {onDelete ? (
          <button
            type="button"
            className="text-button text-button-danger"
            onClick={() => onDelete(task)}
            aria-label={`删除 ${task.fetchedTitle ?? task.inputTitle ?? "任务"}`}
          >
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
    );
  }

  if (task.status === "pending") {
    return (
      <div className="table-actions">
        <button
          type="button"
          className="text-button action-emphasis"
          onClick={() => onRetry(task)}
        >
          <RotateCw size={15} />
          开始处理
        </button>
        {onDelete ? (
          <button
            type="button"
            className="text-button text-button-danger"
            onClick={() => onDelete(task)}
            aria-label={`删除 ${task.fetchedTitle ?? task.inputTitle ?? "任务"}`}
          >
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
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
  onDelete,
  onBatchDelete,
}: TaskTableProps) {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const filteredTasks = useMemo(() => {
    let result = tasks;
    if (statusFilter !== "all") {
      result = result.filter((task) => matchesFilter(task.status, statusFilter));
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter((task) => {
        const title = (
          task.fetchedTitle ??
          task.inputTitle ??
          ""
        ).toLowerCase();
        return title.includes(query);
      });
    }
    return result;
  }, [tasks, statusFilter, searchQuery]);

  // Only terminal tasks are checkable (active ones cannot be deleted)
  const checkableTasks = filteredTasks.filter((task) =>
    isTerminalTaskStatus(task.status) || task.status === "pending",
  );
  const allChecked =
    checkableTasks.length > 0 &&
    checkableTasks.every((task) => checkedIds.has(task.id));
  const someChecked = checkedIds.size > 0;

  function toggleCheck(taskId: string) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function toggleAll() {
    if (allChecked) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(checkableTasks.map((task) => task.id)));
    }
  }

  function handleBatchDelete() {
    if (onBatchDelete && checkedIds.size > 0) {
      onBatchDelete([...checkedIds]);
      setCheckedIds(new Set());
    }
  }

  return (
    <section className="task-section" aria-labelledby="task-table-title">
      <div className="section-header">
        <div>
          <p className="eyebrow">当前批次</p>
          <h2 id="task-table-title">文章任务</h2>
        </div>
        <p className="section-support">
          {filteredTasks.length === tasks.length
            ? `共 ${tasks.length} 条`
            : `${filteredTasks.length}/${tasks.length} 条`}
        </p>
      </div>

      {/* Search & Filter bar */}
      <div className="task-filter-bar">
        <div className="task-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="搜索文章标题…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            aria-label="搜索文章标题"
          />
        </div>
        <div className="task-status-filters" role="group" aria-label="状态筛选">
          {filterOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`filter-chip${statusFilter === option.id ? " is-active" : ""}`}
              onClick={() => setStatusFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Batch action bar */}
      {someChecked ? (
        <div className="batch-action-bar" role="toolbar" aria-label="批量操作">
          <span>已选 {checkedIds.size} 项</span>
          {onBatchDelete ? (
            <button
              type="button"
              className="button button-danger button-sm"
              onClick={handleBatchDelete}
            >
              <Trash2 size={14} />
              删除选中
            </button>
          ) : null}
          <button
            type="button"
            className="button button-secondary button-sm"
            onClick={() => setCheckedIds(new Set())}
          >
            取消选择
          </button>
        </div>
      ) : null}

      <div className="table-wrap">
        {filteredTasks.length === 0 ? (
          <div className="table-empty" role="note">
            没有匹配的任务
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th aria-label="选择">
                  <input
                    aria-label="选择全部任务"
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                  />
                </th>
                <th>文章标题</th>
                <th className="col-source">来源</th>
                <th>状态</th>
                <th>进度</th>
                <th className="col-time">更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.map((task) => {
                const title =
                  task.fetchedTitle ?? task.inputTitle ?? "未命名文章";
                const isCheckable =
                  isTerminalTaskStatus(task.status) || task.status === "pending";
                return (
                  <tr
                    key={task.id}
                    className={task.id === selectedTaskId ? "is-selected" : ""}
                    onClick={() => onSelect(task)}
                  >
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        aria-label={`选择 ${title}`}
                        type="checkbox"
                        checked={checkedIds.has(task.id)}
                        disabled={!isCheckable}
                        onChange={() => toggleCheck(task.id)}
                      />
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
                    <td className="col-source">
                      <span className="source-label">
                        {task.sourceType === "answer" ? "知乎回答" : "知乎专栏"}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={task.status} />
                    </td>
                    <td>
                      <div className="progress-cell">
                        <span>
                          {isActiveTaskStatus(task.status)
                            ? `${statusLabel(task.status)} ${task.progress}%`
                            : `${task.progress}%`}
                        </span>
                        <div
                          className={`progress-track${
                            isActiveTaskStatus(task.status) ? " is-active" : ""
                          }`}
                          aria-label={`${statusLabel(task.status)} ${task.progress}%`}
                        >
                          <i style={{ width: `${task.progress}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="col-time">
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
                        onDelete={onDelete}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
