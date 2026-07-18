import { ClipboardPaste } from "lucide-react";
import { useEffect, useState } from "react";
import type { ArticleTask } from "@zhihu-video/contracts";

interface ManualContentEditorProps {
  task: ArticleTask;
  isSaving: boolean;
  onSave: (title: string, content: string) => void;
}

/**
 * Fallback editor for tasks whose source page cannot be fetched (Zhihu risk
 * control, login wall, deleted page). The pasted content bypasses the reader
 * on the next retry and flows through the normal AI/render pipeline.
 */
export function ManualContentEditor({
  task,
  isSaving,
  onSave,
}: ManualContentEditorProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  useEffect(() => {
    setTitle(task.manualContent?.title ?? task.inputTitle ?? "");
    setContent(task.manualContent?.paragraphs.join("\n\n") ?? "");
  }, [task.id, task.manualContent, task.inputTitle]);

  if (task.status !== "failed" && task.status !== "needs_review") {
    return null;
  }

  const canSave =
    !isSaving && title.trim().length > 0 && content.trim().length >= 12;

  return (
    <section
      className="manual-content-editor"
      aria-labelledby="manual-content-title"
    >
      <div className="section-title-row">
        <div>
          <p className="eyebrow">读取失败兜底</p>
          <h3 id="manual-content-title">手动录入正文</h3>
        </div>
        {task.manualContent ? (
          <span className="manual-content-badge">已录入</span>
        ) : null}
      </div>
      <p className="field-hint">
        知乎页面无法自动读取时，可手动粘贴标题与正文。保存后任务将跳过读取步骤重新处理。
      </p>
      <input
        type="text"
        aria-label="文章标题"
        placeholder="文章标题"
        value={title}
        maxLength={120}
        onChange={(event) => setTitle(event.target.value)}
      />
      <textarea
        aria-label="文章正文"
        placeholder="粘贴文章正文，每个段落单独一行或用空行分隔…"
        rows={6}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <button
        type="button"
        className="button button-dark full-width"
        onClick={() => onSave(title.trim(), content.trim())}
        disabled={!canSave}
      >
        <ClipboardPaste size={16} />
        {isSaving ? "正在保存…" : "保存正文并重试任务"}
      </button>
    </section>
  );
}
