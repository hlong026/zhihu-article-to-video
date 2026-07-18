import type { TaskStatus } from "@zhihu-video/contracts";

const statusCopy: Record<TaskStatus, string> = {
  pending: "待处理",
  fetching: "读取内容",
  summarizing: "生成摘要",
  rendering_images: "生成图片",
  rendering_video: "合成视频",
  completed: "已生成",
  failed: "失败",
  needs_review: "需人工确认",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {statusCopy[status]}
    </span>
  );
}

export function statusLabel(status: TaskStatus): string {
  return statusCopy[status];
}
