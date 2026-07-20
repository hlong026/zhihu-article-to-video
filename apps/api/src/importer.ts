import ExcelJS from "exceljs";

import type { SourceType } from "@zhihu-video/contracts";

export interface ImportTaskInput {
  rowNumber: number;
  sourceUrl: string;
  sourceType: SourceType;
  inputTitle: string | null;
  articleKeyword: string | null;
  sourceDate: string | null;
  needsReview: boolean;
}

export interface ImportRowError {
  rowNumber: number;
  code:
    | "EMPTY_URL"
    | "UNSUPPORTED_URL"
    | "INVALID_DATE"
    | "DUPLICATE_URL"
    | "INVALID_KEYWORD";
  message: string;
}

export interface WorkbookImportResult {
  tasks: ImportTaskInput[];
  errors: ImportRowError[];
  /** Data rows under the header, regardless of any applied import range. */
  totalDataRows: number;
}

/**
 * 1-based data-row selection (the header is row 0 of the data indexing).
 * "导入第 1-10 条" maps to `{ start: 1, end: 10 }`.
 */
export interface ImportRowRange {
  start?: number;
  end?: number;
}

const supportedUrlPatterns: Array<{ sourceType: SourceType; pattern: RegExp }> =
  [
    {
      // Both the short /answer/{id} form from the workbook and the long
      // /question/{id}/answer/{id} form copied from a browser are accepted,
      // matching packages/pipeline classifyZhihuUrl.
      sourceType: "answer",
      pattern:
        /^https:\/\/(?:www\.)?zhihu\.com\/(?:answer\/\d+|question\/\d+\/answer\/\d+)\/?(?:\?.*)?$/i,
    },
    {
      sourceType: "article",
      pattern: /^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/?(?:\?.*)?$/i,
    },
  ];

function text(value: ExcelJS.CellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value)
    return String(value.text).trim();
  return String(value).trim();
}

function normalizeHeader(value: ExcelJS.CellValue | undefined): string {
  return text(value).replace(/\s+/g, "");
}

function parseDate(
  value: ExcelJS.CellValue | undefined,
): string | null | "invalid" {
  if (value === null || value === undefined || text(value) === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString().slice(0, 10);
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime())
    ? "invalid"
    : parsed.toISOString().slice(0, 10);
}

export function classifyZhihuUrl(
  input: string,
): { canonicalUrl: string; sourceType: SourceType } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // Users frequently paste http:// links from older share dialogs or mobile
  // copies. Zhihu is https-only, so upgrade instead of rejecting the row.
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }
  const canonicalUrl = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  const match = supportedUrlPatterns.find(({ pattern }) =>
    pattern.test(canonicalUrl),
  );
  return match ? { canonicalUrl, sourceType: match.sourceType } : null;
}

type ExcelLoadInput = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];

function findFirstNonEmptyWorksheet(
  workbook: ExcelJS.Workbook,
): ExcelJS.Worksheet {
  const sheet = workbook.worksheets.find((candidate) => candidate.rowCount > 0);
  if (!sheet) throw new Error("Excel 中没有可读取的工作表");
  return sheet;
}

function toExcelLoadInput(contents: unknown): ExcelLoadInput {
  if (!Buffer.isBuffer(contents)) {
    throw new Error("Excel 文件内容无效");
  }

  // ExcelJS declares Buffer through an older Node type package. The upload is
  // checked at runtime, then adapted once at the third-party boundary.
  return contents as unknown as ExcelLoadInput;
}

export async function parseImportWorkbook(
  contents: unknown,
  rowRange: ImportRowRange = {},
): Promise<WorkbookImportResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toExcelLoadInput(contents));
  const sheet = findFirstNonEmptyWorksheet(workbook);
  const headers = new Map<string, number>();

  sheet
    .getRow(1)
    .eachCell((cell, columnNumber) =>
      headers.set(normalizeHeader(cell.value), columnNumber),
    );
  const linkColumn = headers.get("链接");
  if (!linkColumn) throw new Error("缺少必填列：链接");

  const dateColumn = headers.get("日期");
  const titleColumn = headers.get("知乎标题");
  const keywordColumn = headers.get("文章口令");
  const totalDataRows = Math.max(0, sheet.rowCount - 1);
  const result: WorkbookImportResult = { tasks: [], errors: [], totalDataRows };
  const seenUrls = new Set<string>();
  const rangeStart = rowRange.start ?? 1;
  const rangeEnd = rowRange.end ?? totalDataRows;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    // Rows outside the requested range are skipped silently: they are not
    // imported and must not produce validation errors.
    const dataIndex = rowNumber - 1;
    if (dataIndex < rangeStart || dataIndex > rangeEnd) continue;
    const row = sheet.getRow(rowNumber);
    const sourceUrl = text(row.getCell(linkColumn).value);
    if (!sourceUrl) {
      const rowValues = Array.isArray(row.values)
        ? row.values
        : Object.values(row.values ?? {});
      const isBlank = rowValues.every(
        (value) => value === null || value === undefined || value === "",
      );
      if (!isBlank)
        result.errors.push({
          rowNumber,
          code: "EMPTY_URL",
          message: "链接不能为空",
        });
      continue;
    }

    const parsedUrl = classifyZhihuUrl(sourceUrl);
    if (!parsedUrl) {
      result.errors.push({
        rowNumber,
        code: "UNSUPPORTED_URL",
        message: "仅支持知乎回答或知乎专栏链接",
      });
      continue;
    }
    if (seenUrls.has(parsedUrl.canonicalUrl)) {
      result.errors.push({
        rowNumber,
        code: "DUPLICATE_URL",
        message: "同一批次不允许重复链接",
      });
      continue;
    }
    seenUrls.add(parsedUrl.canonicalUrl);

    const sourceDate = dateColumn
      ? parseDate(row.getCell(dateColumn).value)
      : null;
    if (sourceDate === "invalid") {
      result.errors.push({
        rowNumber,
        code: "INVALID_DATE",
        message: "日期无法解析",
      });
      continue;
    }
    const articleKeyword = keywordColumn
      ? text(row.getCell(keywordColumn).value) || null
      : null;
    if (
      articleKeyword &&
      (articleKeyword.length < 2 ||
        articleKeyword.length > 30 ||
        /[\r\n]/.test(articleKeyword))
    ) {
      result.errors.push({
        rowNumber,
        code: "INVALID_KEYWORD",
        message: "文章口令需为 2～30 个字符且不能换行",
      });
      continue;
    }

    result.tasks.push({
      rowNumber,
      sourceUrl: parsedUrl.canonicalUrl,
      sourceType: parsedUrl.sourceType,
      inputTitle: titleColumn
        ? text(row.getCell(titleColumn).value) || null
        : null,
      articleKeyword,
      sourceDate,
      needsReview: !articleKeyword,
    });
  }
  return result;
}
