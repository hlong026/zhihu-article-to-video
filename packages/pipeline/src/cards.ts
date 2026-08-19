import type { SourcePageMeta } from "./source.js";
import type { VideoSummary } from "./summary.js";

export const cardCanvas = { width: 1080, height: 1920 } as const;

/** Supported export aspect ratios with their heights (width is fixed at 1080). */
export const cardHeights = {
  "9:16": 1920,
  "3:4": 1440,
} as const;

export type CardHeight = (typeof cardHeights)[keyof typeof cardHeights];

export type CardKind = "cover" | "body";

export interface BaseCardRenderModel {
  kind: CardKind;
  canvas: typeof cardCanvas;
  pageNumber: number;
  totalPages: number;
  text: string;
}

export interface CoverCardRenderModel extends BaseCardRenderModel {
  kind: "cover";
  sourceLabel: "知乎";
  title: string;
  tags: string[];
  /**
   * Question-header metadata (author block + counters) rendered in the cover
   * footer; null renders the tags chips fallback instead.
   */
  meta: SourcePageMeta | null;
  /** Optional render options passed from download API (height, hide buttons). */
  opts?: CardRenderOptions;
}

export interface BodyCardRenderModel extends BaseCardRenderModel {
  kind: "body";
  body: string;
  sourceRefs: number[];
  /** CTA overlay text rendered centered on the last body card (yellow, bold). */
  ctaOverlay?: string;
  /** Optional render options passed from download API (height, hide buttons). */
  opts?: CardRenderOptions;
}

export type CardRenderModel = CoverCardRenderModel | BodyCardRenderModel;

/** Options for building a card sequence at a custom height. */
export interface CardRenderOptions {
  /** Image height (width is fixed at 1080). Default: 1920 (9:16). */
  height?: number;
  /** Hide decorative interaction buttons (+关注/点赞 icons) across all cards.
   * Author info (avatar/name/badge) remains visible. */
  hideInteractionButtons?: boolean;
}

/**
 * The API supplies the Playwright screenshot implementation. Keeping the
 * renderer outside this package makes image generation testable without a browser.
 */
export interface CardImageRenderer {
  render(
    card: CardRenderModel,
    outputPath: string,
  ): Promise<{ imagePath: string }>;
}

/**
 * The CTA (search-keyword 引流) is overlaid on the last body card so viewers can
 * always find the source on Zhihu without a separate tail page.
 * `summary.truncated` only varies the CTA copy.
 */
export function buildCardSequence(
  summary: VideoSummary,
  keyword: string,
  tailTemplate?: string,
): CardRenderModel[];

/**
 * Build a card sequence with configurable aspect ratio and button visibility.
 */
export function buildCardSequence(
  summary: VideoSummary,
  keyword: string,
  options?: CardRenderOptions | string, // allow legacy tailTemplate arg
  tailTemplate?: string,
): CardRenderModel[];

export function buildCardSequence(
  summary: VideoSummary,
  keyword: string,
  options?: CardRenderOptions | string, // allow legacy tailTemplate arg
  tailTemplate?: string,
): CardRenderModel[] {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    throw new Error("文章口令不能为空，不能渲染引流文字。");
  }

  // Backward-compatibility: allow string as third argument (legacy tailTemplate)
  const opts: CardRenderOptions | undefined =
    typeof options === "string"
      ? { height: undefined, hideInteractionButtons: false }
      : (options ?? undefined);
  const _tailTemplate = typeof options === "string" ? options : tailTemplate;

  const canvasHeight = opts?.height ?? cardCanvas.height;
  const totalPages = summary.pages.length + 1; // cover + body pages (no separate tail)

  // The cover is a pure title card: original question/article title plus
  // source metadata. Body text starts on page 2 so nothing on the cover is
  // ever repeated by the first body card.
  const cover: CoverCardRenderModel = {
    kind: "cover",
    canvas: { width: 1080, height: canvasHeight } as typeof cardCanvas,
    pageNumber: 1,
    totalPages,
    sourceLabel: "知乎",
    title: summary.sourceTitle,
    tags: summary.tags,
    meta: summary.coverMeta ?? null,
    text: summary.sourceTitle,
    opts,
  };

  const ctaText = _tailTemplate
    ? _tailTemplate.replaceAll("{文章口令}", normalizedKeyword)
    : summary.truncated
      ? `来知乎搜索「${normalizedKeyword}」看全文`
      : `来知乎搜索「${normalizedKeyword}」看更多`;

  const bodyCards: BodyCardRenderModel[] = summary.pages.map((page, index) => ({
    kind: "body",
    canvas: { width: 1080, height: canvasHeight } as typeof cardCanvas,
    pageNumber: index + 2,
    totalPages,
    body: page.body,
    sourceRefs: page.sourceRefs,
    text: page.body,
    // Overlay CTA on the last body card
    ...(index === summary.pages.length - 1 ? { ctaOverlay: ctaText } : {}),
    opts,
  }));

  return [cover, ...bodyCards];
}
