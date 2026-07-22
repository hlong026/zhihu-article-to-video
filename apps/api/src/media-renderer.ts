import { mkdir, writeFile } from "node:fs/promises";
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
  type ScrollOverlayTimingOptions,
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
  /** Slide timing; for scroll it controls the initial and ending dwell. */
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
  /** When true, scroll mode uses its extended (safety-capped) article output. */
  fullContentOutput?: boolean;
}

export interface RenderedVideoAssets {
  imagePaths: string[];
  videoPath: string;
  durationSeconds: number;
}

const renderManifestFileName = "render-manifest.json";
let extendedScrollRenderQueue: Promise<void> = Promise.resolve();

interface RenderManifest {
  version: 1;
  /** Duration passed to FFmpeg's `-t`; it is the encoded MP4 duration. */
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
      const render = () => renderScrollOverlay(
        input,
        imageDirectory,
        videoPath,
        dependencies,
      );
      return input.fullContentOutput
        ? withExtendedScrollRenderSlot(render)
        : render();
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

  const assets = {
    imagePaths: cards.map(({ outputPath }) => outputPath),
    videoPath,
    durationSeconds: command.durationSeconds,
  };
  await writeRenderManifest(input.outputDirectory, assets.durationSeconds);
  return assets;
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
    scrollOverlayTiming(input.timing),
  );

  input.onVideoEncodingStart?.();
  await (dependencies.executeFfmpeg ?? executeFfmpeg)(
    command,
    input.ffmpegExecutable,
  );

  const assets = {
    imagePaths: [pngs.stripPath, pngs.barPath],
    videoPath,
    durationSeconds: command.durationSeconds,
  };
  await writeRenderManifest(input.outputDirectory, assets.durationSeconds);
  return assets;
}

/**
 * Full-content scrolls rasterize very tall PNGs and can encode for minutes.
 * Serialize only that expensive media phase; fetching and AI preparation keep
 * the batch's configured concurrency.
 */
async function withExtendedScrollRenderSlot<T>(
  work: () => Promise<T>,
): Promise<T> {
  const previous = extendedScrollRenderQueue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  extendedScrollRenderQueue = previous.then(() => current);
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * Reuses the existing timing settings for the scroll experience: cover dwell
 * lets readers orient before movement, while body dwell becomes the terminal
 * hold so the CTA cannot flash by. Omit the object to retain pipeline defaults.
 */
function scrollOverlayTiming(
  timing: VideoTimingOptions | undefined,
): ScrollOverlayTimingOptions | undefined {
  if (!timing) return undefined;
  return {
    startDwellSeconds: timing.coverPageDurationSeconds,
    endDwellSeconds: timing.bodyPageDurationSeconds,
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

  const assets = {
    imagePaths: pngs.pagePaths,
    videoPath,
    durationSeconds: command.durationSeconds,
  };
  await writeRenderManifest(input.outputDirectory, assets.durationSeconds);
  return assets;
}

/**
 * Stores render-time facts next to the media rather than reconstructing them
 * from PNG count. Scroll videos always have two PNGs regardless of duration.
 */
async function writeRenderManifest(
  outputDirectory: string,
  durationSeconds: number,
): Promise<void> {
  const manifest: RenderManifest = { version: 1, durationSeconds };
  await writeFile(
    join(outputDirectory, renderManifestFileName),
    `${JSON.stringify(manifest)}\n`,
    "utf8",
  );
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
  // with a floor of 2 minutes for short clips and a ceiling of 60 minutes.
  const timeoutMs = Math.min(
    60 * 60 * 1000,
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
