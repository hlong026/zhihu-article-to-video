import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

import {
  buildFfmpegScrollCommand,
  buildFfmpegVideoCommand,
  writeSummaryPngCards,
  type FfmpegAudioOptions,
  type FfmpegCommand,
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
  /** Scroll speed 1~5 (only for scroll mode, default 3). */
  scrollSpeed?: number;
  /** Reports per-card progress (done, total) while PNGs are rasterized. */
  onImageProgress?: (done: number, total: number) => void;
  /** Fires once every card is rendered and video encoding begins. */
  onVideoEncodingStart?: () => void;
  /** Resolved FFmpeg executable path; defaults to bare "ffmpeg" (PATH). */
  ffmpegExecutable?: string;
  /** Custom tail-page CTA template; {文章口令} is interpolated at render time. */
  tailTemplate?: string;
}

export interface RenderedVideoAssets {
  imagePaths: string[];
  videoPath: string;
  durationSeconds: number;
}

export interface MediaRendererDependencies {
  writeCards?: typeof writeSummaryPngCards;
  executeFfmpeg?: (command: FfmpegCommand, executableOverride?: string) => Promise<void>;
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
          input.scrollSpeed ?? 3,
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
  await (dependencies.executeFfmpeg ?? executeFfmpeg)(command, input.ffmpegExecutable);

  return {
    imagePaths: cards.map(({ outputPath }) => outputPath),
    videoPath,
    durationSeconds: command.durationSeconds,
  };
}

export async function executeFfmpeg(
  command: FfmpegCommand,
  executableOverride?: string,
): Promise<void> {
  const timeoutMs = 2 * 60 * 1000;
  await new Promise<void>((resolve, reject) => {
    const process = spawn(executableOverride ?? command.executable, command.args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
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
