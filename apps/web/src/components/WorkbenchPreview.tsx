import { AlertTriangle, Download, Wrench } from "lucide-react";
import type { ArticleTask, ArticleTaskDetail } from "@zhihu-video/contracts";

import { renderTailNotePreview } from "../api/client";
import { ManualContentEditor } from "./ManualContentEditor";
import { AttemptTimeline, TaskPreviewMedia } from "./TaskPreviewMedia";

interface WorkbenchPreviewProps {
  task: ArticleTask;
  detail: ArticleTaskDetail | null;
  keyword: string;
  isSavingKeyword: boolean;
  isSavingManualContent: boolean;
  onKeywordChange: (value: string) => void;
  onSaveKeyword: () => void;
  onSaveManualContent: (title: string, content: string) => void;
  onDownload: (asset: "video" | "images") => void;
}

/**
 * Right-hand panel for the selected task: real rendered preview, manual
 * content fallback, and the keyword editor. The tail-note format is locked —
 * only the keyword itself is editable; the note copy is always derived.
 */
export function WorkbenchPreview({
  task,
  detail,
  keyword,
  isSavingKeyword,
  isSavingManualContent,
  onKeywordChange,
  onSaveKeyword,
  onSaveManualContent,
  onDownload,
}: WorkbenchPreviewProps) {
  const title =
    task.finalTitle ?? task.fetchedTitle ?? task.inputTitle ?? "正在准备内容";
  const trimmedKeyword = keyword.trim();
  const keywordLength = Array.from(trimmedKeyword).length;
  const keywordValid = keywordLength >= 2 && keywordLength <= 30;
  const keywordDirty = trimmedKeyword !== (task.articleKeyword ?? "");
  // Dirty-data detector: the stored note disagrees with the locked format.
  const expectedTailNote = task.articleKeyword
    ? renderTailNotePreview(task.articleKeyword)
    : null;
  const tailNoteMismatch =
    expectedTailNote !== null && task.tailNote !== expectedTailNote;

  return (
    <aside className="preview-panel" aria-label="当前任务预览">
      <div className="preview-heading">
        <div>
          <p className="eyebrow">当前任务</p>
          <h2>{title}</h2>
        </div>
      </div>

      <TaskPreviewMedia task={task} detail={detail} />

      <div className="preview-downloads">
        <button
          type="button"
          className="button button-primary"
          onClick={() => onDownload("video")}
          disabled={task.status !== "completed"}
        >
          <Download size={16} />
          下载视频
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onDownload("images")}
          disabled={task.status !== "completed"}
        >
          <Download size={16} />
          下载图片
        </button>
      </div>

      <ManualContentEditor
        task={task}
        isSaving={isSavingManualContent}
        onSave={onSaveManualContent}
      />

      <section className="tail-note-editor" aria-labelledby="keyword-editor-title">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">最后一页</p>
            <h3 id="keyword-editor-title">文章口令</h3>
          </div>
          <span className="character-count">{keywordLength}/30</span>
        </div>

        <input
          type="text"
          className="keyword-input"
          aria-label="文章口令"
          placeholder="输入 2~30 个字符的文章口令"
          value={keyword}
          maxLength={30}
          onChange={(event) => onKeywordChange(event.target.value)}
        />

        <p className="tail-note-preview" aria-live="polite">
          {trimmedKeyword
            ? renderTailNotePreview(trimmedKeyword)
            : "来知乎搜索🔍{文章口令}可以看到全文"}
        </p>

        {!trimmedKeyword ? (
          <p className="keyword-warning" role="note">
            <AlertTriangle size={14} />
            缺少口令，任务需人工确认后才能生成尾页。
          </p>
        ) : null}

        {tailNoteMismatch ? (
          <div className="keyword-warning keyword-mismatch" role="alert">
            <AlertTriangle size={14} />
            <span>
              当前尾注「{task.tailNote}」与口令不一致。
            </span>
            <button
              type="button"
              className="text-button action-emphasis"
              onClick={onSaveKeyword}
              disabled={isSavingKeyword || !keywordDirty}
            >
              <Wrench size={13} />
              一键修复
            </button>
          </div>
        ) : null}

        <p className="field-hint">
          尾注格式已锁定，只保存口令本身；已完成任务保存后会自动重新渲染尾页与视频。
        </p>
        <button
          type="button"
          className="button button-dark full-width"
          onClick={onSaveKeyword}
          disabled={isSavingKeyword || !keywordValid || !keywordDirty}
        >
          {isSavingKeyword
            ? "正在保存…"
            : task.status === "completed"
              ? "保存口令并重渲尾页"
              : "保存口令"}
        </button>
      </section>

      {task.status === "failed" || task.status === "needs_review" ? (
        <AttemptTimeline detail={detail} />
      ) : null}
    </aside>
  );
}
