import { describe, expect, it } from "vitest";

import {
  channelCandidatePaths,
  resolveBrowserLaunch,
} from "../src/browser-resolver.js";

const WIN_ENV = {
  LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  PROGRAMFILES: "C:\\Program Files",
} as NodeJS.ProcessEnv;

const CHROME_WIN =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EDGE_WIN =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EDGE_MAC = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const BUNDLED = "/app/playwright-browsers/chromium-1228/chrome-linux/chrome";

function existingFiles(paths: string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe("channelCandidatePaths", () => {
  it("probes the standard Windows install roots for Chrome", () => {
    expect(channelCandidatePaths("chrome", "win32", WIN_ENV)).toEqual([
      "C:\\Users\\operator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  });

  it("falls back to fixed Program Files roots when env vars are missing", () => {
    expect(channelCandidatePaths("msedge", "win32", {} as NodeJS.ProcessEnv)).toEqual([
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
  });

  it("returns an empty list for unknown channels", () => {
    expect(channelCandidatePaths("firefox", "darwin", {} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("resolveBrowserLaunch", () => {
  it("prefers an explicit executable path that exists", () => {
    const resolution = resolveBrowserLaunch({
      explicitExecutablePath: "/custom/chrome",
      platform: "darwin",
      environment: {} as NodeJS.ProcessEnv,
      fileExists: existingFiles(["/custom/chrome", CHROME_MAC]),
    });
    expect(resolution).toEqual({
      executablePath: "/custom/chrome",
      source: "explicit-path",
      warnings: [],
    });
  });

  it("warns and continues the chain when the explicit path is missing", () => {
    const resolution = resolveBrowserLaunch({
      explicitExecutablePath: "/missing/chrome",
      platform: "darwin",
      environment: {} as NodeJS.ProcessEnv,
      fileExists: existingFiles([CHROME_MAC]),
    });
    expect(resolution.channel).toBe("chrome");
    expect(resolution.source).toBe("channel");
    expect(resolution.warnings).toHaveLength(1);
    expect(resolution.warnings[0]).toContain("/missing/chrome");
  });

  it("honours an explicit channel when it is installed", () => {
    const resolution = resolveBrowserLaunch({
      explicitChannel: "msedge",
      platform: "win32",
      environment: WIN_ENV,
      fileExists: existingFiles([CHROME_WIN, EDGE_WIN]),
    });
    expect(resolution).toEqual({
      channel: "msedge",
      source: "channel",
      warnings: [],
    });
  });

  it("warns and keeps probing when the explicit channel is not installed", () => {
    const resolution = resolveBrowserLaunch({
      explicitChannel: "msedge",
      platform: "win32",
      environment: WIN_ENV,
      fileExists: existingFiles([CHROME_WIN]),
    });
    expect(resolution.channel).toBe("chrome");
    expect(resolution.source).toBe("channel");
    expect(resolution.warnings[0]).toContain("msedge");
  });

  it("falls back to Edge on a Windows machine without Chrome", () => {
    const resolution = resolveBrowserLaunch({
      platform: "win32",
      environment: WIN_ENV,
      fileExists: existingFiles([EDGE_WIN]),
    });
    expect(resolution).toEqual({
      channel: "msedge",
      source: "channel",
      warnings: [],
    });
  });

  it("prefers Chrome over Edge when both are installed", () => {
    const resolution = resolveBrowserLaunch({
      platform: "darwin",
      environment: {} as NodeJS.ProcessEnv,
      fileExists: existingFiles([CHROME_MAC, EDGE_MAC]),
    });
    expect(resolution.channel).toBe("chrome");
  });

  it("uses the bundled Chromium when no local browser is found", () => {
    const resolution = resolveBrowserLaunch({
      bundledExecutablePath: BUNDLED,
      platform: "linux",
      environment: {} as NodeJS.ProcessEnv,
      fileExists: existingFiles([BUNDLED]),
    });
    expect(resolution).toEqual({
      executablePath: BUNDLED,
      source: "bundled",
      warnings: [],
    });
  });

  it("degrades to the Playwright default browser as the last resort", () => {
    const resolution = resolveBrowserLaunch({
      bundledExecutablePath: BUNDLED,
      platform: "linux",
      environment: {} as NodeJS.ProcessEnv,
      fileExists: existingFiles([]),
    });
    expect(resolution.executablePath).toBeUndefined();
    expect(resolution.channel).toBeUndefined();
    expect(resolution.source).toBe("playwright-default");
    expect(resolution.warnings[0]).toContain(BUNDLED);
  });
});
