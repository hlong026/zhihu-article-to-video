import { describe, expect, it } from "vitest";

import {
  interpretPageSnapshot,
  readBrowserConfiguration,
  type PageSnapshot,
} from "../src/zhihu-playwright-reader.js";

function snapshot(overrides: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: "https://zhuanlan.zhihu.com/p/123",
    httpStatus: 200,
    title: "示例文章 - 知乎",
    bodyText: "正文内容",
    contentTitle: "示例文章",
    paragraphs: [
      "第一段足够长的正文内容，用于通过段落长度过滤。",
      "第二段足够长的正文内容，用于通过段落长度过滤。",
    ],
    ...overrides,
  };
}

describe("interpretPageSnapshot", () => {
  it("returns cleaned content for a readable article page", () => {
    const result = interpretPageSnapshot(snapshot({}));
    expect(result).toEqual({
      ok: true,
      content: {
        title: "示例文章",
        paragraphs: [
          "第一段足够长的正文内容，用于通过段落长度过滤。",
          "第二段足够长的正文内容，用于通过段落长度过滤。",
        ],
      },
    });
  });

  it("filters out short noise paragraphs", () => {
    const result = interpretPageSnapshot(
      snapshot({
        paragraphs: ["广告", "第一段足够长的正文内容，用于通过段落长度过滤。"],
      }),
    );
    expect(result.ok && result.content.paragraphs).toEqual([
      "第一段足够长的正文内容，用于通过段落长度过滤。",
    ]);
  });

  it("classifies the sign-in redirect as access restricted", () => {
    const result = interpretPageSnapshot(
      snapshot({
        url: "https://www.zhihu.com/signin?next=%2Fanswer%2F1",
        contentTitle: null,
        paragraphs: [],
        bodyText: "验证码登录 密码登录",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "SOURCE_ACCESS_RESTRICTED" },
    });
  });

  it("classifies the risk-control error page as access restricted", () => {
    const result = interpretPageSnapshot(
      snapshot({
        contentTitle: null,
        paragraphs: [],
        bodyText:
          '{"error":{"message":"您当前请求存在异常，暂时限制本次访问。","code":40362}}',
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "SOURCE_ACCESS_RESTRICTED" },
    });
  });

  it("classifies the security verification page as access restricted", () => {
    const result = interpretPageSnapshot(
      snapshot({
        contentTitle: null,
        paragraphs: [],
        bodyText: "知乎安全验证 请拖动滑块完成验证",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "SOURCE_ACCESS_RESTRICTED" },
    });
  });

  it("classifies HTTP 404 as source not found", () => {
    const result = interpretPageSnapshot(
      snapshot({ httpStatus: 404, contentTitle: null, paragraphs: [] }),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "SOURCE_NOT_FOUND" },
    });
  });

  it("classifies the Zhihu 404 wasteland page as source not found", () => {
    const result = interpretPageSnapshot(
      snapshot({
        contentTitle: null,
        paragraphs: [],
        bodyText: "你似乎来到了没有知识存在的荒原",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "SOURCE_NOT_FOUND" },
    });
  });

  it("classifies a page without extractable content as empty", () => {
    const result = interpretPageSnapshot(
      snapshot({ contentTitle: null, paragraphs: [], bodyText: "知乎首页" }),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "CONTENT_EMPTY" },
    });
  });
});

describe("readBrowserConfiguration", () => {
  it("defaults to the real Chrome channel in headed mode", () => {
    expect(readBrowserConfiguration({} as NodeJS.ProcessEnv)).toEqual({
      channel: "chrome",
      executablePath: undefined,
      headless: false,
      minIntervalMs: 3_000,
    });
  });

  it("reads overrides from the environment", () => {
    expect(
      readBrowserConfiguration({
        ZHIHU_BROWSER_CHANNEL: "msedge",
        ZHIHU_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
        ZHIHU_BROWSER_HEADLESS: "true",
        ZHIHU_READ_MIN_INTERVAL_MS: "5000",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      channel: "msedge",
      executablePath: "/usr/bin/chromium",
      headless: true,
      minIntervalMs: 5_000,
    });
  });
});
