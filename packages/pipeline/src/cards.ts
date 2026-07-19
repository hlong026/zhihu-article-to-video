import type { SourcePageMeta } from "./source.js";
import type { VideoSummary } from "./summary.js";

export const cardCanvas = { width: 1080, height: 1920 } as const;

export type CardKind = "cover" | "body" | "tail";

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
  /** First lines of the article body, shown under the title like Zhihu's card. */
  preview: string[];
  /**
   * Question-header metadata (author block + counters) rendered between the
   * meta line and the preview; null keeps the legacy tags-only cover.
   */
  meta: SourcePageMeta | null;
}

export interface BodyCardRenderModel extends BaseCardRenderModel {
  kind: "body";
  body: string;
  sourceRefs: number[];
}

export interface TailCardRenderModel extends BaseCardRenderModel {
  kind: "tail";
  keyword: string;
  /** Drives the lead copy: truncated shows "以上为节选", complete shows "全文完". */
  truncated: boolean;
}

export type CardRenderModel =
  CoverCardRenderModel | BodyCardRenderModel | TailCardRenderModel;

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
 * The tail (search-keyword CTA) is mandatory on every video so viewers can
 * always find the source on Zhihu. `summary.truncated` only varies the tail's
 * lead copy so a fully shown article never claims to be an excerpt.
 */
export function buildCardSequence(
  summary: VideoSummary,
  keyword: string,
): CardRenderModel[] {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) {
    throw new Error("文章口令不能为空，不能渲染尾页。");
  }

  const totalPages = summary.pages.length + 2;
  // The cover echoes the article's opening lines (like a Zhihu card) so it is
  // not a near-empty title screen; the body pages then continue the read.
  const previewLines = (summary.pages[0]?.body.split("\n") ?? [])
    .filter((line) => line !== "")
    .slice(0, 6);
  const cover: CoverCardRenderModel = {
    kind: "cover",
    canvas: cardCanvas,
    pageNumber: 1,
    totalPages,
    sourceLabel: "知乎",
    title: summary.videoTitle,
    tags: summary.tags,
    preview: previewLines,
    meta: summary.coverMeta ?? null,
    text: summary.videoTitle,
  };
  const bodyCards: BodyCardRenderModel[] = summary.pages.map((page, index) => ({
    kind: "body",
    canvas: cardCanvas,
    pageNumber: index + 2,
    totalPages,
    body: page.body,
    sourceRefs: page.sourceRefs,
    text: page.body,
  }));
  const tail: TailCardRenderModel = {
    kind: "tail",
    canvas: cardCanvas,
    pageNumber: totalPages,
    totalPages,
    keyword: normalizedKeyword,
    truncated: summary.truncated,
    text: summary.truncated
      ? `来知乎搜索「${normalizedKeyword}」看全文`
      : `来知乎搜索「${normalizedKeyword}」看更多`,
  };

  return [cover, ...bodyCards, tail];
}
