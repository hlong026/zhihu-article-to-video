import type { TaskStatus } from "@zhihu-video/contracts";

export const pipelineSteps = [
  "fetching",
  "summarizing",
  "rendering_images",
  "rendering_video",
  "aborted",
] as const;

export type PipelineStep = (typeof pipelineSteps)[number];
export type RetryableStatus = Extract<TaskStatus, "failed" | "needs_review">;

const nextStatuses: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["fetching", "needs_review", "aborted"],
  fetching: ["summarizing", "failed", "needs_review", "aborted"],
  summarizing: ["rendering_images", "failed", "needs_review", "aborted"],
  rendering_images: ["rendering_video", "failed", "aborted"],
  rendering_video: ["completed", "failed", "aborted"],
  completed: [],
  failed: [],
  needs_review: [],
  aborted: [],
};

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return nextStatuses[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new TaskStateError(`不允许任务从 ${from} 迁移到 ${to}`);
  }
}

export function getRetryStep(task: {
  status: TaskStatus;
  currentStep: TaskStatus | PipelineStep | null;
}): PipelineStep {
  if (task.status !== "failed" && task.status !== "needs_review") {
    throw new TaskStateError("只有失败或需人工确认的任务可以重试");
  }

  return pipelineSteps.includes(task.currentStep as PipelineStep)
    ? (task.currentStep as PipelineStep)
    : "fetching";
}

export function progressForStep(step: PipelineStep | "completed"): number {
  if (step === "completed") return 100;
  if (step === "aborted") return 0;
  return (pipelineSteps.indexOf(step) * 100) / pipelineSteps.length;
}
