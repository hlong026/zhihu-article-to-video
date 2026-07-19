import { randomUUID } from "node:crypto";

import type {
  AiSettings,
  ArticleTask,
  BatchSummary,
  BgmSettings,
  ManualArticleContent,
  ProcessingSettings,
  SourceType,
  TaskStatus,
} from "@zhihu-video/contracts";
import { processingConcurrencyOptions } from "@zhihu-video/contracts";

import type { SqliteDatabase } from "./database.js";
import type { ImportRowError, ImportTaskInput } from "./importer.js";
import {
  assertTaskTransition,
  getRetryStep,
  progressForStep,
  type PipelineStep,
} from "./task-state.js";

const DEFAULT_TAIL_NOTE = "来知乎搜索🔍{文章口令}可以看到全文";

const BGM_SETTINGS_KEY = "bgm";
const PROCESSING_SETTINGS_KEY = "processing";
const AI_SETTINGS_KEY = "ai";

export const DEFAULT_BGM_SETTINGS: BgmSettings = {
  enabled: false,
  source: null,
  presetId: null,
  fileName: null,
  volume: 0.3,
  fadeOutSeconds: 1,
};

export const DEFAULT_PROCESSING_SETTINGS: ProcessingSettings = {
  concurrency: 5,
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  apiKey: null,
  baseUrl: null,
  model: null,
};

/**
 * The single source of truth for the locked tail-note copy: the keyword is
 * always the Excel-supplied one, interpolated into the fixed template.
 */
export function renderTailNote(articleKeyword: string | null): string {
  return renderedTailNote(DEFAULT_TAIL_NOTE, articleKeyword);
}

type BatchRow = {
  id: string;
  source_file_name: string;
  total_count: number;
  status: string;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  batch_id: string;
  source_url: string;
  source_type: SourceType;
  input_title: string | null;
  fetched_title: string | null;
  article_keyword: string | null;
  manual_content_json: string | null;
  raw_content_path: string | null;
  final_title: string | null;
  final_tags_json: string;
  tail_note_template: string;
  tail_note: string;
  status: TaskStatus;
  current_step: TaskStatus | PipelineStep | null;
  progress: number;
  failure_code: string | null;
  failure_message: string | null;
  updated_at: string;
};

export interface TaskAttempt {
  id: string;
  attemptNumber: number;
  step: string;
  status: string;
  message: string | null;
  createdAt: string;
}

export interface TaskDetail extends ArticleTask {
  attempts: TaskAttempt[];
}

export interface BatchDetail extends BatchSummary {
  status: string;
  tasks: ArticleTask[];
  importErrors: ImportRowError[];
}

export interface TaskEditInput {
  articleKeyword?: string;
  finalTitle?: string;
  finalTags?: string[];
  tailNote?: string;
}

export interface TaskArtifacts {
  finalTitle: string;
  finalTags: string[];
  outputDirectory: string;
}

/** Minimal read model for serving rendered assets over HTTP. */
export interface TaskDownloadInfo {
  id: string;
  status: TaskStatus;
  finalTitle: string | null;
  outputDirectory: string | null;
}

/** Per-task row used by batch ZIP and result.xlsx exports. */
export interface BatchTaskExport {
  id: string;
  sourceUrl: string;
  sourceType: SourceType;
  inputTitle: string | null;
  articleKeyword: string | null;
  finalTitle: string | null;
  finalTags: string[];
  status: TaskStatus;
  failureMessage: string | null;
  outputDirectory: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function toTask(row: TaskRow): ArticleTask {
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceUrl: row.source_url,
    sourceType: row.source_type,
    inputTitle: row.input_title,
    fetchedTitle: row.fetched_title,
    articleKeyword: row.article_keyword,
    manualContent: row.manual_content_json
      ? (JSON.parse(row.manual_content_json) as ManualArticleContent)
      : null,
    finalTitle: row.final_title,
    finalTags: JSON.parse(row.final_tags_json) as string[],
    tailNote: row.tail_note,
    tailNoteTemplate: row.tail_note_template,
    status: row.status,
    step: (row.current_step ?? row.status) as TaskStatus,
    progress: row.progress,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    updatedAt: row.updated_at,
  };
}

function toBatch(row: BatchRow, counts: Record<string, number>): BatchSummary {
  return {
    id: row.id,
    sourceFileName: row.source_file_name,
    totalCount: row.total_count,
    completedCount: counts.completed ?? 0,
    needsReviewCount: counts.needs_review ?? 0,
    failedCount: counts.failed ?? 0,
    createdAt: row.created_at,
  };
}

function renderedTailNote(
  template: string,
  articleKeyword: string | null,
): string {
  return template.replaceAll("{文章口令}", articleKeyword ?? "待人工确认口令");
}

export class TaskRepository {
  constructor(private readonly database: SqliteDatabase) {}

  createBatch(
    sourceFileName: string,
    tasks: ImportTaskInput[],
    importErrors: ImportRowError[],
  ): BatchDetail {
    const batchId = randomUUID();
    const timestamp = now();
    const initialStatus = tasks.length === 0 ? "partial_failed" : "pending";
    const insert = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO batches (id, source_file_name, total_count, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          batchId,
          sourceFileName,
          tasks.length,
          initialStatus,
          timestamp,
          timestamp,
        );

      const insertTask = this.database.prepare(
        `INSERT INTO article_tasks (
          id, batch_id, source_url, source_type, source_date, input_title, article_keyword,
          tail_note_template, tail_note, status, current_step, progress, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertError = this.database.prepare(
        "INSERT INTO import_errors (id, batch_id, row_number, code, message) VALUES (?, ?, ?, ?, ?)",
      );
      for (const task of tasks) {
        const status: TaskStatus = task.needsReview
          ? "needs_review"
          : "pending";
        insertTask.run(
          randomUUID(),
          batchId,
          task.sourceUrl,
          task.sourceType,
          task.sourceDate,
          task.inputTitle,
          task.articleKeyword,
          DEFAULT_TAIL_NOTE,
          renderedTailNote(DEFAULT_TAIL_NOTE, task.articleKeyword),
          status,
          task.needsReview ? "pending" : null,
          0,
          timestamp,
          timestamp,
        );
      }
      for (const error of importErrors) {
        insertError.run(
          randomUUID(),
          batchId,
          error.rowNumber,
          error.code,
          error.message,
        );
      }
    });
    insert();
    return this.getBatch(batchId)!;
  }

  listBatches(): BatchDetail[] {
    const rows = this.database
      .prepare("SELECT * FROM batches ORDER BY created_at DESC")
      .all() as BatchRow[];
    return rows.map((row) => this.getBatch(row.id)!).filter(Boolean);
  }

  getBatch(batchId: string): BatchDetail | null {
    const row = this.database
      .prepare("SELECT * FROM batches WHERE id = ?")
      .get(batchId) as BatchRow | undefined;
    if (!row) return null;
    const countRows = this.database
      .prepare(
        "SELECT status, COUNT(*) AS count FROM article_tasks WHERE batch_id = ? GROUP BY status",
      )
      .all(batchId) as Array<{ status: string; count: number }>;
    const counts = Object.fromEntries(
      countRows.map(({ status, count }) => [status, count]),
    );
    const tasks = this.database
      .prepare(
        "SELECT * FROM article_tasks WHERE batch_id = ? ORDER BY created_at ASC",
      )
      .all(batchId) as TaskRow[];
    const errors = this.database
      .prepare(
        "SELECT row_number, code, message FROM import_errors WHERE batch_id = ? ORDER BY row_number",
      )
      .all(batchId) as Array<{
      row_number: number;
      code: ImportRowError["code"];
      message: string;
    }>;
    return {
      ...toBatch(row, counts),
      status: row.status,
      tasks: tasks.map(toTask),
      importErrors: errors.map((error) => ({
        rowNumber: error.row_number,
        code: error.code,
        message: error.message,
      })),
    };
  }

  startBatch(batchId: string): BatchDetail | null {
    const batch = this.getBatch(batchId);
    if (!batch) return null;
    const timestamp = now();
    this.database.transaction(() => {
      const taskRows = this.database
        .prepare(
          "SELECT id FROM article_tasks WHERE batch_id = ? AND status = 'pending'",
        )
        .all(batchId) as Array<{ id: string }>;
      for (const task of taskRows)
        this.queueTask(
          task.id,
          "fetching",
          timestamp,
          "批次启动，等待内容读取",
        );
      this.database
        .prepare("UPDATE batches SET status = ?, updated_at = ? WHERE id = ?")
        .run("processing", timestamp, batchId);
    })();
    return this.getBatch(batchId);
  }

  getTask(taskId: string): TaskDetail | null {
    const row = this.database
      .prepare("SELECT * FROM article_tasks WHERE id = ?")
      .get(taskId) as TaskRow | undefined;
    if (!row) return null;
    const attempts = this.database
      .prepare(
        `SELECT id, attempt_number, step, status, message, created_at
         FROM task_attempts WHERE task_id = ? ORDER BY created_at ASC`,
      )
      .all(taskId) as Array<{
      id: string;
      attempt_number: number;
      step: string;
      status: string;
      message: string | null;
      created_at: string;
    }>;
    return {
      ...toTask(row),
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attempt_number,
        step: attempt.step,
        status: attempt.status,
        message: attempt.message,
        createdAt: attempt.created_at,
      })),
    };
  }

  editTask(taskId: string, input: TaskEditInput): TaskDetail | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const articleKeyword = input.articleKeyword ?? task.articleKeyword;
    const taskRow = this.database
      .prepare("SELECT tail_note_template FROM article_tasks WHERE id = ?")
      .get(taskId) as {
      tail_note_template: string;
    };
    const tailTemplate = input.tailNote ?? taskRow.tail_note_template;
    const updatedAt = now();
    this.database
      .prepare(
        `UPDATE article_tasks
         SET article_keyword = ?, final_title = ?, final_tags_json = ?, tail_note_template = ?, tail_note = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        articleKeyword,
        input.finalTitle ?? task.finalTitle,
        JSON.stringify(input.finalTags ?? task.finalTags),
        tailTemplate,
        renderedTailNote(tailTemplate, articleKeyword),
        updatedAt,
        taskId,
      );
    return this.getTask(taskId);
  }

  retryTask(taskId: string): TaskDetail | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const retryStep = getRetryStep({
      status: task.status,
      currentStep: task.step,
    });
    this.queueTask(task.id, retryStep, now(), `从 ${retryStep} 重试`);
    return this.getTask(taskId);
  }

  /**
   * Persists operator-pasted article content. The content is used on the next
   * retry instead of fetching the source page again.
   */
  saveManualContent(
    taskId: string,
    content: ManualArticleContent,
  ): TaskDetail | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    this.database
      .prepare(
        `UPDATE article_tasks
         SET manual_content_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(content), now(), taskId);
    this.logAttempt(
      taskId,
      task.step,
      "manual_content",
      `人工录入正文（${content.paragraphs.length} 段）`,
      now(),
    );
    return this.getTask(taskId);
  }

  saveRawContentPath(taskId: string, rawContentPath: string): void {
    this.database
      .prepare(
        `UPDATE article_tasks
         SET raw_content_path = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(rawContentPath, now(), taskId);
  }

  getTaskDownloadInfo(taskId: string): TaskDownloadInfo | null {
    const row = this.database
      .prepare(
        "SELECT id, status, final_title, output_dir FROM article_tasks WHERE id = ?",
      )
      .get(taskId) as
      | {
          id: string;
          status: TaskStatus;
          final_title: string | null;
          output_dir: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      finalTitle: row.final_title,
      outputDirectory: row.output_dir,
    };
  }

  listBatchTaskExports(batchId: string): BatchTaskExport[] {
    const rows = this.database
      .prepare(
        `SELECT id, source_url, source_type, input_title, article_keyword,
                final_title, final_tags_json, status, failure_message, output_dir
         FROM article_tasks WHERE batch_id = ? ORDER BY created_at ASC`,
      )
      .all(batchId) as Array<{
      id: string;
      source_url: string;
      source_type: SourceType;
      input_title: string | null;
      article_keyword: string | null;
      final_title: string | null;
      final_tags_json: string;
      status: TaskStatus;
      failure_message: string | null;
      output_dir: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sourceUrl: row.source_url,
      sourceType: row.source_type,
      inputTitle: row.input_title,
      articleKeyword: row.article_keyword,
      finalTitle: row.final_title,
      finalTags: JSON.parse(row.final_tags_json) as string[],
      status: row.status,
      failureMessage: row.failure_message,
      outputDirectory: row.output_dir,
    }));
  }

  saveTaskArtifacts(
    taskId: string,
    artifacts: TaskArtifacts,
  ): TaskDetail | null {
    this.database
      .prepare(
        `UPDATE article_tasks
         SET final_title = ?, final_tags_json = ?, output_dir = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        artifacts.finalTitle,
        JSON.stringify(artifacts.finalTags),
        artifacts.outputDirectory,
        now(),
        taskId,
      );
    return this.getTask(taskId);
  }

  /** Pipeline adapters call this after an external step succeeds or fails. */
  updateTaskExecution(
    taskId: string,
    result:
      | { kind: "advance"; to: PipelineStep | "completed"; message?: string }
      | { kind: "failed"; code: string; message: string }
      | { kind: "needs_review"; code: string; message: string },
  ): TaskDetail | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const timestamp = now();
    if (result.kind === "advance") {
      const next = result.to;
      assertTaskTransition(task.status, next);
      this.database
        .prepare(
          `UPDATE article_tasks
           SET status = ?, current_step = ?, progress = ?, failure_code = NULL, failure_message = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(next, next, progressForStep(next), timestamp, taskId);
      this.logAttempt(
        taskId,
        next,
        "completed",
        result.message ?? "步骤完成",
        timestamp,
      );
    } else {
      assertTaskTransition(task.status, result.kind);
      this.database
        .prepare(
          `UPDATE article_tasks
           SET status = ?, failure_code = ?, failure_message = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(result.kind, result.code, result.message, timestamp, taskId);
      this.logAttempt(
        taskId,
        task.step,
        result.kind,
        result.message,
        timestamp,
      );
    }
    return this.getTask(taskId);
  }

  private queueTask(
    taskId: string,
    step: PipelineStep,
    timestamp: string,
    message: string,
  ): void {
    this.database
      .prepare(
        `UPDATE article_tasks
         SET status = ?, current_step = ?, progress = ?, failure_code = NULL, failure_message = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(step, step, progressForStep(step), timestamp, taskId);
    this.logAttempt(taskId, step, "queued", message, timestamp);
  }

  /**
   * Reads the single global background-music configuration, falling back to
   * the disabled default when nothing has been saved yet.
   */
  getBgmSettings(): BgmSettings {
    const row = this.database
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(BGM_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return { ...DEFAULT_BGM_SETTINGS };
    try {
      return { ...DEFAULT_BGM_SETTINGS, ...(JSON.parse(row.value) as object) };
    } catch {
      return { ...DEFAULT_BGM_SETTINGS };
    }
  }

  saveBgmSettings(settings: BgmSettings): BgmSettings {
    this.database
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(BGM_SETTINGS_KEY, JSON.stringify(settings), now());
    return this.getBgmSettings();
  }

  /**
   * Reads the single global batch-processing configuration. Only the preset
   * concurrency values are accepted; anything else falls back to the default.
   */
  getProcessingSettings(): ProcessingSettings {
    const row = this.database
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(PROCESSING_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return { ...DEFAULT_PROCESSING_SETTINGS };
    try {
      const parsed = JSON.parse(row.value) as Partial<ProcessingSettings>;
      const concurrency = (processingConcurrencyOptions as readonly number[]).includes(
        Number(parsed.concurrency),
      )
        ? Number(parsed.concurrency)
        : DEFAULT_PROCESSING_SETTINGS.concurrency;
      return { concurrency };
    } catch {
      return { ...DEFAULT_PROCESSING_SETTINGS };
    }
  }

  getAiSettings(): AiSettings {
    const row = this.database
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(AI_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return { ...DEFAULT_AI_SETTINGS };
    try {
      const parsed = JSON.parse(row.value) as Partial<AiSettings>;
      return {
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : null,
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : null,
        model: typeof parsed.model === "string" ? parsed.model : null,
      };
    } catch {
      return { ...DEFAULT_AI_SETTINGS };
    }
  }

  saveAiSettings(settings: AiSettings): AiSettings {
    this.database
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(AI_SETTINGS_KEY, JSON.stringify(settings), now());
    return this.getAiSettings();
  }

  saveProcessingSettings(settings: ProcessingSettings): ProcessingSettings {
    if (
      !(processingConcurrencyOptions as readonly number[]).includes(
        settings.concurrency,
      )
    ) {
      throw new Error("并发数仅支持 5 / 10 / 15 / 20。");
    }
    this.database
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(PROCESSING_SETTINGS_KEY, JSON.stringify(settings), now());
    return this.getProcessingSettings();
  }

  /**
   * Reports fine-grained progress within the current step. Unlike
   * updateTaskExecution this never changes the task status, so the pipeline
   * can stream sub-step updates (per-card image rendering, encoding start).
   */
  reportTaskProgress(
    taskId: string,
    progress: number,
    message?: string,
  ): void {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    const timestamp = now();
    this.database
      .prepare("UPDATE article_tasks SET progress = ?, updated_at = ? WHERE id = ?")
      .run(clamped, timestamp, taskId);
    if (message) {
      const task = this.getTask(taskId);
      if (task) this.logAttempt(taskId, task.step, "progress", message, timestamp);
    }
  }

  /**
   * Deletes a single task (only terminal states allowed) and returns its
   * output directory (if any) so the caller can clean up artifacts on disk.
   */
  deleteTask(taskId: string): { outputDirectory: string | null } | null {
    const row = this.database
      .prepare("SELECT id, status, output_dir FROM article_tasks WHERE id = ?")
      .get(taskId) as
      | { id: string; status: TaskStatus; output_dir: string | null }
      | undefined;
    if (!row) return null;
    const outputDirectory = row.output_dir;
    this.database.transaction(() => {
      this.database
        .prepare("DELETE FROM task_attempts WHERE task_id = ?")
        .run(taskId);
      this.database
        .prepare("DELETE FROM article_tasks WHERE id = ?")
        .run(taskId);
    })();
    return { outputDirectory };
  }

  /**
   * Batch-deletes multiple tasks. Returns the list of output directories that
   * should be cleaned up by the caller.
   */
  deleteTasks(taskIds: string[]): { deletedCount: number; outputDirectories: string[] } {
    const outputDirectories: string[] = [];
    let deletedCount = 0;
    this.database.transaction(() => {
      for (const taskId of taskIds) {
        const row = this.database
          .prepare("SELECT id, output_dir FROM article_tasks WHERE id = ?")
          .get(taskId) as { id: string; output_dir: string | null } | undefined;
        if (!row) continue;
        if (row.output_dir) outputDirectories.push(row.output_dir);
        this.database
          .prepare("DELETE FROM task_attempts WHERE task_id = ?")
          .run(taskId);
        this.database
          .prepare("DELETE FROM article_tasks WHERE id = ?")
          .run(taskId);
        deletedCount++;
      }
    })();
    return { deletedCount, outputDirectories };
  }

  /**
   * Deletes an entire batch, all its tasks, import errors, and attempt logs.
   * Returns output directories for artifact cleanup.
   */
  deleteBatch(batchId: string): { outputDirectories: string[] } | null {
    const batch = this.database
      .prepare("SELECT id FROM batches WHERE id = ?")
      .get(batchId) as { id: string } | undefined;
    if (!batch) return null;
    const taskRows = this.database
      .prepare("SELECT id, output_dir FROM article_tasks WHERE batch_id = ?")
      .all(batchId) as Array<{ id: string; output_dir: string | null }>;
    const outputDirectories = taskRows
      .map((row) => row.output_dir)
      .filter((dir): dir is string => dir !== null);
    this.database.transaction(() => {
      for (const task of taskRows) {
        this.database
          .prepare("DELETE FROM task_attempts WHERE task_id = ?")
          .run(task.id);
      }
      this.database
        .prepare("DELETE FROM article_tasks WHERE batch_id = ?")
        .run(batchId);
      this.database
        .prepare("DELETE FROM import_errors WHERE batch_id = ?")
        .run(batchId);
      this.database
        .prepare("DELETE FROM batches WHERE id = ?")
        .run(batchId);
    })();
    return { outputDirectories };
  }

  private logAttempt(
    taskId: string,
    step: string,
    status: string,
    message: string,
    timestamp: string,
  ): void {
    const attempt = this.database
      .prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE task_id = ?")
      .get(taskId) as { count: number };
    this.database
      .prepare(
        `INSERT INTO task_attempts (id, task_id, attempt_number, step, status, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        taskId,
        attempt.count + 1,
        step,
        status,
        message,
        timestamp,
      );
  }
}
