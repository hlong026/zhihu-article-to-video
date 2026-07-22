import type { CardKind, CardRenderModel } from "./cards.js";

export interface FfmpegCommand {
  executable: "ffmpeg";
  args: string[];
  durationSeconds: number;
}

/** The host app owns process execution, error logging, timeouts, and retries. */
export interface FfmpegExecutor {
  execute(command: FfmpegCommand): Promise<void>;
}

/**
 * Optional background-music track mixed under the still-image slideshow. The
 * host resolves the on-disk path; this module stays free of filesystem access.
 */
export interface FfmpegAudioOptions {
  path: string;
  /** Volume factor 0..1, defaults to a subdued 0.3 so narration is unaffected. */
  volume?: number;
  /** Trailing fade-out length in seconds, defaults to 1. */
  fadeOutSeconds?: number;
}

export interface VideoTimingOptions {
  /** Seconds the cover stays on screen (default 1). */
  coverPageDurationSeconds?: number;
  /** Seconds each body page stays on screen (default 3). */
  bodyPageDurationSeconds?: number;
}

function clampVolume(volume: number | undefined): number {
  if (volume === undefined || Number.isNaN(volume)) return 0.3;
  return Math.min(1, Math.max(0, volume));
}

export function durationForCard(
  kind: CardKind,
  timing?: VideoTimingOptions,
): number {
  if (kind === "cover") {
    const custom = timing?.coverPageDurationSeconds ?? 1;
    return Number.isFinite(custom) && custom > 0 ? custom : 1;
  }
  const custom = timing?.bodyPageDurationSeconds ?? 3;
  return Number.isFinite(custom) && custom > 0 ? custom : 3;
}

export function totalVideoDuration(
  cards: readonly Pick<CardRenderModel, "kind">[],
  timing?: VideoTimingOptions,
): number {
  return cards.reduce(
    (total, card) => total + durationForCard(card.kind, timing),
    0,
  );
}

/**
 * Builds the FFmpeg command for horizontal slide mode (page-by-page concat).
 */
export function buildFfmpegVideoCommand(
  cards: readonly Pick<CardRenderModel, "kind">[],
  imagePaths: readonly string[],
  outputPath: string,
  audio?: FfmpegAudioOptions,
  timing?: VideoTimingOptions,
): FfmpegCommand {
  if (cards.length === 0 || cards.length !== imagePaths.length) {
    throw new Error("卡片和图片数量必须一致且不能为空。");
  }
  if (cards[0]?.kind !== "cover") {
    throw new Error("视频必须以封面开始。");
  }

  const durationSeconds = totalVideoDuration(cards, timing);
  const args = ["-y"];
  cards.forEach((card, index) => {
    args.push(
      "-loop",
      "1",
      "-t",
      String(durationForCard(card.kind, timing)),
      "-i",
      imagePaths[index]!,
    );
  });

  // The looped audio input is appended after every still image so its stream
  // index is predictable (cards.length). `-stream_loop -1` repeats short tracks
  // to fill the timeline; `-shortest` later trims it back to the video length.
  if (audio) {
    args.push("-stream_loop", "-1", "-i", audio.path);
  }

  const inputLabels = cards.map((_, index) => `[${index}:v]`).join("");
  const videoFilter = `${inputLabels}concat=n=${cards.length}:v=1:a=0,format=yuv420p[v]`;

  if (audio) {
    const volume = clampVolume(audio.volume);
    const fadeOut = Math.max(0, audio.fadeOutSeconds ?? 1);
    const fadeStart = Math.max(0, durationSeconds - fadeOut);
    args.push(
      "-filter_complex",
      `${videoFilter};[${cards.length}:a]atrim=0:${durationSeconds},asetpts=PTS-STARTPTS,volume=${volume},afade=t=out:st=${fadeStart}:d=${fadeOut}[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath,
    );
  } else {
    args.push(
      "-filter_complex",
      videoFilter,
      "-map",
      "[v]",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-movflags",
      "+faststart",
      outputPath,
    );
  }

  return {
    executable: "ffmpeg",
    args,
    durationSeconds,
  };
}

/**
 * Builds the FFmpeg command for the Zhihu-UI scroll mode: a single tall strip
 * PNG scrolls behind a fixed bottom interaction bar overlay.
 *
 * Inputs: [0] tall content strip PNG, [1] bottom bar PNG, [2] optional BGM.
 * Output: 1080×1920 video (1780px scroll viewport + 140px fixed bar).
 */
export function buildFfmpegScrollOverlayCommand(
  stripImagePath: string,
  stripHeight: number,
  barImagePath: string,
  outputPath: string,
  scrollSpeed: number,
  audio?: FfmpegAudioOptions,
): FfmpegCommand {
  const viewportHeight = 1780; // 1920 - 140 (bottom bar)
  const pxPerSecond = scrollSpeedToPixelsPerSecond(scrollSpeed);
  const maxScroll = Math.max(0, stripHeight - viewportHeight);
  const durationSeconds = Math.max(
    1,
    maxScroll > 0 ? Math.ceil(maxScroll / pxPerSecond) : 1,
  );

  const args = ["-y"];
  args.push("-loop", "1", "-i", stripImagePath);
  args.push("-loop", "1", "-i", barImagePath);
  if (audio) {
    args.push("-stream_loop", "-1", "-i", audio.path);
  }

  // Crop a moving window from the tall strip, pad the canvas to 1920px,
  // then overlay the fixed bar at the bottom.
  const cropExpr = `min(t*${pxPerSecond},${maxScroll})`;
  const videoFilter =
    `[0:v]crop=1080:${viewportHeight}:0:'${cropExpr}',pad=1080:1920:0:0:color=#FFFFFF[scroll];` +
    `[1:v]format=rgba[bar];` +
    `[scroll][bar]overlay=0:${viewportHeight},format=yuv420p[v]`;

  if (audio) {
    const volume = clampVolume(audio.volume);
    const fadeOut = Math.max(0, audio.fadeOutSeconds ?? 1);
    const fadeStart = Math.max(0, durationSeconds - fadeOut);
    const audioIndex = 2;
    args.push(
      "-filter_complex",
      `${videoFilter};[${audioIndex}:a]atrim=0:${durationSeconds},asetpts=PTS-STARTPTS,volume=${volume},afade=t=out:st=${fadeStart}:d=${fadeOut}[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-t",
      String(durationSeconds),
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath,
    );
  } else {
    args.push(
      "-filter_complex",
      videoFilter,
      "-map",
      "[v]",
      "-t",
      String(durationSeconds),
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-movflags",
      "+faststart",
      outputPath,
    );
  }

  return {
    executable: "ffmpeg",
    args,
    durationSeconds,
  };
}

/**
 * Maps scroll speed (1~5) to vertical pixels per second. Speed 1 (default)
 * scrolls at 80 px/s for comfortable reading; each step adds 40 px/s
 * (80 / 120 / 160 / 200 / 240).
 */
export function scrollSpeedToPixelsPerSecond(speed: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(speed)));
  return 40 + clamped * 40;
}

/**
 * Builds the FFmpeg command for vertical scroll mode. All card images are
 * stacked vertically into one tall strip, then a moving crop window pans
 * upward at a constant speed to simulate phone scrolling.
 */
export function buildFfmpegScrollCommand(
  cards: readonly Pick<CardRenderModel, "kind">[],
  imagePaths: readonly string[],
  outputPath: string,
  scrollSpeed: number,
  audio?: FfmpegAudioOptions,
): FfmpegCommand {
  if (cards.length === 0 || cards.length !== imagePaths.length) {
    throw new Error("卡片和图片数量必须一致且不能为空。");
  }
  if (cards[0]?.kind !== "cover") {
    throw new Error("视频必须以封面开始。");
  }

  const cardHeight = 1920;
  const cardWidth = 1080;
  const totalHeight = cards.length * cardHeight;
  const pxPerSecond = scrollSpeedToPixelsPerSecond(scrollSpeed);
  // Duration = time to scroll the full strip height at the given speed.
  const durationSeconds = Math.ceil(totalHeight / pxPerSecond);

  const args = ["-y"];
  // Each input must loop so the vstack produces a continuous frame stream.
  imagePaths.forEach((path) => {
    args.push("-loop", "1", "-i", path);
  });

  if (audio) {
    args.push("-stream_loop", "-1", "-i", audio.path);
  }

  // Stack all images vertically, then crop a moving window that pans upward.
  const inputLabels = cards.map((_, index) => `[${index}:v]`).join("");
  const vstack = `${inputLabels}vstack=inputs=${cards.length}`;
  const scrollFilter = `${vstack},crop=${cardWidth}:${cardHeight}:0:'min(t*${pxPerSecond},in_h-out_h)',format=yuv420p[v]`;

  if (audio) {
    const volume = clampVolume(audio.volume);
    const fadeOut = Math.max(0, audio.fadeOutSeconds ?? 1);
    const fadeStart = Math.max(0, durationSeconds - fadeOut);
    const audioIndex = cards.length;
    args.push(
      "-filter_complex",
      `${scrollFilter};[${audioIndex}:a]atrim=0:${durationSeconds},asetpts=PTS-STARTPTS,volume=${volume},afade=t=out:st=${fadeStart}:d=${fadeOut}[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-t",
      String(durationSeconds),
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputPath,
    );
  } else {
    args.push(
      "-filter_complex",
      scrollFilter,
      "-map",
      "[v]",
      "-t",
      String(durationSeconds),
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-movflags",
      "+faststart",
      outputPath,
    );
  }

  return {
    executable: "ffmpeg",
    args,
    durationSeconds,
  };
}
