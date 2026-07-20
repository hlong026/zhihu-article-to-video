export const taskStatuses = [
  "pending",
  "fetching",
  "summarizing",
  "rendering_images",
  "rendering_video",
  "completed",
  "failed",
  "needs_review",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export type SourceType = "answer" | "article";

/** Manually pasted article content used when the source page is unreachable. */
export interface ManualArticleContent {
  title: string;
  paragraphs: string[];
}

export interface BatchSummary {
  id: string;
  sourceFileName: string;
  totalCount: number;
  completedCount: number;
  needsReviewCount: number;
  failedCount: number;
  createdAt: string;
}

export interface ArticleTask {
  id: string;
  batchId: string;
  sourceUrl: string;
  sourceType: SourceType;
  inputTitle: string | null;
  fetchedTitle: string | null;
  articleKeyword: string | null;
  manualContent: ManualArticleContent | null;
  finalTitle: string | null;
  finalTags: string[];
  tailNote: string;
  /** Editable template for the tail page CTA; {文章口令} is interpolated at render time. */
  tailNoteTemplate: string;
  status: TaskStatus;
  step: TaskStatus;
  progress: number;
  failureCode: string | null;
  failureMessage: string | null;
  updatedAt: string;
}

/** One entry of the per-task step/attempt log returned by the task detail API. */
export interface TaskAttemptLog {
  id: string;
  attemptNumber: number;
  step: string;
  status: string;
  message: string | null;
  createdAt: string;
}

/** Read-model of a task's rendered artifacts, computed from the output dir. */
export interface TaskArtifactsSummary {
  imageCount: number;
  videoReady: boolean;
  /** Cover 1s + body pages at the configured dwell time + tail 2s. */
  durationSeconds: number;
}

/** Task detail endpoint payload: the task plus its log and artifact summary. */
export interface ArticleTaskDetail extends ArticleTask {
  attempts: TaskAttemptLog[];
  artifacts: TaskArtifactsSummary | null;
}

/** Batch detail endpoint payload, including rows skipped at import time. */
export interface BatchDetailView extends BatchSummary {
  status: string;
  tasks: ArticleTask[];
  importErrors: Array<{
    rowNumber: number;
    code: string;
    message: string;
  }>;
}

/** Dry-run import report used by the row-range picker before importing. */
export interface ImportPreview {
  totalDataRows: number;
  validCount: number;
  errorCount: number;
  sample: Array<{
    rowNumber: number;
    sourceUrl: string;
    inputTitle: string | null;
    hasKeyword: boolean;
  }>;
}

export interface SummaryPage {
  body: string;
  sourceRefs: number[];
}

/**
 * Zhihu question-header metadata rendered on the cover card (author block
 * and counters). Counts keep their original display text (e.g. "433" or
 * "1.2万"); every field degrades to null when the page layout lacks it.
 */
export interface CoverPageMeta {
  authorName: string | null;
  authorBadge: string | null;
  answerCount: string | null;
  followCount: string | null;
  /** Ready-to-embed data URI of the author's avatar image, when downloaded. */
  avatarDataUri: string | null;
}

export interface VideoSummary {
  sourceTitle: string;
  videoTitle: string;
  tags: string[];
  pages: SummaryPage[];
  /** True when the article overflowed 10 pages and a search-keyword tail is shown. */
  truncated: boolean;
  riskFlags: string[];
  /** Absent for manual content or older snapshots; the cover then keeps its tags-only layout. */
  coverMeta?: CoverPageMeta | null;
}

/** Where the operator's background-music track comes from. */
export type BgmSource = "preset" | "upload";

/** A built-in, license-free background-music track shipped with the app. */
export interface BgmPreset {
  id: string;
  name: string;
}

/**
 * Global background-music configuration applied to every video rendered after
 * it is saved. There is a single row of this for the whole app (single
 * operator, no per-batch configuration).
 */
export interface BgmSettings {
  enabled: boolean;
  source: BgmSource | null;
  /** Set when `source === "preset"`. */
  presetId: string | null;
  /** Display label: the preset name or the uploaded file's original name. */
  fileName: string | null;
  /** Playback volume factor, 0 (silent) to 1 (original loudness). */
  volume: number;
  /** Length of the trailing fade-out, in seconds. */
  fadeOutSeconds: number;
}

/** Settings plus the read-only data the workbench needs to render its UI. */
export interface BgmSettingsView extends BgmSettings {
  presets: BgmPreset[];
  /** True when a usable audio file is resolved for the current selection. */
  hasAudio: boolean;
}

/** Concurrency presets offered in the workbench processing card. */
export const processingConcurrencyOptions = [5, 10, 15, 20] as const;

/** Body-page dwell-time presets (seconds) offered in the workbench card. */
export const bodyPageDurationOptions = [1, 1.5, 2, 2.5, 3] as const;

/**
 * Global batch-processing configuration (single operator, one row). The
 * Zhihu reader always stays serial to respect rate limits; concurrency only
 * widens AI calls and media rendering.
 */
export interface ProcessingSettings {
  concurrency: number;
  /** Seconds each body page stays on screen (cover 1s / tail 2s are fixed). */
  bodyPageDurationSeconds: number;
  /** When true, body pagination is uncapped: the full article is rendered. */
  fullContentOutput: boolean;
}

/**
 * AI model configuration persisted in the local database. When a field is
 * null the runtime falls back to the corresponding environment variable
 * (AI_API_KEY / AI_BASE_URL / AI_MODEL) or the built-in default.
 */
export interface AiSettings {
  /** OpenAI-compatible API key. Required for AI summarization. */
  apiKey: string | null;
  /** Base URL of the OpenAI-compatible endpoint (no trailing slash). */
  baseUrl: string | null;
  /** Model identifier sent in the chat-completions request. */
  model: string | null;
}

/** AiSettings plus resolved read-only fields for the settings UI. */
export interface AiSettingsView extends AiSettings {
  /** The effective base URL after env/default fallback. */
  effectiveBaseUrl: string;
  /** The effective model after env/default fallback. */
  effectiveModel: string;
  /** True when an API key is available (from DB or env). */
  configured: boolean;
}
