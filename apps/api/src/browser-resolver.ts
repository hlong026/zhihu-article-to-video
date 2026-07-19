import { existsSync } from "node:fs";

/**
 * Resolves which browser the Zhihu reader drives, using a hybrid fallback
 * chain so the packaged desktop app works on a fresh machine:
 *
 *   1. ZHIHU_BROWSER_EXECUTABLE_PATH (operator-pinned executable)
 *   2. ZHIHU_BROWSER_CHANNEL (operator-pinned channel)
 *   3. Locally installed Chrome — best Zhihu risk-control profile
 *   4. Locally installed Edge — preinstalled on consumer Windows
 *   5. Chromium bundled inside the desktop app (guaranteed fallback)
 *   6. Playwright's own chromium (PLAYWRIGHT_BROWSERS_PATH / default cache)
 *
 * Probing duplicates Playwright's channel lookup paths on purpose: it lets
 * us degrade gracefully with actionable warnings instead of failing the
 * first task with a bare "channel not found" error.
 */

export type BrowserResolutionSource =
  | "explicit-path"
  | "channel"
  | "bundled"
  | "playwright-default";

export interface BrowserResolutionInput {
  /** ZHIHU_BROWSER_EXECUTABLE_PATH. */
  explicitExecutablePath?: string;
  /** ZHIHU_BROWSER_CHANNEL. */
  explicitChannel?: string;
  /** Absolute path of the Chromium executable shipped inside the app. */
  bundledExecutablePath?: string;
  platform?: NodeJS.Platform;
  /** Used for %PROGRAMFILES% etc. on Windows. Defaults to process.env. */
  environment?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}

export interface BrowserResolution {
  executablePath?: string;
  channel?: string;
  source: BrowserResolutionSource;
  warnings: string[];
}

/** Channels probed, in order, when the operator did not pin one. */
const DEFAULT_CHANNEL_CHAIN = ["chrome", "msedge"];

const CHANNEL_MACOS_PATHS: Record<string, string[]> = {
  chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  msedge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
};

const CHANNEL_LINUX_PATHS: Record<string, string[]> = {
  chrome: [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ],
  msedge: ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge"],
};

const CHANNEL_WINDOWS_SUBPATHS: Record<string, string> = {
  chrome: "Google\\Chrome\\Application\\chrome.exe",
  msedge: "Microsoft\\Edge\\Application\\msedge.exe",
};

function windowsInstallRoots(environment: NodeJS.ProcessEnv): string[] {
  const roots = [
    environment.LOCALAPPDATA,
    environment["PROGRAMFILES(X86)"],
    environment.PROGRAMFILES,
    environment.PROGRAMW6432,
    // Sensible fixed fallbacks when the variables are missing entirely.
    "C:\\Program Files (x86)",
    "C:\\Program Files",
  ].filter((root): root is string => Boolean(root));
  return [...new Set(roots)];
}

/** Well-known install locations Playwright checks for a branded channel. */
export function channelCandidatePaths(
  channel: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (platform === "win32") {
    const subPath = CHANNEL_WINDOWS_SUBPATHS[channel];
    if (!subPath) return [];
    return windowsInstallRoots(environment).map((root) => `${root}\\${subPath}`);
  }
  if (platform === "darwin") return CHANNEL_MACOS_PATHS[channel] ?? [];
  return CHANNEL_LINUX_PATHS[channel] ?? [];
}

export function resolveBrowserLaunch(
  input: BrowserResolutionInput = {},
): BrowserResolution {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? (process.env as NodeJS.ProcessEnv);
  const fileExists = input.fileExists ?? existsSync;
  const warnings: string[] = [];

  const explicitPath = input.explicitExecutablePath?.trim();
  if (explicitPath) {
    if (fileExists(explicitPath)) {
      return { executablePath: explicitPath, source: "explicit-path", warnings };
    }
    warnings.push(
      `ZHIHU_BROWSER_EXECUTABLE_PATH 指定的浏览器不存在（${explicitPath}），将继续探测其他浏览器。`,
    );
  }

  const explicitChannel = input.explicitChannel?.trim();
  const chain = explicitChannel
    ? [explicitChannel, ...DEFAULT_CHANNEL_CHAIN.filter((c) => c !== explicitChannel)]
    : DEFAULT_CHANNEL_CHAIN;
  let warnedExplicitChannel = false;
  for (const channel of chain) {
    if (channelCandidatePaths(channel, platform, environment).some(fileExists)) {
      return { channel, source: "channel", warnings };
    }
    if (explicitChannel && channel === explicitChannel && !warnedExplicitChannel) {
      warnedExplicitChannel = true;
      warnings.push(
        `ZHIHU_BROWSER_CHANNEL 指定的浏览器 "${channel}" 未在常见安装路径找到，将继续探测其他浏览器。`,
      );
    }
  }

  const bundled = input.bundledExecutablePath?.trim();
  if (bundled) {
    if (fileExists(bundled)) {
      return { executablePath: bundled, source: "bundled", warnings };
    }
    warnings.push(`应用内置浏览器缺失（${bundled}），将尝试 Playwright 默认浏览器。`);
  }

  return { source: "playwright-default", warnings };
}
