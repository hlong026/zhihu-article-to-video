import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseImportWorkbook } from "../src/importer.js";

describe("Excel import", () => {
  it("imports valid Zhihu answer and article links while retaining row errors", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("任务");
    sheet.addRow(["日期", "知乎标题", "链接", "文章口令"]);
    sheet.addRow([
      "2026-07-15",
      "回答",
      "https://www.zhihu.com/answer/123",
      "回答口令",
    ]);
    sheet.addRow([
      "2026-07-15",
      "专栏",
      "https://zhuanlan.zhihu.com/p/456",
      "专栏口令",
    ]);
    sheet.addRow(["2026-07-15", "坏链接", "https://example.com/a", "口令"]);

    const parsed = await parseImportWorkbook(await workbook.xlsx.writeBuffer());

    expect(parsed.tasks).toEqual([
      expect.objectContaining({
        sourceType: "answer",
        sourceUrl: "https://www.zhihu.com/answer/123",
        rowNumber: 2,
      }),
      expect.objectContaining({
        sourceType: "article",
        sourceUrl: "https://zhuanlan.zhihu.com/p/456",
        rowNumber: 3,
      }),
    ]);
    expect(parsed.errors).toEqual([
      expect.objectContaining({ rowNumber: 4, code: "UNSUPPORTED_URL" }),
    ]);
  });

  it("accepts long question/answer URLs copied from a browser", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("任务");
    sheet.addRow(["链接", "文章口令"]);
    sheet.addRow([
      "https://www.zhihu.com/question/1956789/answer/1899544678284474188?utm_source=share",
      "长链口令",
    ]);

    const parsed = await parseImportWorkbook(await workbook.xlsx.writeBuffer());

    expect(parsed.errors).toEqual([]);
    expect(parsed.tasks).toEqual([
      expect.objectContaining({
        sourceType: "answer",
        sourceUrl:
          "https://www.zhihu.com/question/1956789/answer/1899544678284474188",
      }),
    ]);
  });

  it("requires the link column and marks a missing keyword for review", async () => {
    const noLinkWorkbook = new ExcelJS.Workbook();
    noLinkWorkbook.addWorksheet("任务").addRow(["知乎标题"]);
    await expect(
      parseImportWorkbook(await noLinkWorkbook.xlsx.writeBuffer()),
    ).rejects.toThrow("缺少必填列：链接");

    const noKeywordWorkbook = new ExcelJS.Workbook();
    const sheet = noKeywordWorkbook.addWorksheet("任务");
    sheet.addRow(["链接", "文章口令"]);
    sheet.addRow(["https://www.zhihu.com/answer/1", ""]);
    const parsed = await parseImportWorkbook(
      await noKeywordWorkbook.xlsx.writeBuffer(),
    );
    expect(parsed.tasks[0]).toMatchObject({
      needsReview: true,
      articleKeyword: null,
    });
  });
});

describe("Excel import row ranges", () => {
  async function workbookWithRows(rows: string[][]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("任务");
    sheet.addRow(["知乎标题", "链接", "文章口令"]);
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  it("imports only the selected data-row range and reports totalDataRows", async () => {
    const buffer = await workbookWithRows([
      ["任务一", "https://www.zhihu.com/answer/1", "口令一"],
      ["任务二", "https://www.zhihu.com/answer/2", "口令二"],
      ["任务三", "https://www.zhihu.com/answer/3", "口令三"],
      ["任务四", "https://www.zhihu.com/answer/4", "口令四"],
      ["任务五", "https://www.zhihu.com/answer/5", "口令五"],
    ]);

    const parsed = await parseImportWorkbook(buffer, { start: 2, end: 3 });

    expect(parsed.totalDataRows).toBe(5);
    expect(parsed.tasks.map((task) => task.rowNumber)).toEqual([3, 4]);
    expect(parsed.errors).toEqual([]);
  });

  it("clamps an end row beyond the last data row", async () => {
    const buffer = await workbookWithRows([
      ["任务一", "https://www.zhihu.com/answer/1", "口令一"],
      ["任务二", "https://www.zhihu.com/answer/2", "口令二"],
    ]);

    const parsed = await parseImportWorkbook(buffer, { start: 2, end: 99 });

    expect(parsed.totalDataRows).toBe(2);
    expect(parsed.tasks.map((task) => task.rowNumber)).toEqual([3]);
  });

  it("skips rows outside the range silently, including invalid ones", async () => {
    const buffer = await workbookWithRows([
      ["坏链接", "https://example.com/a", "口令"],
      ["任务二", "https://www.zhihu.com/answer/2", "口令二"],
      ["任务三", "https://www.zhihu.com/answer/3", "口令三"],
    ]);

    const parsed = await parseImportWorkbook(buffer, { start: 2, end: 3 });

    expect(parsed.errors).toEqual([]);
    expect(parsed.tasks.map((task) => task.rowNumber)).toEqual([3, 4]);
  });

  it("deduplicates within the selected range only", async () => {
    const buffer = await workbookWithRows([
      ["任务一", "https://www.zhihu.com/answer/1", "口令一"],
      ["任务二", "https://www.zhihu.com/answer/2", "口令二"],
      ["任务三", "https://www.zhihu.com/answer/2", "口令三"],
      ["任务四", "https://www.zhihu.com/answer/1", "口令四"],
    ]);

    const parsed = await parseImportWorkbook(buffer, { start: 2, end: 4 });

    // Row 5 repeats the row-2 link, but row 2 is outside the range and was
    // never seen, so it imports cleanly; row 4 duplicates row 3 in-range.
    expect(parsed.tasks.map((task) => task.rowNumber)).toEqual([3, 5]);
    expect(parsed.errors).toEqual([
      expect.objectContaining({ rowNumber: 4, code: "DUPLICATE_URL" }),
    ]);
  });
});
