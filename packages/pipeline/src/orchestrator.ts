import { buildCardSequence, type CardRenderModel } from "./cards.js";
import { paginateParagraphs } from "./pagination.js";
import {
  classifyZhihuUrl,
  cleanReadableContent,
  type RawReadableContent,
  type SourceReadFailure,
  type ZhihuContentReader,
  type ZhihuSourceType,
} from "./source.js";
import {
  parseTitleAndTags,
  truncateVideoTitle,
  validateVideoSummary,
  type SummaryGenerator,
  type SummaryIssue,
  type VideoSummary,
} from "./summary.js";

export interface VideoPreparationInput {
  sourceUrl: string;
  sourceType: ZhihuSourceType;
  articleKeyword: string | null;
  /**
   * Manually supplied article content. When present, the reader is skipped
   * entirely so a task can recover from access restrictions without another
   * network fetch.
   */
  manualContent?: RawReadableContent | null;
  /** Directory where the reader may persist the raw page snapshot. */
  snapshotDir?: string;
}

export interface VideoPreparationDependencies {
  reader: ZhihuContentReader;
  generator: SummaryGenerator;
}

export type VideoPreparationResult =
  | {
      kind: "ready";
      sourceTitle: string;
      summary: VideoSummary;
      cards: CardRenderModel[];
      cleanedParagraphs: string[];
      snapshotPath?: string;
    }
  | { kind: "needs_review"; issues: SummaryIssue[] }
  | { kind: "failed"; failure: SourceReadFailure };

/**
 * This is the only place that decides whether an article is ready to render.
 * It keeps access failures, model failures and render input separate so callers
 * can persist a truthful task state instead of emitting a partial video.
 */
export async function buildPreparedVideo(
  input: VideoPreparationInput,
  dependencies: VideoPreparationDependencies,
): Promise<VideoPreparationResult> {
  const classified = classifyZhihuUrl(input.sourceUrl);
  if (
    !classified.sourceType ||
    !classified.canonicalUrl ||
    classified.sourceType !== input.sourceType
  ) {
    return {
      kind: "failed",
      failure: {
        code: "SOURCE_LAYOUT_CHANGED",
        message: "文章链接格式与任务来源不一致。",
      },
    };
  }

  let content: ReturnType<typeof cleanReadableContent>;
  let snapshotPath: string | undefined;
  if (input.manualContent && input.manualContent.paragraphs.length > 0) {
    content = cleanReadableContent(input.manualContent);
  } else {
    const readResult = await dependencies.reader.read({
      sourceType: classified.sourceType,
      canonicalUrl: classified.canonicalUrl,
      snapshotDir: input.snapshotDir,
    });
    if (!readResult.ok) {
      return { kind: "failed", failure: readResult.failure };
    }
    snapshotPath = readResult.snapshotPath;
    content = cleanReadableContent(readResult.content);
  }
  if (!content.title || content.paragraphs.length === 0) {
    return {
      kind: "failed",
      failure: {
        code: "CONTENT_EMPTY",
        message: "文章未提取到可用于生成视频的正文。",
      },
    };
  }

  // Body pages come straight from the article text; the AI only produces
  // the video title and tags. AI failures fall back to the source title so
  // a flaky model never blocks an otherwise renderable task.
  const { pages, truncated } = paginateParagraphs(content.paragraphs);
  const riskFlags: string[] = [];
  let videoTitle: string;
  let tags: string[];
  try {
    const modelOutput = await dependencies.generator.summarize({
      sourceTitle: content.title,
      paragraphs: content.paragraphs,
    });
    const parsed = parseTitleAndTags(modelOutput);
    if (parsed) {
      videoTitle = truncateVideoTitle(parsed.videoTitle);
      tags = parsed.tags.filter((tag) => tag.length > 0).slice(0, 5);
    } else {
      riskFlags.push("AI_TITLE_INVALID");
      videoTitle = truncateVideoTitle(content.title);
      tags = [];
    }
  } catch {
    riskFlags.push("AI_TITLE_FALLBACK");
    videoTitle = truncateVideoTitle(content.title);
    tags = [];
  }

  const summary: VideoSummary = {
    sourceTitle: content.title,
    videoTitle,
    tags,
    pages,
    truncated,
    riskFlags,
    // Manual content has no page metadata; the cover then keeps its
    // tags-only fallback layout.
    coverMeta: content.meta ?? null,
  };
  const validation = validateVideoSummary(summary, {
    hasVerifiedKeyword: Boolean(input.articleKeyword?.trim()),
  });
  if (validation.status === "needs_review") {
    return { kind: "needs_review", issues: validation.issues };
  }

  return {
    kind: "ready",
    sourceTitle: content.title,
    summary,
    cards: buildCardSequence(summary, input.articleKeyword!.trim()),
    cleanedParagraphs: content.paragraphs,
    snapshotPath,
  };
}
