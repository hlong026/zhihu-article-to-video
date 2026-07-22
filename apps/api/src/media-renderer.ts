import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

import {
  buildFfmpegScrollCommand,
  buildFfmpegScrollOverlayCommand,
  buildFfmpegVideoCommand,
  writeZhihuReadingPagePngs,
  writeScrollPngs,
  writeSummaryPngCards,
  type FfmpegAudioOptions,
  type FfmpegCommand,
  type SourcePageMeta,
  type VideoSummary,
  type VideoTimingOptions,
} from "@zhihu-video/pipeline";

export type VideoMode = "slide" | "scroll";

export interface RenderVideoInput {
  outputDirectory: string;
  summary: VideoSummary;
  /** Verified Zhihu search phrase interpolated into the tail-page copy. */
  keyword: string;
  /** Optional background-music track mixed under the slideshow. */
  audio?: FfmpegAudioOptions;
  /** Timing options for slide mode (cover + body page durations). */
  timing?: VideoTimingOptions;
  /** Video mode: "slide" (default) or "scroll". */
  videoMode?: VideoMode;
  /** Scroll speed 1~5 (only for scroll mode, default 1). */
  scrollSpeed?: number;
  /** Reports per-card progress (done, total) while PNGs are rasterized. */
  onImageProgress?: (done: number, total: number) => void;
  /** Fires once every card is rendered and video encoding begins. */
  onVideoEncodingStart?: () => void;
  /** Resolved FFmpeg executable path; defaults to bare "ffmpeg" (PATH). */
  ffmpegExecutable?: string;
  /** Custom tail-page CTA template; {文章口令} is interpolated at render time. */
  tailTemplate?: string;
  /** Cleaned article paragraphs (required for scroll mode Zhihu-UI strip). */
  cleanedParagraphs?: string[];
  /** Page metadata for the Zhihu-UI scroll strip author block. */
  coverMeta?: SourcePageMeta | null;
  /** When true, scroll mode renders the full article without line cap. */
  fullContentOutput?: boolean;
}

export interface RenderedVideoAssets {
  imagePaths: string[];
  videoPath: string;
  durationSeconds: number;
}

export interface MediaRendererDependencies {
  writeCards?: typeof writeSummaryPngCards;
  executeFfmpeg?: (
    command: FfmpegCommand,
    executableOverride?: string,
  ) => Promise<void>;
}

/**
 * Produces the reviewable PNG sequence first, then encodes the matching MP4.
 * The injectable boundaries let task orchestration remain testable without a
 * host FFmpeg binary.
 */
export async function renderVideoAssets(
  input: RenderVideoInput,
  dependencies: MediaRendererDependencies = {},
): Promise<RenderedVideoAssets> {
  const imageDirectory = join(input.outputDirectory, "images");
  const videoPath = join(input.outputDirectory, "video.mp4");
  await mkdir(input.outputDirectory, { recursive: true });

  // Both reference modes use the same Zhihu reading-page artwork. The
  // horizontal reference changes pages with hard cuts; vertical mode moves a
  // viewport through the very same strip behind its fixed bottom bar.
  if (input.cleanedParagraphs?.length) {
    if (input.videoMode === "scroll") {
      return renderScrollOverlay(
        input,
        imageDirectory,
        videoPath,
        dependencies,
      );
    }
    return renderReadingPageSlides(
      input,
      imageDirectory,
      videoPath,
      dependencies,
    );
  }

  // ─── Slide mode (default): paginated cards ───────────────────────────────
  const writeCards = dependencies.writeCards ?? writeSummaryPngCards;
  const cards = await writeCards(
    imageDirectory,
    input.summary,
    input.keyword,
    input.onImageProgress,
    input.tailTemplate,
  );
  const cardModels = cards.map(({ card }) => card);
  const paths = cards.map(({ outputPath }) => outputPath);

  const command =
    input.videoMode === "scroll"
      ? buildFfmpegScrollCommand(
          cardModels,
          paths,
          videoPath,
          input.scrollSpeed ?? 1,
          input.audio,
        )
      : buildFfmpegVideoCommand(
          cardModels,
          paths,
          videoPath,
          input.audio,
          input.timing,
        );

  input.onVideoEncodingStart?.();
  await (dependencies.executeFfmpeg ?? executeFfmpeg)(
    command,
    input.ffmpegExecutable,
  );

  return {
    imagePaths: cards.map(({ outputPath }) => outputPath),
    videoPath,
    durationSeconds: command.durationSeconds,
  };
}

/**
 * Scroll-overlay path: renders the Zhihu-UI tall strip + bottom bar as PNGs,
 * then encodes a video with a fixed interaction bar overlaid at the bottom.
 */
async function renderScrollOverlay(
  input: RenderVideoInput,
  imageDirectory: string,
  videoPath: string,
  dependencies: MediaRendererDependencies,
): Promise<RenderedVideoAssets> {
  await mkdir(imageDirectory, { recursive: true });
  input.onImageProgress?.(0, 2);

  // 1+2. Render tall content strip + bottom bar as PNGs
  const barMeta = input.coverMeta ?? input.summary.coverMeta ?? null;
  const pngs = await writeScrollPngs(
    imageDirectory,
    {
      sourceTitle: input.summary.sourceTitle,
      paragraphs: input.cleanedParagraphs!,
      meta: barMeta,
      tags: input.summary.tags,
      fullContentOutput: input.fullContentOutput ?? false,
      tailNote: renderTailNote(input),
    },
    barMeta,
  );
  input.onImageProgress?.(2, 2);

  // 3. Encode video
  const command = buildFfmpegScrollOverlayCommand(
    pngs.stripPath,
    pngs.stripHeight,
    pngs.barPath,
    videoPath,
    input.scrollSpeed ?? 1,
    input.audio,
  );

  input.onVideoEncodingStart?.();
  await (dependencies.executeFfmpeg ?? executeFfmpeg)(
    command,
    input.ffmpegExecutable,
  );

  return {
    imagePaths: [pngs.stripPath, pngs.barPath],
    videoPath,
    durationSeconds: command.durationSeconds,
  };
}

/** Creates hard-cut reading-page screenshots matching the local reference. */
async function renderReadingPageSlides(
  input: RenderVideoInput,
  imageDirectory: string,
  videoPath: string,
  dependencies: MediaRendererDependencies,
): Promise<RenderedVideoAssets> {
  await mkdir(imageDirectory, { recursive: true });
  input.onImageProgress?.(0, 1);

  const barMeta = input.coverMeta ?? input.summary.coverMeta ?? null;
  const pngs = await writeZhihuReadingPagePngs(
    imageDirectory,
    {
      sourceTitle: input.summary.sourceTitle,
      paragraphs: input.cleanedParagraphs!,
      meta: barMeta,
      tags: input.summary.tags,
      fullContentOutput: input.fullContentOutput ?? false,
      tailNote: renderTailNote(input),
    },
    barMeta,
  );
  input.onImageProgress?.(pngs.pagePaths.length, pngs.pagePaths.length);

  const cards = pngs.pagePaths.map((_, index) => ({
    kind: index === 0 ? ("cover" as const) : ("body" as const),
  }));
  const command = buildFfmpegVideoCommand(
    cards,
    pngs.pagePaths,
    videoPath,
    input.audio,
    input.timing,
  );

  input.onVideoEncodingStart?.();
  await (dependencies.executeFfmpeg ?? executeFfmpeg)(
    command,
    input.ffmpegExecutable,
  );

  return {
    imagePaths: pngs.pagePaths,
    videoPath,
    durationSeconds: command.durationSeconds,
  };
}

function renderTailNote(
  input: Pick<RenderVideoInput, "keyword" | "tailTemplate">,
): string {
  const template = input.tailTemplate ?? "来知乎搜索🔍{文章口令}可以看到全文";
  return template.replaceAll("{文章口令}", input.keyword.trim());
}

export async function executeFfmpeg(
  command: FfmpegCommand,
  executableOverride?: string,
): Promise<void> {
  // Dynamic timeout: 3× the expected video duration (encoding overhead),
  // with a floor of 2 minutes for short clips and a ceiling of 15 minutes.
  const timeoutMs = Math.min(
    15 * 60 * 1000,
    Math.max(2 * 60 * 1000, command.durationSeconds * 3 * 1000),
  );
  await new Promise<void>((resolve, reject) => {
    const process = spawn(
      executableOverride ?? command.executable,
      command.args,
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      reject(new Error(`FFmpeg 超时：${basename(command.args.at(-1) ?? "")}`));
    }, timeoutMs);

    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    process.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg 执行失败（${code ?? "未知"}）：${stderr}`));
    });
  });
}
