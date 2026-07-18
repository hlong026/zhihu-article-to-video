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
