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

function clampVolume(volume: number | undefined): number {
  if (volume === undefined || Number.isNaN(volume)) return 0.3;
  return Math.min(1, Math.max(0, volume));
}

export function durationForCard(kind: CardKind): 1 | 2 {
  return kind === "cover" ? 1 : 2;
}

export function totalVideoDuration(
  cards: readonly Pick<CardRenderModel, "kind">[],
): number {
  return cards.reduce((total, card) => total + durationForCard(card.kind), 0);
}

export function buildFfmpegVideoCommand(
  cards: readonly Pick<CardRenderModel, "kind">[],
  imagePaths: readonly string[],
  outputPath: string,
  audio?: FfmpegAudioOptions,
): FfmpegCommand {
  if (cards.length === 0 || cards.length !== imagePaths.length) {
    throw new Error("卡片和图片数量必须一致且不能为空。");
  }
  if (cards[0]?.kind !== "cover" || cards.at(-1)?.kind !== "tail") {
    throw new Error("视频必须以封面开始并以尾页结束。");
  }

  const durationSeconds = totalVideoDuration(cards);
  const args = ["-y"];
  cards.forEach((card, index) => {
    args.push(
      "-loop",
      "1",
      "-t",
      String(durationForCard(card.kind)),
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
      `${videoFilter};[${cards.length}:a]volume=${volume},afade=t=out:st=${fadeStart}:d=${fadeOut}[a]`,
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
