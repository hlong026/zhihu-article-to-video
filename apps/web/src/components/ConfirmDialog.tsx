import { AlertTriangle, X } from "lucide-react";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="confirm-dialog-header">
          <span className={`confirm-dialog-icon${danger ? " is-danger" : ""}`}>
            <AlertTriangle size={20} />
          </span>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭"
            onClick={onCancel}
            disabled={isLoading}
          >
            <X size={17} />
          </button>
        </header>
        <h2 id="confirm-dialog-title" className="confirm-dialog-title">
          {title}
        </h2>
        <p id="confirm-dialog-desc" className="confirm-dialog-desc">
          {description}
        </p>
        <footer className="dialog-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={isLoading}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${danger ? "button-danger" : "button-dark"}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? "处理中…" : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
