import { mkdir, rm, writeFile } from "node:fs/promises";
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
 * rate-limits automated browsers at the API layer, so the reader prefers
 * driving a real branded browser through a persistent, operator-owned
 * profile. The actual browser is picked upstream by resolveBrowserLaunch
 * (local Chrome/Edge first, bundled Chromium as fallback).
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
  /**
   * Explicit browser executable path, overrides the channel. When neither
   * channel nor executablePath is set, Playwright launches its own chromium.
   */
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
  /**
   * Maximum time (ms) to keep waiting for the operator to complete login or
   * verification in a visible window before giving up. Defaults to 180_000.
   */
  interactiveWaitMs?: number;
  /** Called when the reader starts waiting for operator login/verification. */
  onInteractiveWait?: (reason: string) => void;
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
  /** Hydrated elements required before the page snapshot is evaluated. */
  metadataWaitSelectors?: string[];
  /** Answer pages expose question counters in the question header. */
  questionCounters: boolean;
}

const ARTICLE_SELECTORS: SelectorConfig = {
  contentSelectors: [".Post-RichText", "article"],
  titleSelectors: ["h1.Post-Title", ".Post-Title"],
  authorSelectors: [".Post-Author .AuthorInfo", ".AuthorInfo"],
  metadataWaitSelectors: [".Post-Author .AuthorInfo-name"],
  questionCounters: false,
};

const ANSWER_SELECTORS: SelectorConfig = {
  contentSelectors: [".RichContent-inner", "[itemprop='text']", "article"],
  titleSelectors: [".QuestionHeader-title", "h1"],
  authorSelectors: [
    "[itemprop='mainEntityOfPage'] .AuthorInfo",
    ".AnswerItem-authorInfo .AuthorInfo",
    ".AnswerCard .AuthorInfo",
    ".QuestionAnswer-content .AuthorInfo",
    ".AuthorInfo",
  ],
  metadataWaitSelectors: [
    ".AnswerItem .AuthorInfo-name, .AnswerItem meta[itemprop='name']",
    ".QuestionFollowStatus .NumberBoard-itemValue, .ViewAll-QuestionMainAction",
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
    querySelectorAll(selector: string): ArrayLike<SnapshotElement>;
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
    // Ask the browser for ordinary paragraphs and top-level quotes in one
    // selector so its document-order result preserves the article's flow.
    // A quote is extracted as one unit: its nested <p> elements are excluded
    // to avoid emitting the quote twice, once as a paragraph and once as the
    // blockquote's full text. Nested quotes are likewise owned by their
    // outermost quote.
    for (const node of Array.from(
      container.querySelectorAll(
        "p:not(blockquote p), blockquote:not(blockquote blockquote)",
      ),
    )) {
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
    const nameMeta = authorScope.querySelector("meta[itemprop='name']");
    const name = (
      nameElement?.innerText ??
      nameElement?.textContent ??
      nameMeta?.getAttribute("content") ??
      ""
    )
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    authorName = name || null;
    const badgeElement = authorScope.querySelector(".AuthorInfo-badgeText");
    const detailElement = authorScope.querySelector(".AuthorInfo-detail");
    const badge = (
      badgeElement?.innerText ??
      badgeElement?.textContent ??
      detailElement?.innerText ??
      detailElement?.textContent ??
      ""
    )
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    authorBadge = badge || null;
    const avatarElement = authorScope.querySelector("img.AuthorInfo-avatar");
    const avatarMeta = authorScope.querySelector("meta[itemprop='image']");
    const avatarSrcset = avatarElement?.getAttribute("srcset")?.trim() ?? "";
    const avatarSource = (
      avatarElement?.getAttribute("src") ??
      avatarElement?.getAttribute("data-original") ??
      avatarElement?.getAttribute("data-src") ??
      avatarSrcset.split(",")[0]?.trim().split(/\s+/)[0] ??
      avatarMeta?.getAttribute("content") ??
      ""
    ).trim();
    avatarUrl = avatarSource.startsWith("//")
      ? `https:${avatarSource}`
      : avatarSource.startsWith("https:")
        ? avatarSource
        : null;
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
    for (const item of Array.from(
      doc.querySelectorAll(".QuestionFollowStatus .NumberBoard-item"),
    )) {
      const labelElement = item.querySelector(".NumberBoard-itemName");
      const label = (labelElement?.innerText ?? labelElement?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!label.includes("关注")) continue;
      const valueElement = item.querySelector(".NumberBoard-itemValue");
      const value = (
        valueElement?.getAttribute("title") ??
        valueElement?.innerText ??
        valueElement?.textContent ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      followCount = value || null;
      break;
    }
    if (!followCount) {
      const followElement = doc.querySelector(
        ".QuestionFollowStatus .NumberBoard-itemValue",
      );
      const followValue = (
        followElement?.getAttribute("title") ??
        followElement?.innerText ??
        followElement?.textContent ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      followCount = followValue || null;
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

/**
 * Chrome leaves lock / crash-recovery artifacts in the profile directory
 * after an unclean exit. On Windows a crashed browser can leave these stale
 * files behind, causing every subsequent launch to exit immediately
 * ("Target page, context or browser has been closed" crash loop). Removing
 * them before a retry breaks the loop.
 */
const STALE_PROFILE_ARTIFACTS = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "lockfile",
];

/**
 * Recycle the persistent browser context after this many successful reads.
 * Chrome's memory footprint grows with every navigation even when pages are
 * closed; restarting every N reads keeps long batches (40+ tasks) stable on
 * machines with 8 GB RAM or less.
 */
const CONTEXT_RECYCLE_AFTER_READS = 20;

export class PlaywrightZhihuContentReader implements ZhihuContentReader {
  private contextPromise: Promise<BrowserContext> | null = null;
  /** Serializes reads: one profile, one page load at a time. */
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private headlessActive: boolean;
  /** Successful reads since the last context (re)launch, for recycling. */
  private readsSinceLaunch = 0;
  private readonly minIntervalMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly interactiveWaitMs: number;

  constructor(private readonly options: PlaywrightReaderOptions) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 3_000);
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.interactiveWaitMs = Math.max(0, options.interactiveWaitMs ?? 180_000);
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
        `无法启动浏览器会话（${detail}）。请安装 Chrome 或 Edge，或通过 ZHIHU_BROWSER_EXECUTABLE_PATH 指定浏览器路径。`,
      );
    }

    await this.throttle();
    let page: Awaited<ReturnType<BrowserContext["newPage"]>>;
    try {
      page = await context.newPage();
    } catch {
      // The cached context is dead (browser process crashed or was killed).
      // Discard it and retry once with a fresh launch so a single crash does
      // not poison every remaining task in the batch.
      await this.closeContext();
      try {
        context = await this.ensureContext();
        page = await context.newPage();
      } catch (relaunchError) {
        const detail =
          relaunchError instanceof Error
            ? relaunchError.message
            : String(relaunchError);
        return failure(
          "NETWORK_ERROR",
          `浏览器进程异常退出后重启失败（${detail}）。请关闭占用内存的程序后重试。`,
        );
      }
    }
    try {
      const response = await page.goto(source.canonicalUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.navigationTimeoutMs,
      });
      const selectors = selectorsFor(source.sourceType);
      // Content and header metadata hydrate independently. Waiting in parallel
      // avoids adding serial latency while ensuring the cover sees both blocks.
      await Promise.all([
        page
          .waitForSelector(CONTENT_WAIT_SELECTOR, { timeout: 8_000 })
          .catch(() => undefined),
        ...(selectors.metadataWaitSelectors ?? []).map((selector) =>
          page
            .waitForSelector(selector, { timeout: 3_000 })
            .catch(() => undefined),
        ),
      ]);

      const httpStatus = response?.status() ?? 0;
      let snapshot = await page.evaluate(extractInPage, selectors);
      let result = interpretPageSnapshot({
        ...snapshot,
        url: page.url(),
        httpStatus,
      });

      // 可见模式下命中登录/验证/风控墙（或正文为空——首次无登录态时
      // 知乎可能不做 /signin 重定向而只是不渲染正文）：停在当前页等待
      // 用户完成操作，而非立即失败，避免"刚弹窗就翻页"导致无法扫码/拖滑块。
      if (
        !result.ok &&
        isInteractiveWaitCode(result.failure.code) &&
        !this.headlessActive
      ) {
        ({ result, snapshot } = await this.waitForInteractiveAccess(
          page,
          selectors,
          httpStatus,
        ));
      }

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
      if (result.ok) {
        this.readsSinceLaunch += 1;
        // Proactively recycle the browser after many reads: long-lived
        // Chrome processes accumulate memory (renderer heaps, GPU buffers)
        // and eventually get OOM-killed on consumer machines. Restarting
        // between reads is cheap (~1s) compared to a mid-batch crash.
        if (this.readsSinceLaunch >= CONTEXT_RECYCLE_AFTER_READS) {
          await this.closeContext();
        }
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

  /**
   * 可见模式下命中登录/验证/风控墙时，停在当前页轮询等待用户完成操作，
   * 直到正文出现或超过 interactiveWaitMs。返回刷新后的结果与快照，
   * 使当次任务在用户登录后即可成功，无需手动重试。
   */
  private async waitForInteractiveAccess(
    page: Page,
    selectors: SelectorConfig,
    httpStatus: number,
  ): Promise<{
    result: SourceReadResult;
    snapshot: Omit<PageSnapshot, "url" | "httpStatus">;
  }> {
    this.options.onInteractiveWait?.(
      "检测到知乎登录/验证墙，请在浏览器窗口中完成登录或验证，正在等待…",
    );
    const pollIntervalMs = 1_500;
    const deadline = Date.now() + this.interactiveWaitMs;
    let snapshot = await page.evaluate(extractInPage, selectors);
    let result = interpretPageSnapshot({
      ...snapshot,
      url: page.url(),
      httpStatus,
    });

    // 以 waitForSelector 的超时作为轮询节拍：正文未就绪时它自然等待一个
    // 周期；一旦正文出现且离开登录页，立即重新提取。用户完成登录/验证后
    // 当次任务即可成功，无需手动重试。
    while (
      !result.ok &&
      isInteractiveWaitCode(result.failure.code) &&
      Date.now() < deadline
    ) {
      const contentReady = await page
        .waitForSelector(CONTENT_WAIT_SELECTOR, { timeout: pollIntervalMs })
        .then(() => true)
        .catch(() => false);
      if (!contentReady || page.url().includes("/signin")) {
        continue; // waitForSelector 已等待一个周期。
      }

      await Promise.all(
        (selectors.metadataWaitSelectors ?? []).map((selector) =>
          page
            .waitForSelector(selector, { timeout: 3_000 })
            .catch(() => undefined),
        ),
      );
      snapshot = await page.evaluate(extractInPage, selectors);
      result = interpretPageSnapshot({
        ...snapshot,
        url: page.url(),
        httpStatus,
      });
      if (!result.ok && isInteractiveWaitCode(result.failure.code)) {
        // 正文已出现但仍判定受限/为空（罕见），稍作等待避免空转。
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
    return { result, snapshot };
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
      this.contextPromise = this.launchContextWithRetry(this.headlessActive);
      // A failed launch must not poison later retries.
      this.contextPromise.catch(() => {
        this.contextPromise = null;
      });
    }
    return this.contextPromise;
  }

  /**
   * Launch with up to 3 attempts. Between attempts, stale profile lock files
   * left behind by a crashed browser are removed so the next launch starts
   * from a clean state instead of entering a crash-recovery loop.
   */
  private async launchContextWithRetry(
    headless: boolean,
  ): Promise<BrowserContext> {
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const context = await this.launchContext(headless);
        this.readsSinceLaunch = 0;
        return context;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await this.cleanStaleProfileArtifacts();
          // Give the OS a moment to release file handles of the dead process.
          await new Promise((resolve) =>
            setTimeout(resolve, attempt * 1_500),
          );
        }
      }
    }
    throw lastError;
  }

  private async cleanStaleProfileArtifacts(): Promise<void> {
    try {
      await Promise.all(
        STALE_PROFILE_ARTIFACTS.map((name) =>
          rm(join(this.options.sessionDirectory, name), { force: true }),
        ),
      );
    } catch {
      // Best-effort: a cleanup failure must not block the retry itself.
    }
  }

  private launchContext(headless: boolean): Promise<BrowserContext> {
    if (this.options.launchPersistentContext) {
      return this.options.launchPersistentContext(headless);
    }
    const { sessionDirectory, channel, executablePath } = this.options;
    // Neither channel nor executablePath: fall through to Playwright's own
    // chromium (PLAYWRIGHT_BROWSERS_PATH or the default download cache).
    return chromium.launchPersistentContext(sessionDirectory, {
      ...(executablePath ? { executablePath } : channel ? { channel } : {}),
      headless,
      viewport: { width: 1280, height: 900 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args: [
        "--disable-blink-features=AutomationControlled",
        // Stability hardening: skip first-run dialogs, suppress the
        // "Chrome did not shut down correctly" crash bubble (which causes an
        // immediate exit in automated profiles), and reduce shared-memory
        // pressure that can OOM-kill the browser on low-RAM machines.
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
      ],
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
  "channel" | "executablePath" | "headless" | "minIntervalMs" | "interactiveWaitMs"
> {
  return {
    // Channel stays unset unless the operator pins one: resolveBrowserLaunch
    // owns the default chrome -> msedge -> bundled fallback chain.
    channel: environment.ZHIHU_BROWSER_CHANNEL?.trim() || undefined,
    executablePath:
      environment.ZHIHU_BROWSER_EXECUTABLE_PATH?.trim() || undefined,
    headless: environment.ZHIHU_BROWSER_HEADLESS?.trim()
      ? environment.ZHIHU_BROWSER_HEADLESS.trim() === "true"
      : true,
    minIntervalMs: Number(environment.ZHIHU_READ_MIN_INTERVAL_MS ?? 3_000),
    interactiveWaitMs: Number(
      environment.ZHIHU_READ_INTERACTIVE_WAIT_MS ?? 180_000,
    ),
  };
}

/**
 * Failure codes that may indicate a login/verification wall rather than a
 * permanent error. In visible mode these trigger the interactive wait so the
 * operator can complete authentication. CONTENT_EMPTY is included because a
 * fresh profile without cookies often gets a page where Zhihu simply does not
 * render the article body (no /signin redirect, just empty content selectors).
 */
function isInteractiveWaitCode(
  code: string,
): code is "SOURCE_ACCESS_RESTRICTED" | "CONTENT_EMPTY" {
  return code === "SOURCE_ACCESS_RESTRICTED" || code === "CONTENT_EMPTY";
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
