import { Download, Expand, Pause, Volume2 } from "lucide-react";
import type { ArticleTask } from "@zhihu-video/contracts";

import { ManualContentEditor } from "./ManualContentEditor";

interface WorkbenchPreviewProps {
  task: ArticleTask;
  tailNote: string;
  isSaving: boolean;
  isSavingManualContent: boolean;
  onTailNoteChange: (value: string) => void;
  onSaveTailNote: () => void;
  onSaveManualContent: (title: string, content: string) => void;
  onDownload: (asset: "video" | "images") => void;
}

export function WorkbenchPreview({
  task,
  tailNote,
  isSaving,
  isSavingManualContent,
  onTailNoteChange,
  onSaveTailNote,
  onSaveManualContent,
  onDownload,
}: WorkbenchPreviewProps) {
  const title = task.finalTitle ?? task.inputTitle ?? "正在准备内容";

  return (
    <aside className="preview-panel" aria-label="当前任务预览">
      <div className="preview-heading">
        <div>
          <p className="eyebrow">当前任务</p>
          <h2>成片预览</h2>
        </div>
        <span className="page-indicator">01 / 08</span>
      </div>

      <div className="video-frame" aria-label="3:4 视频预览画布">
        <div className="video-shine" />
        <div className="video-source">来自 知乎</div>
        <div className="video-copy">
          <p className="video-kicker">知乎文章 · 图文视频</p>
          <h3>{title}</h3>
          <p>真正拉开差距的，不是某个功能，而是用户是否愿意持续使用。</p>
        </div>
        <div className="video-progress">
          <span />
        </div>
        <div className="video-controls" aria-label="视频控制">
          <button type="button" aria-label="暂停预览" className="icon-button">
            <Pause size={15} fill="currentColor" />
          </button>
          <span>00:01 / 00:08</span>
          <button type="button" aria-label="静音开关" className="icon-button">
            <Volume2 size={16} />
          </button>
          <button type="button" aria-label="全屏预览" className="icon-button">
            <Expand size={16} />
          </button>
        </div>
      </div>

      <div className="preview-downloads">
        <button
          type="button"
          className="button button-primary"
          onClick={() => onDownload("video")}
        >
          <Download size={16} />
          下载视频
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onDownload("images")}
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

      <section className="tail-note-editor" aria-labelledby="tail-note-title">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">最后一页</p>
            <h3 id="tail-note-title">尾注引导</h3>
          </div>
          <span className="character-count">{tailNote.length}/60</span>
        </div>
        <textarea
          aria-label="尾注内容"
          value={tailNote}
          maxLength={60}
          onChange={(event) => onTailNoteChange(event.target.value)}
        />
        <p className="field-hint">
          保存后只重新渲染当前任务的尾页，不会重新读取文章。
        </p>
        <button
          type="button"
          className="button button-dark full-width"
          onClick={onSaveTailNote}
          disabled={isSaving || tailNote.trim().length === 0}
        >
          {isSaving ? "正在保存…" : "保存并重新渲染尾页"}
        </button>
      </section>
    </aside>
  );
}
