import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright-core";
import type {
  CleanReadableContent,
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
 *
 * Reads start headless so batch processing never pops a window. When Zhihu
 * answers with a login / verification / risk-control wall
 * (SOURCE_ACCESS_RESTRICTED), the reader reopens the same persistent profile
 * in a visible window and retries once; the session then stays visible so
 * the operator can sign in. No cookies or credentials are copied into the
 * project database — everything stays inside the browser profile directory.
 */

export interface PlaywrightReaderOptions {
  /** Persistent browser profile directory owned by the operator. */
  sessionDirectory: string;
  /** Playwright browser channel, e.g. "chrome". Ignored when executablePath is set. */
  channel?: string;
  /** Explicit browser executable path, overrides the channel. */
  executablePath?: string;
  /**
   * Defaults to true: reads start headless and escalate to a visible window
   * only when Zhihu demands login or verification. Set false to always run
   * a visible window (legacy behavior).
   */
  headless?: boolean;
  /** Minimum delay between two page loads to stay below rate limits. */
  minIntervalMs?: number;
  navigationTimeoutMs?: number;
  /** Called once whenever the reader escalates from headless to a visible window. */
  onEscalate?: (reason: string) => void;
  /** Test hook: replaces the Playwright launcher. Receives the headless flag. */
  launchPersistentContext?: (headless: boolean) => Promise<BrowserContext>;
}

export interface PageSnapshot {
  url: string;
  httpStatus: number;
  title: string;
  bodyText: string;
  contentTitle: string | null;
  paragraphs: string[];
  meta: PageMetaSnapshot;
}

/**
 * Question-header metadata captured in-page for the cover card. Counts keep
 * their original display text (e.g. "433" or "1.2万"). Every field is
 * best-effort: a missing element yields null and the cover just skips it.
 */
export interface PageMetaSnapshot {
  authorName: string | null;
  authorBadge: string | null;
  answerCount: string | null;
  followCount: string | null;
  avatarUrl: string | null;
}

interface SelectorConfig {
  contentSelectors: string[];
  titleSelectors: string[];
  /** Author-card scope candidates; the first match wins. */
  authorSelectors: string[];
  /** Answer pages expose question counters in the question header. */
  questionCounters: boolean;
}

const ARTICLE_SELECTORS: SelectorConfig = {
  contentSelectors: [".Post-RichText", "article"],
  titleSelectors: ["h1.Post-Title", ".Post-Title"],
  authorSelectors: [".Post-Author .AuthorInfo", ".AuthorInfo"],
  questionCounters: false,
};

const ANSWER_SELECTORS: SelectorConfig = {
  contentSelectors: [".RichContent-inner", "[itemprop='text']", "article"],
  titleSelectors: [".QuestionHeader-title", "h1"],
  authorSelectors: [
    ".AnswerCard .AuthorInfo",
    ".QuestionAnswer-content .AuthorInfo",
    ".AuthorInfo",
  ],
  questionCounters: true,
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
    getAttribute(name: string): string | null;
    querySelector(selector: string): SnapshotElement | null;
    querySelectorAll(selector: string): ArrayLike<SnapshotElement>;
  }
  interface SnapshotDocument {
    title: string;
    body: SnapshotElement | null;
    querySelector(selector: string): SnapshotElement | null;
  }

  const emptyMeta = {
    authorName: null,
    authorBadge: null,
    answerCount: null,
    followCount: null,
    avatarUrl: null,
  };

  const doc = (globalThis as { document?: SnapshotDocument }).document;
  if (!doc) {
    return {
      title: "",
      bodyText: "",
      contentTitle: null,
      paragraphs: [],
      meta: emptyMeta,
    };
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

  // Author card (Zhihu question-header style): name, badge and avatar.
  let authorName: string | null = null;
  let authorBadge: string | null = null;
  let avatarUrl: string | null = null;
  let authorScope: SnapshotElement | null = null;
  for (const selector of config.authorSelectors) {
    authorScope = doc.querySelector(selector);
    if (authorScope) break;
  }
  if (authorScope) {
    const nameElement = authorScope.querySelector(".AuthorInfo-name");
    const name = (nameElement?.innerText ?? nameElement?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    authorName = name || null;
    const badgeElement = authorScope.querySelector(".AuthorInfo-badgeText");
    const badge = (badgeElement?.innerText ?? badgeElement?.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    authorBadge = badge || null;
    const avatarElement = authorScope.querySelector("img.AuthorInfo-avatar");
    const avatarSource = avatarElement?.getAttribute("src")?.trim() ?? "";
    avatarUrl = avatarSource.startsWith("https:") ? avatarSource : null;
  }

  // Question counters only exist on answer pages (the question header).
  let answerCount: string | null = null;
  let followCount: string | null = null;
  if (config.questionCounters) {
    const answerMeta = doc.querySelector("meta[itemprop='answerCount']");
    const answerContent = answerMeta?.getAttribute("content")?.trim() ?? "";
    if (answerContent) {
      answerCount = answerContent;
    } else {
      const viewAll = doc.querySelector(".ViewAll-QuestionMainAction");
      const viewAllText = (viewAll?.innerText ?? viewAll?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const match = /(\d[\d.,]*\s*万?)\s*个回答/.exec(viewAllText);
      if (match?.[1]) answerCount = match[1].replace(/\s+/g, "");
    }
    const followElement = doc.querySelector(
      ".QuestionFollowStatus .NumberBoard-itemValue",
    );
    const followTitle = followElement?.getAttribute("title")?.trim() ?? "";
    if (followTitle) {
      followCount = followTitle;
    } else {
      const followText = (
        followElement?.innerText ??
        followElement?.textContent ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      followCount = followText || null;
    }
  }

  return {
    title: doc.title ?? "",
    bodyText: (doc.body?.innerText ?? "").slice(0, 2000),
    contentTitle,
    paragraphs,
    meta: { authorName, authorBadge, answerCount, followCount, avatarUrl },
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
    content: {
      title: snapshot.contentTitle,
      paragraphs,
      // Cover metadata is optional chrome: only present when the page
      // actually exposed an author or question counters. The avatar data
      // URI is filled in later by the reader's best-effort download.
      ...(hasPageMeta(snapshot.meta)
        ? {
            meta: {
              authorName: snapshot.meta.authorName,
              authorBadge: snapshot.meta.authorBadge,
              answerCount: snapshot.meta.answerCount,
              followCount: snapshot.meta.followCount,
              avatarDataUri: null,
            },
          }
        : {}),
    },
  };
}

function hasPageMeta(meta: PageMetaSnapshot): boolean {
  return Boolean(meta.authorName ?? meta.answerCount ?? meta.followCount);
}

export class PlaywrightZhihuContentReader implements ZhihuContentReader {
  private contextPromise: Promise<BrowserContext> | null = null;
  /** Serializes reads: one profile, one page load at a time. */
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private headlessActive: boolean;
  private readonly minIntervalMs: number;
  private readonly navigationTimeoutMs: number;

  constructor(private readonly options: PlaywrightReaderOptions) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 3_000);
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.headlessActive = options.headless ?? true;
  }

  async read(source: {
    sourceType: ZhihuSourceType;
    canonicalUrl: string;
    snapshotDir?: string;
  }): Promise<SourceReadResult> {
    // Serialize every read through one promise chain. Concurrent tasks share
    // a single browser profile, and the chain doubles as the throttle mutex
    // (page loads stay >= minIntervalMs apart even at high task concurrency)
    // and as the mode-switch lock (only one headless -> visible escalation).
    const run = this.queue.then(() => this.readExclusive(source));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readExclusive(source: {
    sourceType: ZhihuSourceType;
    canonicalUrl: string;
    snapshotDir?: string;
  }): Promise<SourceReadResult> {
    let result = await this.readOnce(source);
    if (
      !result.ok &&
      result.failure.code === "SOURCE_ACCESS_RESTRICTED" &&
      this.headlessActive
    ) {
      // Headless reading hit a login / verification / risk-control wall.
      // Reopen the same persistent profile in a visible window and retry
      // once; the session stays visible so the operator can sign in.
      // Note: headless mode is more likely to be flagged by risk control and
      // this escalation path is the designated fallback. Cookies live in the
      // shared profile, so one visible login usually restores headless reads.
      this.options.onEscalate?.(result.failure.message);
      await this.closeContext();
      this.headlessActive = false;
      result = await this.readOnce(source);
    }
    return result;
  }

  private async readOnce(source: {
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

      if (result.ok && result.content.meta && snapshot.meta.avatarUrl) {
        const avatarDataUri = await this.downloadAvatar(
          context,
          snapshot.meta.avatarUrl,
        );
        if (avatarDataUri) result.content.meta.avatarDataUri = avatarDataUri;
      }

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
    const run = this.queue.then(() => this.closeContext());
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async closeContext(): Promise<void> {
    if (!this.contextPromise) return;
    const context = await this.contextPromise.catch(() => null);
    this.contextPromise = null;
    await context?.close().catch(() => undefined);
  }

  private ensureContext(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.launchContext(this.headlessActive);
      // A failed launch must not poison later retries.
      this.contextPromise.catch(() => {
        this.contextPromise = null;
      });
    }
    return this.contextPromise;
  }

  private launchContext(headless: boolean): Promise<BrowserContext> {
    if (this.options.launchPersistentContext) {
      return this.options.launchPersistentContext(headless);
    }
    const { sessionDirectory, channel, executablePath } = this.options;
    return chromium.launchPersistentContext(sessionDirectory, {
      ...(executablePath
        ? { executablePath }
        : { channel: channel ?? "chrome" }),
      headless,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }

  /**
   * Best-effort avatar fetch through the operator's browser session (zhimg
   * hotlink protection expects a Zhihu referer). Failures degrade to null so
   * the cover falls back to an initial-based placeholder.
   */
  private async downloadAvatar(
    context: BrowserContext,
    avatarUrl: string,
  ): Promise<string | null> {
    try {
      const response = await context.request.get(avatarUrl, {
        headers: { Referer: "https://www.zhihu.com/" },
        timeout: 10_000,
      });
      if (!response.ok()) return null;
      const contentType = response.headers()["content-type"] ?? "";
      const mime = contentType.split(";")[0]?.trim() || "image/jpeg";
      if (!mime.startsWith("image/")) return null;
      const buffer = await response.body();
      if (buffer.length === 0 || buffer.length > 2 * 1024 * 1024) return null;
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } catch {
      return null;
    }
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
    content: CleanReadableContent,
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
            meta: content.meta ?? null,
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
    headless: environment.ZHIHU_BROWSER_HEADLESS?.trim()
      ? environment.ZHIHU_BROWSER_HEADLESS.trim() === "true"
      : true,
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
