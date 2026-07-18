import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";
import type {
  SourceReadResult,
  ZhihuContentReader,
  ZhihuSourceType,
} from "@zhihu-video/pipeline";

/**
 * Playwright-backed Zhihu reader.
 *
 * Zhihu serves a JavaScript challenge (zse-ck) to plain HTTP clients and
 * rate-limits automated browsers at the API layer, so the reader drives a
 * real Chrome channel through a persistent, operator-owned browser profile.
 * The operator signs in once inside the opened window; the session is reused
 * by later tasks. No cookies or credentials are copied into the project
 * database — everything stays inside the browser profile directory.
 */

export interface PlaywrightReaderOptions {
  /** Persistent browser profile directory owned by the operator. */
  sessionDirectory: string;
  /** Playwright browser channel, e.g. "chrome". Ignored when executablePath is set. */
  channel?: string;
  /** Explicit browser executable path, overrides the channel. */
  executablePath?: string;
  /** Headless mode is detectable by Zhihu risk control; keep it off by default. */
  headless?: boolean;
  /** Minimum delay between two page loads to stay below rate limits. */
  minIntervalMs?: number;
  navigationTimeoutMs?: number;
}

export interface PageSnapshot {
  url: string;
  httpStatus: number;
  title: string;
  bodyText: string;
  contentTitle: string | null;
  paragraphs: string[];
}

interface SelectorConfig {
  contentSelectors: string[];
  titleSelectors: string[];
}

const ARTICLE_SELECTORS: SelectorConfig = {
  contentSelectors: [".Post-RichText", "article"],
  titleSelectors: ["h1.Post-Title", ".Post-Title"],
};

const ANSWER_SELECTORS: SelectorConfig = {
  contentSelectors: [".RichContent-inner", "[itemprop='text']", "article"],
  titleSelectors: [".QuestionHeader-title", "h1"],
};

const CONTENT_WAIT_SELECTOR = ".Post-RichText, .RichContent-inner, article";

const MIN_PARAGRAPH_LENGTH = 12;
const MAX_PARAGRAPHS = 80;

function selectorsFor(sourceType: ZhihuSourceType): SelectorConfig {
  return sourceType === "article" ? ARTICLE_SELECTORS : ANSWER_SELECTORS;
}

/** Runs inside the page. Must not reference module-scope values. */
export function extractInPage(
  config: SelectorConfig,
): Omit<PageSnapshot, "url" | "httpStatus"> {
  interface SnapshotElement {
    innerText?: string;
    textContent?: string | null;
    querySelectorAll(selector: string): ArrayLike<SnapshotElement>;
  }
  interface SnapshotDocument {
    title: string;
    body: SnapshotElement | null;
    querySelector(selector: string): SnapshotElement | null;
  }

  const doc = (globalThis as { document?: SnapshotDocument }).document;
  if (!doc) {
    return { title: "", bodyText: "", contentTitle: null, paragraphs: [] };
  }

  // NOTE: nested helpers cannot be extracted here. tsx/esbuild appends a
  // __name(...) call after any nested function, and __name is undefined when
  // Playwright serializes this function into the browser. Keep the text
  // normalization inline instead.
  let container: SnapshotElement | null = null;
  for (const selector of config.contentSelectors) {
    container = doc.querySelector(selector);
    if (container) break;
  }

  const paragraphs: string[] = [];
  if (container) {
    for (const node of Array.from(container.querySelectorAll("p"))) {
      const value = (node?.innerText ?? node?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (value) paragraphs.push(value);
    }
  }

  let contentTitle: string | null = null;
  for (const selector of config.titleSelectors) {
    const element = doc.querySelector(selector);
    const value = (element?.innerText ?? element?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (value) {
      contentTitle = value;
      break;
    }
  }
  if (!contentTitle) {
    const fallback = (doc.title ?? "").replace(/\s*-\s*知乎\s*$/, "").trim();
    contentTitle = fallback || null;
  }

  return {
    title: doc.title ?? "",
    bodyText: (doc.body?.innerText ?? "").slice(0, 2000),
    contentTitle,
    paragraphs,
  };
}

/**
 * Turns a raw page snapshot into a truthful read result. Kept pure so the
 * failure taxonomy stays testable without launching a browser.
 */
export function interpretPageSnapshot(
  snapshot: PageSnapshot,
): SourceReadResult {
  const bodyText = snapshot.bodyText;

  if (
    snapshot.httpStatus === 404 ||
    bodyText.includes("没有知识存在的荒原") ||
    snapshot.title.includes("404")
  ) {
    return failure("SOURCE_NOT_FOUND", "知乎页面不存在或已删除。");
  }

  if (snapshot.url.includes("/signin")) {
    return failure(
      "SOURCE_ACCESS_RESTRICTED",
      "知乎要求登录后才能查看。请在自动打开的浏览器窗口中登录知乎，然后重试该任务。",
    );
  }

  if (
    bodyText.includes("请求存在异常") ||
    bodyText.includes("暂时限制本次访问")
  ) {
    return failure(
      "SOURCE_ACCESS_RESTRICTED",
      "知乎风控暂时限制了本次访问。请在浏览器窗口中完成验证，或稍后重试该任务。",
    );
  }

  if (bodyText.includes("安全验证") && snapshot.paragraphs.length === 0) {
    return failure(
      "SOURCE_ACCESS_RESTRICTED",
      "知乎要求完成安全验证。请在浏览器窗口中拖动滑块完成验证后重试。",
    );
  }

  const paragraphs = snapshot.paragraphs
    .filter((paragraph) => paragraph.length >= MIN_PARAGRAPH_LENGTH)
    .slice(0, MAX_PARAGRAPHS);
  if (!snapshot.contentTitle || paragraphs.length === 0) {
    return failure(
      "CONTENT_EMPTY",
      "页面未提取到公开正文，可能需要登录、页面结构已变更或内容已被删除。",
    );
  }

  return {
    ok: true,
    content: { title: snapshot.contentTitle, paragraphs },
  };
}

export class PlaywrightZhihuContentReader implements ZhihuContentReader {
  private contextPromise: Promise<BrowserContext> | null = null;
  private lastRequestAt = 0;
  private readonly minIntervalMs: number;
  private readonly navigationTimeoutMs: number;

  constructor(private readonly options: PlaywrightReaderOptions) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 3_000);
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
  }

  async read(source: {
    sourceType: ZhihuSourceType;
    canonicalUrl: string;
    snapshotDir?: string;
  }): Promise<SourceReadResult> {
    let context: BrowserContext;
    try {
      context = await this.ensureContext();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return failure(
        "NETWORK_ERROR",
        `无法启动浏览器会话（${detail}）。请确认已安装 Chrome，或通过 ZHIHU_BROWSER_EXECUTABLE_PATH 指定浏览器路径。`,
      );
    }

    await this.throttle();
    const page = await context.newPage();
    try {
      const response = await page.goto(source.canonicalUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.navigationTimeoutMs,
      });
      // Content renders after the initial HTML; wait briefly but continue
      // anyway so risk-control pages are classified by their visible text.
      await page
        .waitForSelector(CONTENT_WAIT_SELECTOR, { timeout: 8_000 })
        .catch(() => undefined);

      const snapshot = await page.evaluate(
        extractInPage,
        selectorsFor(source.sourceType),
      );
      const result = interpretPageSnapshot({
        ...snapshot,
        url: page.url(),
        httpStatus: response?.status() ?? 0,
      });

      if (result.ok && source.snapshotDir) {
        const snapshotPath = await this.persistSnapshot(
          source.snapshotDir,
          page,
          result.content,
        );
        if (snapshotPath) result.snapshotPath = snapshotPath;
      }
      return result;
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      return failure(
        "NETWORK_ERROR",
        isTimeout
          ? "知乎页面读取超时。"
          : `知乎页面网络读取失败（${error instanceof Error ? error.message : String(error)}）。`,
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.contextPromise) return;
    const context = await this.contextPromise.catch(() => null);
    this.contextPromise = null;
    await context?.close().catch(() => undefined);
  }

  private ensureContext(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      const { sessionDirectory, channel, executablePath, headless } =
        this.options;
      this.contextPromise = chromium.launchPersistentContext(sessionDirectory, {
        ...(executablePath
          ? { executablePath }
          : { channel: channel ?? "chrome" }),
        headless: headless ?? false,
        viewport: { width: 1280, height: 900 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        args: ["--disable-blink-features=AutomationControlled"],
      });
      // A failed launch must not poison later retries.
      this.contextPromise.catch(() => {
        this.contextPromise = null;
      });
    }
    return this.contextPromise;
  }

  private async throttle(): Promise<void> {
    const waitMs = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.lastRequestAt = Date.now();
  }

  private async persistSnapshot(
    directory: string,
    page: Page,
    content: { title: string; paragraphs: string[] },
  ): Promise<string | null> {
    try {
      await mkdir(directory, { recursive: true });
      const htmlPath = join(directory, "source.html");
      await writeFile(htmlPath, await page.content(), "utf8");
      await writeFile(
        join(directory, "source.json"),
        JSON.stringify(
          {
            title: content.title,
            paragraphs: content.paragraphs,
            fetchedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      return htmlPath;
    } catch {
      // Snapshot persistence must never block the reading pipeline.
      return null;
    }
  }
}

export function readBrowserConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<
  PlaywrightReaderOptions,
  "channel" | "executablePath" | "headless" | "minIntervalMs"
> {
  return {
    channel: environment.ZHIHU_BROWSER_CHANNEL?.trim() || "chrome",
    executablePath:
      environment.ZHIHU_BROWSER_EXECUTABLE_PATH?.trim() || undefined,
    headless: environment.ZHIHU_BROWSER_HEADLESS?.trim() === "true",
    minIntervalMs: Number(environment.ZHIHU_READ_MIN_INTERVAL_MS ?? 3_000),
  };
}

function failure(
  code:
    | "SOURCE_NOT_FOUND"
    | "SOURCE_ACCESS_RESTRICTED"
    | "CONTENT_EMPTY"
    | "NETWORK_ERROR",
  message: string,
): SourceReadResult {
  return { ok: false, failure: { code, message } };
}
