import { existsSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BgmPreset,
  BgmSettings,
  BgmSettingsView,
} from "@zhihu-video/contracts";
import type { FfmpegAudioOptions } from "@zhihu-video/pipeline";

/** Audio containers the operator may select or upload. */
export const ALLOWED_AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav"] as const;

/** MIME types served when streaming an audio file back for previewing. */
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

/** Picks the audio MIME type for a file, defaulting to a generic binary type. */
export function audioContentType(fileName: string): string {
  return AUDIO_CONTENT_TYPES[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** Friendly labels for the bundled, synthesized (license-free) presets. */
const PRESET_NAMES: Record<string, string> = {
  "soft-ambient": "轻柔氛围",
  "warm-pad": "温暖铺底",
};

const currentDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Locates the bundled preset folder. The module runs from `src` under `tsx`
 * in development and from `dist/src` once compiled, so both relative depths
 * are probed before falling back to the source-tree location.
 */
export function presetsDirectory(): string {
  const candidates = [
    join(currentDirectory, "../assets/bgm-presets"),
    join(currentDirectory, "../../assets/bgm-presets"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Uploaded tracks live next to the database, mirroring the browser session. */
export function bgmUploadsDirectory(databasePath: string): string {
  return join(dirname(databasePath), "assets", "bgm");
}

function isAllowedAudioExtension(fileName: string): boolean {
  return (ALLOWED_AUDIO_EXTENSIONS as readonly string[]).includes(
    extname(fileName).toLowerCase(),
  );
}

/** Scans the preset folder and lists every bundled audio track. */
export function listPresets(): BgmPreset[] {
  const directory = presetsDirectory();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(isAllowedAudioExtension)
    .map((file) => {
      const id = file.slice(0, file.length - extname(file).length);
      return { id, name: PRESET_NAMES[id] ?? id };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/** Absolute path of a preset by id, or null when it is missing. */
export function presetFilePath(presetId: string): string | null {
  const directory = presetsDirectory();
  if (!existsSync(directory)) return null;
  const match = readdirSync(directory).find(
    (file) =>
      isAllowedAudioExtension(file) &&
      file.slice(0, file.length - extname(file).length) === presetId,
  );
  return match ? join(directory, match) : null;
}

/**
 * The single uploaded track is stored under a deterministic name so a new
 * upload cleanly replaces the previous one.
 */
export function uploadedFilePath(
  databasePath: string,
  displayFileName: string,
): string {
  const extension = extname(displayFileName).toLowerCase() || ".mp3";
  return join(bgmUploadsDirectory(databasePath), `current${extension}`);
}

/** Resolves the on-disk audio file backing the current selection, if any. */
export function resolveAudioFile(
  settings: BgmSettings,
  databasePath: string,
): string | null {
  if (settings.source === "preset" && settings.presetId) {
    const path = presetFilePath(settings.presetId);
    return path && existsSync(path) ? path : null;
  }
  if (settings.source === "upload" && settings.fileName) {
    const path = uploadedFilePath(databasePath, settings.fileName);
    return existsSync(path) ? path : null;
  }
  return null;
}

/**
 * Builds the FFmpeg audio options for a render, or null when background music
 * is disabled or its file is unavailable.
 */
export function resolveAudioOptions(
  settings: BgmSettings,
  databasePath: string,
): FfmpegAudioOptions | null {
  if (!settings.enabled) return null;
  const path = resolveAudioFile(settings, databasePath);
  if (!path) return null;
  return {
    path,
    volume: settings.volume,
    fadeOutSeconds: settings.fadeOutSeconds,
  };
}

/** Assembles the read model the workbench renders (settings + presets). */
export function buildBgmView(
  settings: BgmSettings,
  databasePath: string,
): BgmSettingsView {
  return {
    ...settings,
    presets: listPresets(),
    hasAudio: resolveAudioFile(settings, databasePath) !== null,
  };
}

export function isSupportedAudioFile(fileName: string): boolean {
  return isAllowedAudioExtension(fileName);
}
