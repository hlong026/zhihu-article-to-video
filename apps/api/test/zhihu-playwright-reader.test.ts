import { describe, expect, it } from "vitest";
import type { BrowserContext } from "playwright-core";

import {
  extractInPage,
  interpretPageSnapshot,
  PlaywrightZhihuContentReader,
  readBrowserConfiguration,
  type PageMetaSnapshot,
  type PageSnapshot,
} from "../src/zhihu-playwright-reader.js";

interface FakeElementOptions {
  text?: string;
  attributes?: Record<string, string>;
  selectors?: Record<string, FakeElement | null>;
  selectorLists?: Record<string, FakeElement[]>;
}

interface FakeElement {
  innerText: string;
  textContent: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
}

function fakeElement(options: FakeElementOptions = {}): FakeElement {
  return {
    innerText: options.text ?? "",
    textContent: options.text ?? "",
    getAttribute: (name) => options.attributes?.[name] ?? null,
    querySelector: (selector) => options.selectors?.[selector] ?? null,
    querySelectorAll: (selector) => options.selectorLists?.[selector] ?? [],
  };
}

function emptyPageMeta(): PageMetaSnapshot {
  return {
    authorName: null,
    authorBadge: null,
    answerCount: null,
    followCount: null,
    avatarUrl: null,
  };
}

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
    meta: emptyPageMeta(),
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

  it("passes through question-header metadata for the cover card", () => {
    const result = interpretPageSnapshot(
      snapshot({
        meta: {
          authorName: "摸鱼作家",
          authorBadge: "互联网行业 软件工程师",
          answerCount: "278",
          followCount: "623",
          avatarUrl: "https://pic1.zhimg.com/v2-abc_xl.jpg",
        },
      }),
    );
    expect(result).toEqual({
      ok: true,
      content: {
        title: "示例文章",
        paragraphs: [
          "第一段足够长的正文内容，用于通过段落长度过滤。",
          "第二段足够长的正文内容，用于通过段落长度过滤。",
        ],
        meta: {
          authorName: "摸鱼作家",
          authorBadge: "互联网行业 软件工程师",
          answerCount: "278",
          followCount: "623",
          // The avatar data URI is filled in later by the reader download.
          avatarDataUri: null,
        },
      },
    });
  });

  it("keeps column-page authors without question counters", () => {
    const result = interpretPageSnapshot(
      snapshot({
        meta: {
          authorName: "专栏作者",
          authorBadge: null,
          answerCount: null,
          followCount: null,
          avatarUrl: null,
        },
      }),
    );
    expect(result.ok && result.content.meta).toEqual({
      authorName: "专栏作者",
      authorBadge: null,
      answerCount: null,
      followCount: null,
      avatarDataUri: null,
    });
  });

  it("omits cover metadata when the page exposed none", () => {
    const result = interpretPageSnapshot(snapshot({}));
    expect(result.ok && !("meta" in result.content)).toBe(true);
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

describe("extractInPage", () => {
  it("extracts the complete current answer header for the cover", () => {
    const content = fakeElement({
      selectorLists: {
        p: [
          fakeElement({
            text: "第一段足够长的正文内容，用于验证当前知乎回答页结构。",
          }),
        ],
      },
    });
    const author = fakeElement({
      selectors: {
        ".AuthorInfo-name": null,
        "meta[itemprop='name']": fakeElement({
          attributes: { content: "摸鱼作家\u200B" },
        }),
        ".AuthorInfo-badgeText": null,
        ".AuthorInfo-detail": fakeElement({
          text: "互联网行业 软件工程师",
        }),
        "img.AuthorInfo-avatar": fakeElement({
          attributes: { src: "//pic1.zhimg.com/v2-avatar_l.jpg" },
        }),
      },
    });
    const viewed = fakeElement({
      selectors: {
        ".NumberBoard-itemName": fakeElement({ text: "被浏览" }),
        ".NumberBoard-itemValue": fakeElement({
          text: "9,999",
          attributes: { title: "9999" },
        }),
      },
    });
    const followers = fakeElement({
      selectors: {
        ".NumberBoard-itemName": fakeElement({ text: "关注者" }),
        ".NumberBoard-itemValue": fakeElement({
          text: "623",
          attributes: { title: "623" },
        }),
      },
    });
    const documentSelectors: Record<string, FakeElement | null> = {
      ".RichContent-inner": content,
      ".QuestionHeader-title": fakeElement({
        text: "为什么用 AI 写代码之后，人反而越来越累了？",
      }),
      "[itemprop='mainEntityOfPage'] .AuthorInfo": author,
      "meta[itemprop='answerCount']": null,
      ".ViewAll-QuestionMainAction": fakeElement({
        text: "查看全部 278 个回答",
      }),
      ".QuestionFollowStatus .NumberBoard-itemValue": viewed.querySelector(
        ".NumberBoard-itemValue",
      ),
    };
    const fakeDocument = {
      title: "为什么用 AI 写代码之后，人反而越来越累了？ - 知乎",
      body: fakeElement({ text: "知乎回答正文" }),
      querySelector: (selector: string) => documentSelectors[selector] ?? null,
      querySelectorAll: (selector: string) =>
        selector === ".QuestionFollowStatus .NumberBoard-item"
          ? [viewed, followers]
          : [],
    };
    const hadDocument = Reflect.has(globalThis, "document");
    const originalDocument = Reflect.get(globalThis, "document");
    Reflect.set(globalThis, "document", fakeDocument);

    try {
      expect(
        extractInPage({
          contentSelectors: [".RichContent-inner"],
          titleSelectors: [".QuestionHeader-title"],
          authorSelectors: ["[itemprop='mainEntityOfPage'] .AuthorInfo"],
          questionCounters: true,
        }),
      ).toMatchObject({
        contentTitle: "为什么用 AI 写代码之后，人反而越来越累了？",
        meta: {
          authorName: "摸鱼作家",
          authorBadge: "互联网行业 软件工程师",
          answerCount: "278",
          followCount: "623",
          avatarUrl: "https://pic1.zhimg.com/v2-avatar_l.jpg",
        },
      });
    } finally {
      if (hadDocument) Reflect.set(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
});

describe("readBrowserConfiguration", () => {
  it("defaults to the real Chrome channel in headless-first mode", () => {
    expect(readBrowserConfiguration({} as NodeJS.ProcessEnv)).toEqual({
      channel: "chrome",
      executablePath: undefined,
      headless: true,
      minIntervalMs: 3_000,
    });
  });

  it("respects an explicit headed-mode override", () => {
    expect(
      readBrowserConfiguration({
        ZHIHU_BROWSER_HEADLESS: "false",
      } as NodeJS.ProcessEnv).headless,
    ).toBe(false);
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

interface FakePageBehavior {
  url?: string;
  httpStatus?: number;
  snapshot: Omit<PageSnapshot, "url" | "httpStatus">;
}

function readablePage(): FakePageBehavior {
  return {
    snapshot: {
      title: "示例文章 - 知乎",
      bodyText: "正文内容",
      contentTitle: "示例文章",
      paragraphs: ["第一段足够长的正文内容，用于通过段落长度过滤。"],
      meta: emptyPageMeta(),
    },
  };
}

function restrictedPage(): FakePageBehavior {
  return {
    url: "https://www.zhihu.com/signin?next=%2Fanswer%2F1",
    snapshot: {
      title: "知乎 - 有问题，就会有答案",
      bodyText: "验证码登录 密码登录",
      contentTitle: null,
      paragraphs: [],
      meta: emptyPageMeta(),
    },
  };
}

/** Records launches and serves scripted pages without a real browser. */
function createFakeLauncher(pages: FakePageBehavior[]) {
  const launches: boolean[] = [];
  const gotoTimestamps: number[] = [];
  // Pages are scripted across contexts: an escalation relaunch continues the
  // script instead of restarting it.
  let pageIndex = 0;
  const launchPersistentContext = async (headless: boolean) => {
    launches.push(headless);
    const context = {
      async newPage() {
        const behavior = pages[Math.min(pageIndex++, pages.length - 1)];
        return {
          async goto() {
            gotoTimestamps.push(Date.now());
            return { status: () => behavior.httpStatus ?? 200 };
          },
          async waitForSelector() {
            return null;
          },
          async evaluate() {
            return behavior.snapshot;
          },
          url: () => behavior.url ?? "https://zhuanlan.zhihu.com/p/123",
          async content() {
            return "<html></html>";
          },
          async close() {
            return undefined;
          },
        };
      },
      async close() {
        return undefined;
      },
    };
    return context as unknown as BrowserContext;
  };
  return { launchPersistentContext, launches, gotoTimestamps };
}

function createReader(
  fake: ReturnType<typeof createFakeLauncher>,
  overrides: {
    headless?: boolean;
    minIntervalMs?: number;
    onEscalate?: (reason: string) => void;
  } = {},
) {
  return new PlaywrightZhihuContentReader({
    sessionDirectory: "/tmp/zhihu-reader-test",
    minIntervalMs: overrides.minIntervalMs ?? 0,
    launchPersistentContext: fake.launchPersistentContext,
    ...overrides,
  });
}

describe("PlaywrightZhihuContentReader headless-first escalation", () => {
  const source = {
    sourceType: "article" as const,
    canonicalUrl: "https://zhuanlan.zhihu.com/p/123",
  };

  it("escalates from headless to a visible window when access is restricted", async () => {
    const fake = createFakeLauncher([restrictedPage(), readablePage()]);
    const escalations: string[] = [];
    const reader = createReader(fake, {
      onEscalate: (reason) => escalations.push(reason),
    });

    const result = await reader.read(source);

    expect(result.ok).toBe(true);
    expect(fake.launches).toEqual([true, false]);
    expect(escalations).toHaveLength(1);
    await reader.close();
  });

  it("keeps the visible session for later reads after one escalation", async () => {
    const fake = createFakeLauncher([restrictedPage(), readablePage()]);
    const reader = createReader(fake);

    await reader.read(source);
    const second = await reader.read(source);

    expect(second.ok).toBe(true);
    // No relaunch for the second read: the visible context is reused.
    expect(fake.launches).toEqual([true, false]);
    await reader.close();
  });

  it("never escalates when started in explicit visible mode", async () => {
    const fake = createFakeLauncher([restrictedPage(), readablePage()]);
    const escalations: string[] = [];
    const reader = createReader(fake, {
      headless: false,
      onEscalate: (reason) => escalations.push(reason),
    });

    const result = await reader.read(source);

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "SOURCE_ACCESS_RESTRICTED" },
    });
    expect(fake.launches).toEqual([false]);
    expect(escalations).toHaveLength(0);
    await reader.close();
  });

  it("serializes concurrent reads and keeps the throttle interval", async () => {
    const fake = createFakeLauncher([readablePage()]);
    const reader = createReader(fake, { minIntervalMs: 60 });

    const [first, second] = await Promise.all([
      reader.read(source),
      reader.read(source),
    ]);

    expect(first.ok && second.ok).toBe(true);
    expect(fake.gotoTimestamps).toHaveLength(2);
    const gap = fake.gotoTimestamps[1] - fake.gotoTimestamps[0];
    expect(gap).toBeGreaterThanOrEqual(50);
    await reader.close();
  });
});
