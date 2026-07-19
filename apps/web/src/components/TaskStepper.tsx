import { AlertCircle, Check, Loader2 } from "lucide-react";
import type { ArticleTask } from "@zhihu-video/contracts";

const STEPS = [
  { id: "fetching", label: "内容抓取" },
  { id: "summarizing", label: "AI 标题" },
  { id: "rendering_images", label: "图片生成" },
  { id: "rendering_video", label: "视频合成" },
] as const;

/**
 * Index of the step the task is currently on. Terminal states keep pointing
 * at the step they stopped at so the operator sees where it broke; completed
 * tasks point past the last step so every step renders as done.
 */
export function stepIndexForTask(task: ArticleTask): number {
  switch (task.status) {
    case "fetching":
      return 0;
    case "summarizing":
      return 1;
    case "rendering_images":
      return 2;
    case "rendering_video":
      return 3;
    case "completed":
      return STEPS.length;
    default:
      // pending / failed / needs_review: infer from the reported progress.
      if (task.progress >= 80) return 3;
      if (task.progress >= 50) return 2;
      if (task.progress >= 30) return 1;
      return 0;
  }
}

type StepState = "done" | "active" | "interrupted" | "todo";

export function TaskStepper({ task }: { task: ArticleTask }) {
  const activeIndex = stepIndexForTask(task);
  const interrupted =
    task.status === "failed" || task.status === "needs_review";

  return (
    <ol className="task-stepper" aria-label="任务处理进度">
      {STEPS.map((step, index) => {
        let state: StepState;
        if (index < activeIndex) state = "done";
        else if (index > activeIndex) state = "todo";
        else if (interrupted) state = "interrupted";
        else if (task.status === "pending") state = "todo";
        else state = "active";

        return (
          <li key={step.id} className={`stepper-step step-${state}`}>
            <span className="stepper-icon" aria-hidden="true">
              {state === "done" ? (
                <Check size={13} />
              ) : state === "active" ? (
                <Loader2 size={13} className="stepper-spin" />
              ) : state === "interrupted" ? (
                <AlertCircle size={13} />
              ) : (
                index + 1
              )}
            </span>
            <span className="stepper-label">{step.label}</span>
            {index < STEPS.length - 1 ? (
              <span className="stepper-connector" aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
