import type { SourcePageMeta } from "./source.js";
import type { VideoSummary } from "./summary.js";

export const cardCanvas = { width: 1080, height: 1920 } as const;

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
}

export interface BodyCardRenderModel extends BaseCardRenderModel {
  kind: "body";
  body: string;
  sourceRefs: number[];
  /** CTA overlay text rendered centered on the last body card (yellow, bold). */
  ctaOverlay?: string;
}

export type CardRenderModel = CoverCardRenderModel | BodyCardRenderModel;

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
 * The CTA (search-keyword引流) is overlaid on the last body card so viewers can
 * always find the source on Zhihu without a separate tail page.
 * `summary.truncated` only varies the CTA copy.
 */
export function buildCardSequence(
  summary: VideoSummary,
  keyword: string,
  tailTemplate?: string,
): CardRenderModel[] {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    throw new Error("文章口令不能为空，不能渲染引流文字。");
  }

  const totalPages = summary.pages.length + 1; // cover + body pages (no separate tail)
  // The cover is a pure title card: original question/article title plus
  // source metadata. Body text starts on page 2 so nothing on the cover is
  // ever repeated by the first body card.
  const cover: CoverCardRenderModel = {
    kind: "cover",
    canvas: cardCanvas,
    pageNumber: 1,
    totalPages,
    sourceLabel: "知乎",
    title: summary.sourceTitle,
    tags: summary.tags,
    meta: summary.coverMeta ?? null,
    text: summary.sourceTitle,
  };
  const ctaText = tailTemplate
    ? tailTemplate.replaceAll("{文章口令}", normalizedKeyword)
    : summary.truncated
      ? `来知乎搜索「${normalizedKeyword}」看全文`
      : `来知乎搜索「${normalizedKeyword}」看更多`;
  const bodyCards: BodyCardRenderModel[] = summary.pages.map((page, index) => ({
    kind: "body",
    canvas: cardCanvas,
    pageNumber: index + 2,
    totalPages,
    body: page.body,
    sourceRefs: page.sourceRefs,
    text: page.body,
    // Overlay CTA on the last body card
    ...(index === summary.pages.length - 1 ? { ctaOverlay: ctaText } : {}),
  }));

  return [cover, ...bodyCards];
}
