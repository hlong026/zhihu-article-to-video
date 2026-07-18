import ExcelJS from "exceljs";
import type { TaskStatus } from "@zhihu-video/contracts";

import type { BatchTaskExport } from "./repository.js";

export const taskStatusLabels: Record<TaskStatus, string> = {
  pending: "待处理",
  fetching: "读取中",
  summarizing: "摘要中",
  rendering_images: "生成图片中",
  rendering_video: "合成视频中",
  completed: "已完成",
  failed: "失败",
  needs_review: "需人工确认",
};

/**
 * Directory name of a task inside the batch ZIP. The running index keeps
 * entries ordered like the source workbook and avoids name collisions when
 * two tasks share a title.
 */
export function taskExportBaseName(
  task: Pick<BatchTaskExport, "id" | "finalTitle" | "inputTitle">,
  index: number,
): string {
  const title = (task.finalTitle ?? task.inputTitle ?? task.id)
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .trim();
  return `${String(index + 1).padStart(2, "0")}-${title.slice(0, 50)}`;
}

/** Strips the workbook extension so export file names stay readable. */
export function batchExportBaseName(sourceFileName: string): string {
  const withoutExtension = sourceFileName.replace(/\.[^.]+$/, "").trim();
  const sanitized = withoutExtension.replace(/[\\/:*?"<>|\r\n]+/g, "-").trim();
  return sanitized.length > 0 ? sanitized.slice(0, 50) : "批次";
}

/**
 * Builds the per-batch result workbook. Paths point at entries inside the
 * batch ZIP so the spreadsheet stays consistent with the downloaded files.
 */
export async function buildResultWorkbook(
  tasks: BatchTaskExport[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("结果");
  sheet.columns = [
    { header: "知乎标题", key: "inputTitle", width: 30 },
    { header: "链接", key: "sourceUrl", width: 46 },
    { header: "文章口令", key: "articleKeyword", width: 18 },
    { header: "最终标题", key: "finalTitle", width: 30 },
    { header: "标签", key: "tags", width: 24 },
    { header: "状态", key: "status", width: 12 },
    { header: "失败原因", key: "failureMessage", width: 36 },
    { header: "视频文件", key: "videoPath", width: 40 },
    { header: "图片目录", key: "imagesPath", width: 40 },
  ];
  tasks.forEach((task, index) => {
    const completed = task.status === "completed" && task.outputDirectory;
    const baseName = completed ? taskExportBaseName(task, index) : "";
    sheet.addRow({
      inputTitle: task.inputTitle ?? "",
      sourceUrl: task.sourceUrl,
      articleKeyword: task.articleKeyword ?? "",
      finalTitle: task.finalTitle ?? "",
      tags: task.finalTags.join("、"),
      status: taskStatusLabels[task.status],
      failureMessage: task.failureMessage ?? "",
      videoPath: completed ? `${baseName}/video.mp4` : "",
      imagesPath: completed ? `${baseName}/images/` : "",
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
