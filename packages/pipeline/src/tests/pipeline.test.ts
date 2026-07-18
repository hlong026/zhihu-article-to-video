import {
  buildCardSequence,
  buildFfmpegVideoCommand,
  buildPreparedVideo,
  cleanReadableContent,
  classifyZhihuUrl,
  countBodyCharacters,
  totalVideoDuration,
  escapeSvgText,
  paginateParagraphs,
  parseTitleAndTags,
  renderSummarySvgCards,
  simplifyMathMarkup,
  truncateVideoTitle,
  writeSummaryPngCards,
  writeSummarySvgCards,
  validateVideoSummary,
  type VideoSummary,
} from "../index.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function deepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function throws(action: () => void, message: string): void {
  try {
    action();
  } catch {
    return;
  }

  throw new Error(`${message}: expected an error`);
}

const validSummary: VideoSummary = {
  sourceTitle: "原文标题",
  videoTitle: "把复杂观点讲清楚的三个方法",
  tags: ["内容创作", "知乎", "AI"],
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

export async function runPipelineTests(): Promise<void> {
  deepEqual(
    classifyZhihuUrl(
      "https://www.zhihu.com/question/1/answer/2?utm_source=test",
    ),
    {
      sourceType: "answer",
      canonicalUrl: "https://www.zhihu.com/question/1/answer/2",
    },
    "answer URLs should be classified and canonicalized",
  );
  deepEqual(
    classifyZhihuUrl("https://www.zhihu.com/answer/2?utm_source=test"),
    { sourceType: "answer", canonicalUrl: "https://www.zhihu.com/answer/2" },
    "short answer URLs from the import workbook should be classified and canonicalized",
  );
  deepEqual(
    classifyZhihuUrl("https://zhuanlan.zhihu.com/p/123456/"),
    {
      sourceType: "article",
      canonicalUrl: "https://zhuanlan.zhihu.com/p/123456",
    },
    "article URLs should be classified and canonicalized",
  );
  equal(
    classifyZhihuUrl("https://www.zhihu.com/question/1").sourceType,
    null,
    "unsupported URLs should be rejected",
  );
  equal(
    classifyZhihuUrl("https://example.com/answer/2").sourceType,
    null,
    "non-Zhihu URLs should be rejected",
  );

  const cleaned = cleanReadableContent({
    title: "  一个标题  ",
    paragraphs: [
      "知乎首页",
      "  第一段\n\n有用内容  ",
      "第一段 有用内容",
      "广告",
      "第二段内容",
    ],
  });
  equal(cleaned.title, "一个标题", "content title should be normalized");
  deepEqual(
    cleaned.paragraphs,
    ["第一段 有用内容", "第二段内容"],
    "navigation, ads, and duplicate paragraphs should be removed",
  );

  equal(
    simplifyMathMarkup("没有公式的普通中文段落。"),
    "没有公式的普通中文段落。",
    "prose without LaTeX must pass through untouched",
  );
  const mathContent = cleanReadableContent({
    title: "公式文章",
    paragraphs: [
      "串联流程 \\boxed{ \\text{Pretraining} \\rightarrow \\text{Mid-training} } 如上。",
      "它的损失是 $\\mathcal L_{\\mathrm{PT}} = -\\mathbb E_{(x,y)\\sim\\mathcal D}\\left[ \\sum_t \\log\\pi_\\theta \\right]$ 。",
    ],
  });
  equal(
    /[\\{}]/.test(mathContent.paragraphs.join("")),
    false,
    "raw LaTeX backslashes and braces must never reach a card",
  );
  equal(
    mathContent.paragraphs[0]?.includes("Pretraining → Mid-training"),
    true,
    "math wrappers should keep inner text and map arrows to Unicode",
  );
  equal(
    mathContent.paragraphs[1]?.includes("Σ") &&
      mathContent.paragraphs[1]?.includes("π"),
    true,
    "math symbols should be converted to readable Unicode glyphs",
  );

  const accepted = validateVideoSummary(validSummary, {
    hasVerifiedKeyword: true,
  });
  equal(
    accepted.status,
    "ready",
    "a compliant summary should be ready to render",
  );
  equal(
    accepted.issues.length,
    0,
    "a compliant summary should not have issues",
  );

  const tooMany = validateVideoSummary(
    {
      ...validSummary,
      pages: Array.from({ length: 11 }, (_, index) => ({
        body: `第${index + 1}页正文内容，需要超过三十八个字符才能通过校验，因此多写一些文字进去。`,
        sourceRefs: [index + 1],
      })),
    },
    { hasVerifiedKeyword: true },
  );
  equal(
    tooMany.status,
    "needs_review",
    "more than ten body pages should need review",
  );
  equal(
    tooMany.issues[0]?.code,
    "TOO_MANY_PAGES",
    "too-many-page summaries should explain the reason",
  );

  const shortBody = validateVideoSummary(
    {
      ...validSummary,
      pages: [
        { body: "不足三十八字的短正文。", sourceRefs: [1] },
        validSummary.pages[1]!,
      ],
    },
    { hasVerifiedKeyword: true },
  );
  equal(
    shortBody.status,
    "needs_review",
    "a non-final page under 38 characters should need review",
  );
  equal(
    shortBody.issues[0]?.code,
    "CARD_BODY_TOO_SHORT",
    "short body pages should explain the reason",
  );

  const shortLastPage = validateVideoSummary(
    {
      ...validSummary,
      pages: [validSummary.pages[0]!, { body: "末页很短。", sourceRefs: [2] }],
    },
    { hasVerifiedKeyword: true },
  );
  equal(
    shortLastPage.status,
    "ready",
    "a short final page is allowed and should render as-is",
  );

  const longTitle = validateVideoSummary(
    { ...validSummary, videoTitle: "一".repeat(23) },
    { hasVerifiedKeyword: true },
  );
  equal(
    longTitle.issues[0]?.code,
    "TITLE_TOO_LONG",
    "titles over 22 characters should be rejected",
  );

  equal(
    truncateVideoTitle("短标题"),
    "短标题",
    "short titles should pass through unchanged",
  );
  const truncatedTitle = truncateVideoTitle("一".repeat(30));
  equal(
    Array.from(truncatedTitle).length,
    22,
    "long titles should be truncated to 22 characters",
  );
  equal(
    truncatedTitle.endsWith("…"),
    true,
    "truncated titles should end with an ellipsis",
  );

  deepEqual(
    parseTitleAndTags({ videoTitle: "标题", tags: ["a", "b"] }),
    { videoTitle: "标题", tags: ["a", "b"] },
    "well-formed AI output should parse",
  );
  equal(
    parseTitleAndTags({ videoTitle: "", tags: [] }),
    null,
    "empty titles should be rejected",
  );
  equal(
    parseTitleAndTags("not-an-object"),
    null,
    "non-object AI output should be rejected",
  );

  const singlePage = paginateParagraphs(["第一段短内容。", "第二段短内容。"]);
  equal(singlePage.pages.length, 1, "short articles should fit one page");
  equal(
    singlePage.truncated,
    false,
    "short articles should not be marked as truncated",
  );
  deepEqual(
    singlePage.pages[0]?.sourceRefs,
    [1, 2],
    "the single page should reference both paragraphs",
  );

  const multiPage = paginateParagraphs(["一".repeat(360)]);
  equal(
    multiPage.pages.length,
    2,
    "long articles should spill onto a second page",
  );
  equal(
    multiPage.pages[0]?.body.split("\n").length,
    18,
    "a full page should contain eighteen lines",
  );

  const wordWrapped = paginateParagraphs([
    "本章从完整 LLM training recipe 的角度理解这些算法如何组合起来。",
  ]);
  const wordWrapLines = wordWrapped.pages.flatMap((page) =>
    page.body.split("\n"),
  );
  equal(
    wordWrapLines.some((line) => line.includes("training")),
    true,
    "Latin words must stay whole instead of breaking mid-word",
  );
  equal(
    wordWrapLines.some((line) => line.includes("recipe")),
    true,
    "every Latin word should remain intact after wrapping",
  );

  const truncatedPages = paginateParagraphs(["一".repeat(18 * 18 * 12)]);
  equal(
    truncatedPages.pages.length,
    10,
    "articles longer than ten pages should be truncated",
  );
  equal(
    truncatedPages.truncated,
    true,
    "overflowing articles should be marked as truncated",
  );
  equal(
    truncatedPages.pages[9]?.body.endsWith("……"),
    true,
    "the last truncated page should end with an ellipsis",
  );

  equal(
    countBodyCharacters("abc def\nghi"),
    9,
    "whitespace should not count toward the body length",
  );

  const badReference = validateVideoSummary(
    {
      ...validSummary,
      pages: [
        { ...validSummary.pages[0]!, sourceRefs: [] },
        ...validSummary.pages.slice(1),
      ],
    },
    { hasVerifiedKeyword: true },
  );
  equal(
    badReference.status,
    "needs_review",
    "pages without source references should be rejected",
  );
  equal(
    badReference.issues[0]?.code,
    "MISSING_SOURCE_REFERENCE",
    "missing references should be explicit",
  );

  const missingKeyword = validateVideoSummary(validSummary, {
    hasVerifiedKeyword: false,
  });
  equal(
    missingKeyword.status,
    "needs_review",
    "an unverified generated keyword must require review",
  );
  equal(
    missingKeyword.issues[0]?.code,
    "KEYWORD_UNVERIFIED",
    "unverified keywords should be explicit",
  );

  const cards = buildCardSequence(validSummary, "三个方法");
  equal(
    cards.length,
    5,
    "card sequence should include cover, body pages, and tail",
  );
  equal(cards[0]?.kind, "cover", "first card should be cover");
  equal(cards[1]?.kind, "body", "middle cards should be body cards");
  equal(cards[4]?.kind, "tail", "last card should be the tail card");
  equal(
    cards[4]?.text,
    "来知乎搜索「三个方法」看全文",
    "tail should interpolate the verified keyword",
  );
  deepEqual(
    cards[0]?.canvas,
    { width: 1080, height: 1920 },
    "all cards should use a 9:16 1080x1920 canvas",
  );

  const untruncatedCards = buildCardSequence(
    { ...validSummary, truncated: false },
    "三个方法",
  );
  equal(
    untruncatedCards.length,
    5,
    "the tail is mandatory even for a fully shown article",
  );
  equal(
    untruncatedCards.at(-1)?.kind,
    "tail",
    "every sequence must end on the search-keyword tail",
  );
  equal(
    untruncatedCards.at(-1)?.text,
    "来知乎搜索「三个方法」看更多",
    "a complete article's tail should invite viewers to see more, not the full text",
  );
  throws(
    () => buildCardSequence({ ...validSummary, truncated: false }, ""),
    "rendering the mandatory tail still requires a verified keyword",
  );

  equal(
    escapeSvgText('中文 & <标签> "引号"'),
    "中文 &amp; &lt;标签&gt; &quot;引号&quot;",
    "SVG text should escape XML special characters without replacing Chinese",
  );
  const svgCards = renderSummarySvgCards(
    {
      ...validSummary,
      videoTitle: "标题 & <正文>",
      pages: [
        {
          ...validSummary.pages[0]!,
          body: "保留中文与 & 符号。",
        },
        ...validSummary.pages.slice(1),
      ],
    },
    "三个方法 & 进阶",
  );
  deepEqual(
    svgCards.map((card) => card.filename),
    ["1-cover.svg", "2-body.svg", "3-body.svg", "4-body.svg", "5-tail.svg"],
    "SVG filenames should be deterministic and ordered by page",
  );
  equal(
    svgCards[0]?.svg.includes('width="1080" height="1920"'),
    true,
    "cover SVG should retain the 9:16 canvas dimensions",
  );
  equal(
    svgCards[0]?.svg.includes("标题 &amp; &lt;正文&gt;"),
    true,
    "cover SVG should XML-escape title content",
  );
  equal(
    svgCards[1]?.svg.includes("保留中文与 &amp; 符号。"),
    true,
    "body SVG should XML-escape Chinese text content",
  );
  equal(
    svgCards[4]?.svg.includes("三个方法"),
    true,
    "tail SVG should include the verified search phrase",
  );
  equal(
    svgCards[4]?.svg.includes("&amp;"),
    true,
    "tail SVG should XML-escape the verified search phrase",
  );
  const svgOutputDirectory = await mkdtemp(join(tmpdir(), "zhihu-video-svg-"));
  try {
    const writtenCards = await writeSummarySvgCards(
      svgOutputDirectory,
      validSummary,
      "三个方法",
    );
    equal(writtenCards.length, 5, "every card should be written to disk");
    const writtenCover = await readFile(writtenCards[0]!.outputPath, "utf8");
    equal(
      writtenCover,
      writtenCards[0]!.svg,
      "written SVG should match the deterministic in-memory result",
    );
  } finally {
    await rm(svgOutputDirectory, { recursive: true, force: true });
  }

  const pngOutputDirectory = await mkdtemp(join(tmpdir(), "zhihu-video-png-"));
  try {
    const writtenPngCards = await writeSummaryPngCards(
      pngOutputDirectory,
      validSummary,
      "三个方法",
    );
    equal(writtenPngCards.length, 5, "every SVG card should rasterize to PNG");
    equal(
      writtenPngCards[0]?.outputPath.endsWith("1-cover.png"),
      true,
      "PNG output names should be deterministic",
    );
    const pngHeader = await readFile(writtenPngCards[0]!.outputPath);
    deepEqual(
      [...pngHeader.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      "rasterized card should be a PNG file",
    );
  } finally {
    await rm(pngOutputDirectory, { recursive: true, force: true });
  }

  equal(
    totalVideoDuration(cards),
    9,
    "duration should be cover 1s + body pages 2s each + tail 2s",
  );
  const command = buildFfmpegVideoCommand(
    cards,
    ["cover.png", "01.png", "02.png", "03.png", "tail.png"],
    "video.mp4",
  );
  equal(
    command.durationSeconds,
    9,
    "FFmpeg command should report the calculated duration",
  );
  equal(
    command.executable,
    "ffmpeg",
    "FFmpeg should remain an external executable adapter",
  );
  equal(
    command.args.filter((argument) => argument === "-loop").length,
    5,
    "each still image should be looped independently",
  );
  equal(
    command.args.includes("2"),
    true,
    "body and tail cards should be rendered for two seconds",
  );
  throws(
    () => buildFfmpegVideoCommand(cards, ["cover.png"], "video.mp4"),
    "mismatched images should fail before FFmpeg is invoked",
  );
  throws(
    () =>
      buildFfmpegVideoCommand(
        cards.slice(1),
        ["01.png", "02.png", "03.png", "tail.png"],
        "video.mp4",
      ),
    "a video without a cover should fail before FFmpeg is invoked",
  );

  const musicCommand = buildFfmpegVideoCommand(
    cards,
    ["cover.png", "01.png", "02.png", "03.png", "tail.png"],
    "video.mp4",
    { path: "/music/bgm.mp3", volume: 0.3, fadeOutSeconds: 1 },
  );
  equal(
    musicCommand.args.includes("/music/bgm.mp3"),
    true,
    "the background-music input path should be present in the arguments",
  );
  equal(
    musicCommand.args.includes("-stream_loop"),
    true,
    "short tracks should loop to fill the timeline",
  );
  equal(
    musicCommand.args.filter((argument) => argument === "-map").length,
    2,
    "both the video and audio streams should be mapped",
  );
  equal(
    musicCommand.args.includes("-shortest"),
    true,
    "the looped audio should be trimmed back to the video length",
  );
  const filterIndex = musicCommand.args.indexOf("-filter_complex");
  equal(
    musicCommand.args[filterIndex + 1]?.includes(
      "[5:a]volume=0.3,afade=t=out:st=8:d=1[a]",
    ),
    true,
    "the audio filter should apply volume and a trailing fade-out",
  );
  equal(
    buildFfmpegVideoCommand(
      cards,
      ["cover.png", "01.png", "02.png", "03.png", "tail.png"],
      "video.mp4",
    ).args.includes("-map"),
    true,
    "the audio-free command should keep mapping only the video stream",
  );

  const readyVideo = await buildPreparedVideo(
    {
      sourceUrl: "https://www.zhihu.com/answer/2",
      sourceType: "answer",
      articleKeyword: "三个方法",
    },
    {
      reader: {
        read: async () => ({
          ok: true,
          content: {
            title: "原文标题",
            paragraphs: ["第一段", "第二段", "第三段"],
          },
        }),
      },
      generator: {
        summarize: async () => ({
          videoTitle: "把复杂观点讲清楚的三个方法",
          tags: ["内容创作", "知乎", "AI"],
        }),
      },
    },
  );
  equal(
    readyVideo.kind,
    "ready",
    "readable content and a valid summary should prepare a video",
  );
  if (readyVideo.kind === "ready") {
    equal(
      readyVideo.cards.length,
      3,
      "a short article should expose cover, one body page, and the mandatory tail",
    );
    equal(
      readyVideo.cards.at(-1)?.kind,
      "tail",
      "even a short article must end on the mandatory tail",
    );
    equal(
      readyVideo.summary.truncated,
      false,
      "a short article should not be flagged as truncated",
    );
    equal(
      readyVideo.summary.pages.length,
      1,
      "short articles should paginate into a single body page",
    );
  }

  const missingKeywordVideo = await buildPreparedVideo(
    {
      sourceUrl: "https://www.zhihu.com/answer/2",
      sourceType: "answer",
      articleKeyword: null,
    },
    {
      reader: {
        read: async () => ({
          ok: true,
          content: {
            title: "原文标题",
            paragraphs: ["第一段", "第二段", "第三段"],
          },
        }),
      },
      generator: {
        summarize: async () => ({
          videoTitle: "把复杂观点讲清楚的三个方法",
          tags: ["内容创作", "知乎", "AI"],
        }),
      },
    },
  );
  equal(
    missingKeywordVideo.kind,
    "needs_review",
    "an unverified keyword must block rendering",
  );

  const unavailableVideo = await buildPreparedVideo(
    {
      sourceUrl: "https://www.zhihu.com/answer/2",
      sourceType: "answer",
      articleKeyword: "三个方法",
    },
    {
      reader: {
        read: async () => ({
          ok: false,
          failure: {
            code: "SOURCE_ACCESS_RESTRICTED",
            message: "页面需要授权",
          },
        }),
      },
      generator: {
        summarize: async () => ({
          videoTitle: "把复杂观点讲清楚的三个方法",
          tags: ["内容创作", "知乎", "AI"],
        }),
      },
    },
  );
  equal(
    unavailableVideo.kind,
    "failed",
    "restricted content should not enter AI or rendering",
  );

  const manualVideo = await buildPreparedVideo(
    {
      sourceUrl: "https://www.zhihu.com/answer/2",
      sourceType: "answer",
      articleKeyword: "三个方法",
      manualContent: {
        title: "人工录入标题",
        paragraphs: ["手工第一段", "手工第二段", "手工第三段"],
      },
    },
    {
      reader: {
        read: async () => {
          throw new Error("reader must be skipped when manual content exists");
        },
      },
      generator: {
        summarize: async () => ({
          videoTitle: "把复杂观点讲清楚的三个方法",
          tags: ["内容创作", "知乎", "AI"],
        }),
      },
    },
  );
  equal(
    manualVideo.kind,
    "ready",
    "manual content should bypass the reader and still prepare a video",
  );
  if (manualVideo.kind === "ready") {
    equal(
      manualVideo.sourceTitle,
      "人工录入标题",
      "manual content title should be used as the source title",
    );
    equal(
      manualVideo.snapshotPath,
      undefined,
      "manual content has no reader snapshot to persist",
    );
  }

  let receivedSnapshotDir: string | undefined;
  const snapshotVideo = await buildPreparedVideo(
    {
      sourceUrl: "https://www.zhihu.com/answer/2",
      sourceType: "answer",
      articleKeyword: "三个方法",
      snapshotDir: "/tmp/task-snapshot",
    },
    {
      reader: {
        read: async (source) => {
          receivedSnapshotDir = source.snapshotDir;
          return {
            ok: true as const,
            content: {
              title: "原文标题",
              paragraphs: ["第一段", "第二段", "第三段"],
            },
            snapshotPath: "/tmp/task-snapshot/source.html",
          };
        },
      },
      generator: {
        summarize: async () => ({
          videoTitle: "把复杂观点讲清楚的三个方法",
          tags: ["内容创作", "知乎", "AI"],
        }),
      },
    },
  );
  equal(
    receivedSnapshotDir,
    "/tmp/task-snapshot",
    "the snapshot directory should be forwarded to the reader",
  );
  if (snapshotVideo.kind === "ready") {
    equal(
      snapshotVideo.snapshotPath,
      "/tmp/task-snapshot/source.html",
      "the reader snapshot path should be exposed to the caller",
    );
  } else {
    throw new Error("snapshot forwarding should still prepare a video");
  }

  const aiFailureVideo = await buildPreparedVideo(
    {
      sourceUrl: "https://www.zhihu.com/answer/2",
      sourceType: "answer",
      articleKeyword: "三个方法",
    },
    {
      reader: {
        read: async () => ({
          ok: true,
          content: {
            title: "原文标题",
            paragraphs: ["第一段", "第二段", "第三段"],
          },
        }),
      },
      generator: {
        summarize: async () => {
          throw new Error("AI 服务不可用");
        },
      },
    },
  );
  equal(
    aiFailureVideo.kind,
    "ready",
    "AI failures should fall back to the source title without blocking",
  );
  if (aiFailureVideo.kind === "ready") {
    equal(
      aiFailureVideo.summary.videoTitle,
      "原文标题",
      "the fallback title should come from the source article",
    );
    deepEqual(
      aiFailureVideo.summary.riskFlags,
      ["AI_TITLE_FALLBACK"],
      "the fallback should be recorded as a risk flag",
    );
  }
}
