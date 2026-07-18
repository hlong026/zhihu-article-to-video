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
  status: TaskStatus;
  step: TaskStatus;
  progress: number;
  failureCode: string | null;
  failureMessage: string | null;
  updatedAt: string;
}

export interface SummaryPage {
  body: string;
  sourceRefs: number[];
}

export interface VideoSummary {
  sourceTitle: string;
  videoTitle: string;
  tags: string[];
  pages: SummaryPage[];
  /** True when the article overflowed 10 pages and a search-keyword tail is shown. */
  truncated: boolean;
  riskFlags: string[];
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
