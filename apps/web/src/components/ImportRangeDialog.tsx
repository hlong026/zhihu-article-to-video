import { FileSpreadsheet, X } from "lucide-react";
import { useState } from "react";

import type { ImportRangeSelection, PreparedImport } from "../api/client";

interface ImportRangeDialogProps {
  prepared: PreparedImport;
  isImporting: boolean;
  onConfirm: (range: ImportRangeSelection) => void;
  onCancel: () => void;
}

type QuickChoice = "all" | "first10" | "first20" | "custom";

function rangeFor(choice: QuickChoice, total: number): ImportRangeSelection {
  switch (choice) {
    case "first10":
      return { startRow: 1, endRow: Math.min(10, total) };
    case "first20":
      return { startRow: 1, endRow: Math.min(20, total) };
    default:
      return {};
  }
}

/**
 * Second step of the two-step import flow: after the dry-run preview, the
 * operator picks how many data rows (header excluded, 1-based) to import.
 */
export function ImportRangeDialog({
  prepared,
  isImporting,
  onConfirm,
  onCancel,
}: ImportRangeDialogProps) {
  const { preview } = prepared;
  const total = preview.totalDataRows;
  const [choice, setChoice] = useState<QuickChoice>("all");
  const [customStart, setCustomStart] = useState("1");
  const [customEnd, setCustomEnd] = useState(String(Math.max(total, 1)));

  const customStartNumber = Number(customStart);
  const customEndNumber = Number(customEnd);
  const customValid =
    Number.isInteger(customStartNumber) &&
    Number.isInteger(customEndNumber) &&
    customStartNumber >= 1 &&
    customEndNumber >= customStartNumber &&
    customEndNumber <= total;

  const selectedRange: ImportRangeSelection =
    choice === "custom"
      ? customValid
        ? { startRow: customStartNumber, endRow: customEndNumber }
        : {}
      : rangeFor(choice, total);

  const selectedCount =
    choice === "all"
      ? total
      : choice === "custom"
        ? customValid
          ? customEndNumber - customStartNumber + 1
          : 0
        : (selectedRange.endRow ?? total) - (selectedRange.startRow ?? 1) + 1;

  const quickOptions: Array<{ id: QuickChoice; label: string }> = [
    { id: "all", label: `全部（${total} 条）` },
    { id: "first10", label: "前 10 条" },
    { id: "first20", label: "前 20 条" },
    { id: "custom", label: "自定义范围" },
  ];

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <p className="eyebrow">导入范围</p>
            <h2 id="import-dialog-title">选择要导入的文章行</h2>
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭导入范围选择"
            onClick={onCancel}
          >
            <X size={17} />
          </button>
        </header>

        <div className="import-dialog-file">
          <span className="file-icon">
            <FileSpreadsheet size={20} />
          </span>
          <div>
            <strong>{prepared.fileName}</strong>
            <span>
              共 {total} 条数据（不含表头），{preview.validCount} 条有效，
              {preview.errorCount} 条有问题
            </span>
          </div>
        </div>

        {preview.sample.length > 0 ? (
          <ol className="import-sample" aria-label="数据预览（前几条）">
            {preview.sample.map((row) => (
              <li key={row.rowNumber}>
                <span className="import-sample-row">#{row.rowNumber}</span>
                <span className="import-sample-title">
                  {row.inputTitle ?? row.sourceUrl}
                </span>
                <span
                  className={`import-sample-keyword${row.hasKeyword ? " has-keyword" : ""}`}
                >
                  {row.hasKeyword ? "有口令" : "无口令"}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        <div className="import-range-options" role="group" aria-label="快捷范围">
          {quickOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`range-option${choice === option.id ? " is-selected" : ""}`}
              onClick={() => setChoice(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {choice === "custom" ? (
          <div className="import-custom-range">
            <label>
              起始行
              <input
                type="number"
                min={1}
                max={total}
                value={customStart}
                onChange={(event) => setCustomStart(event.target.value)}
              />
            </label>
            <span aria-hidden="true">—</span>
            <label>
              结束行
              <input
                type="number"
                min={1}
                max={total}
                value={customEnd}
                onChange={(event) => setCustomEnd(event.target.value)}
              />
            </label>
            {!customValid ? (
              <p className="import-range-error" role="alert">
                请输入 1 ~ {total} 之间的有效起止行号（起始行不大于结束行）。
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="field-hint">
          行号按数据条序号计算（不含表头，从 1 开始）；范围外的行会被静默跳过。
          本次将导入 {selectedCount} 行。
        </p>

        <footer className="dialog-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onCancel}
            disabled={isImporting}
          >
            取消
          </button>
          <button
            type="button"
            className="button button-dark"
            disabled={isImporting || selectedCount <= 0}
            onClick={() => onConfirm(selectedRange)}
          >
            {isImporting ? "正在导入…" : `导入 ${selectedCount} 条并开始处理`}
          </button>
        </footer>
      </section>
    </div>
  );
}
