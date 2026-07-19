import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Resolves the FFmpeg executable path with the following priority:
 * 1. Explicitly provided bundled path (packaged desktop app).
 * 2. FFMPEG_PATH environment variable (full path to the binary).
 * 3. Common Windows install locations (not in PATH by default).
 * 4. Bare "ffmpeg" relying on the system PATH.
 */
export function resolveFfmpegExecutable(
  bundledPath?: string,
): string {
  // 1. Bundled binary shipped inside the desktop app package.
  if (bundledPath && existsSync(bundledPath)) {
    return bundledPath;
  }

  // 2. Explicit env override (full path to the ffmpeg binary).
  const envPath = process.env.FFMPEG_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 3. On Windows, probe common install locations that users may not have
  //    added to PATH (e.g. extracted zip in C:\ffmpeg\bin).
  if (process.platform === "win32") {
    const candidates = [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "ffmpeg", "bin", "ffmpeg.exe"),
      "C:\\ffmpeg\\bin\\ffmpeg.exe",
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  // 4. Verify bare "ffmpeg" is reachable via PATH; return it regardless
  //    (spawn will produce a clear ENOENT if missing).
  return "ffmpeg";
}

/**
 * Quick health-check: returns true when the resolved executable can be
 * invoked (ffmpeg -version exits 0). Useful for startup diagnostics.
 */
export function isFfmpegAvailable(executable: string): boolean {
  try {
    execFileSync(executable, ["-version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
