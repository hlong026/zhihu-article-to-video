import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { FfmpegCommand, VideoSummary } from "@zhihu-video/pipeline";

import { renderVideoAssets } from "../src/media-renderer.js";

const summary: VideoSummary = {
  sourceTitle: "原文标题",
  videoTitle: "三个方法把观点讲清楚",
  tags: ["内容创作", "知乎"],
  pages: [
    {
      body: "第一页正文内容从这里开始，需要超过三十八个字符才能通过校验，因此多写一些文字。",
      sourceRefs: [1],
    },
    {
      body: "第二页继续展示正文内容，同样需要超过三十八个字符，保持每一页都有足够的信息量。",
      sourceRefs: [2],
    },
    {
      body: "第三页是正文的最后一页，作为末页即使不足三十八字符也允许，但仍写满内容。",
      sourceRefs: [3],
    },
  ],
  truncated: true,
  riskFlags: [],
};

describe("media renderer", () => {
  it("writes reviewable PNG cards and delegates the matching FFmpeg command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhihu-media-renderer-"));
    let receivedCommand: FfmpegCommand | null = null;

    try {
      const assets = await renderVideoAssets(
        {
          outputDirectory: directory,
          summary,
          keyword: "测试口令",
        },
        {
          executeFfmpeg: async (command) => {
            receivedCommand = command;
          },
        },
      );

      expect(assets.imagePaths).toHaveLength(4);
      expect(assets.imagePaths[0]).toMatch(/1-cover\.png$/);
      await expect(stat(assets.imagePaths[0]!)).resolves.toMatchObject({
        isFile: expect.any(Function),
      });
      expect(assets.videoPath).toBe(join(directory, "video.mp4"));
      expect(assets.durationSeconds).toBe(10);
      expect(receivedCommand).toMatchObject({
        executable: "ffmpeg",
        durationSeconds: 10,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses Zhihu reading-page screenshots for the horizontal reference mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zhihu-reading-renderer-"));
    let receivedCommand: FfmpegCommand | null = null;

    try {
      const assets = await renderVideoAssets(
        {
          outputDirectory: directory,
          summary,
          keyword: "测试口令",
          videoMode: "slide",
          cleanedParagraphs: Array.from(
            { length: 30 },
            (_, index) =>
              `第${index + 1}段原文，模拟知乎阅读页的连续分屏输出。`,
          ),
        },
        {
          executeFfmpeg: async (command) => {
            receivedCommand = command;
          },
        },
      );

      expect(assets.imagePaths.length).toBeGreaterThan(1);
      expect(assets.imagePaths[0]).toMatch(/01-reading\.png$/);
      expect(assets.imagePaths.at(-1)).toMatch(/-tail\.png$/);
      expect(receivedCommand).toMatchObject({ executable: "ffmpeg" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
