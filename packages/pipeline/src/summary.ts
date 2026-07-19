import {
  countBodyCharacters,
  defaultPagination,
  measureBodyLayout,
} from "./pagination.js";
import type { SourcePageMeta } from "./source.js";

/** Kept structurally compatible with @zhihu-video/contracts for API handoff. */
export interface SummaryPage {
  body: string;
  sourceRefs: number[];
}

/** Kept structurally compatible with @zhihu-video/contracts for API handoff. */
export interface VideoSummary {
  sourceTitle: string;
  videoTitle: string;
  tags: string[];
  pages: SummaryPage[];
  /** True when the article overflowed 10 pages and a search-keyword tail is shown. */
  truncated: boolean;
  riskFlags: string[];
  /**
   * Zhihu question-header metadata rendered on the cover (author block and
   * counters). Absent for manually supplied content or older snapshots, in
   * which case the cover falls back to the tags-only layout.
   */
  coverMeta?: SourcePageMeta | null;
}

export interface SummaryValidationOptions {
  hasVerifiedKeyword: boolean;
}

export type SummaryIssueCode =
  | "INVALID_SHAPE"
  | "TOO_FEW_PAGES"
  | "TOO_MANY_PAGES"
  | "TITLE_TOO_LONG"
  | "INVALID_TAG_COUNT"
  | "CARD_BODY_TOO_SHORT"
  | "CARD_BODY_TOO_LONG"
  | "MISSING_SOURCE_REFERENCE"
  | "KEYWORD_UNVERIFIED";

export interface SummaryIssue {
  code: SummaryIssueCode;
  message: string;
  pageIndex?: number;
}

export interface SummaryValidationResult {
  status: "ready" | "needs_review";
  issues: SummaryIssue[];
}

export const videoTitleMaxLength = 22;
export const bodyPageMaxCount = 10;
export const bodyPageMinCharacters = 38;
/**
 * 整页宽字符（CJK）容量：18 字 × 18 行。保留作参考常量；实际门禁按行数判定
 * （见 bodyPageMaxLines），因为窄字符（ASCII）每格可排两个，纯字符数会对其误报。
 */
export const bodyPageMaxCharacters = 324;
/** 单页最大行数，与分页器 linesPerPage 一致：超出即排不下单张卡片。 */
export const bodyPageMaxLines = defaultPagination.linesPerPage;

/**
 * The AI only produces the video title and tags; body pages come straight
 * from the paginated article text, so no summary schema is needed anymore.
 */
export const titleAndTagsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["videoTitle", "tags"],
  properties: {
    videoTitle: { type: "string", maxLength: videoTitleMaxLength },
    tags: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: { type: "string" },
    },
  },
} as const;

/** A replaceable provider boundary for OpenAI-compatible structured output. */
export interface SummaryGenerator {
  summarize(input: {
    sourceTitle: string;
    paragraphs: string[];
  }): Promise<unknown>;
}

export interface TitleAndTags {
  videoTitle: string;
  tags: string[];
}

/** Parses the AI title/tags payload without trusting its shape. */
export function parseTitleAndTags(value: unknown): TitleAndTags | null {
  if (!isRecord(value)) return null;
  if (typeof value.videoTitle !== "string" || !isStringArray(value.tags)) {
    return null;
  }
  const videoTitle = value.videoTitle.trim();
  if (!videoTitle) return null;
  return { videoTitle, tags: value.tags.map((tag) => tag.trim()) };
}

/** Titles longer than the cover budget are truncated with an ellipsis. */
export function truncateVideoTitle(title: string): string {
  const characters = Array.from(title.trim());
  if (characters.length <= videoTitleMaxLength) return characters.join("");
  return `${characters.slice(0, videoTitleMaxLength - 1).join("")}…`;
}

export function isVideoSummary(value: unknown): value is VideoSummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.sourceTitle === "string" &&
    typeof value.videoTitle === "string" &&
    isStringArray(value.tags) &&
    Array.isArray(value.pages) &&
    value.pages.every(isSummaryPage) &&
    typeof value.truncated === "boolean" &&
    isStringArray(value.riskFlags) &&
    (value.coverMeta === undefined ||
      value.coverMeta === null ||
      isSourcePageMeta(value.coverMeta))
  );
}

export function validateVideoSummary(
  value: unknown,
  options: SummaryValidationOptions,
): SummaryValidationResult {
  if (!isVideoSummary(value)) {
    return {
      status: "needs_review",
      issues: [
        { code: "INVALID_SHAPE", message: "视频内容不符合卡片结构。" },
      ],
    };
  }

  const issues: SummaryIssue[] = [];
  if (value.pages.length < 1) {
    issues.push({
      code: "TOO_FEW_PAGES",
      message: "正文至少需要 1 页内容。",
    });
  }
  if (value.pages.length > bodyPageMaxCount) {
    issues.push({
      code: "TOO_MANY_PAGES",
      message: "正文超过 10 页，需要截取前 10 页。",
    });
  }
  if (
    value.videoTitle.length === 0 ||
    value.videoTitle.length > videoTitleMaxLength
  ) {
    issues.push({
      code: "TITLE_TOO_LONG",
      message: "视频标题不能为空且不能超过 22 个字符。",
    });
  }
  if (
    value.tags.length > 5 ||
    value.tags.some((tag) => tag.trim().length === 0)
  ) {
    issues.push({
      code: "INVALID_TAG_COUNT",
      message: "标签最多 5 个且不能为空。",
    });
  }

  const lastPageIndex = value.pages.length - 1;
  value.pages.forEach((page, pageIndex) => {
    const bodyLength = countBodyCharacters(page.body);
    // The final page may legitimately be short (user rule: output as-is).
    if (pageIndex !== lastPageIndex && bodyLength <= bodyPageMinCharacters) {
      issues.push({
        code: "CARD_BODY_TOO_SHORT",
        message: "卡片正文必须大于 38 个字符。",
        pageIndex,
      });
    }
    if (measureBodyLayout(page.body).lineCount > bodyPageMaxLines) {
      issues.push({
        code: "CARD_BODY_TOO_LONG",
        message: "卡片正文超出单页排版容量。",
        pageIndex,
      });
    }
    if (
      page.sourceRefs.length === 0 ||
      page.sourceRefs.some(
        (reference) => !Number.isInteger(reference) || reference < 1,
      )
    ) {
      issues.push({
        code: "MISSING_SOURCE_REFERENCE",
        message: "每张正文卡片都必须关联至少一个原文段落。",
        pageIndex,
      });
    }
  });

  if (!options.hasVerifiedKeyword) {
    issues.push({
      code: "KEYWORD_UNVERIFIED",
      message: "文章口令尚未人工确认，不能自动进入渲染。",
    });
  }

  return { status: issues.length === 0 ? "ready" : "needs_review", issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isSummaryPage(value: unknown): value is SummaryPage {
  return (
    isRecord(value) &&
    typeof value.body === "string" &&
    Array.isArray(value.sourceRefs) &&
    value.sourceRefs.every((item) => typeof item === "number")
  );
}

function isSourcePageMeta(value: unknown): value is SourcePageMeta {
  if (!isRecord(value)) return false;
  const fields = [
    "authorName",
    "authorBadge",
    "answerCount",
    "followCount",
    "avatarDataUri",
  ] as const;
  return fields.every(
    (field) => value[field] === null || typeof value[field] === "string",
  );
}
