import {
  buildCardSequence,
  buildFfmpegScrollOverlayCommand,
  buildFfmpegVideoCommand,
  buildPreparedVideo,
  cleanReadableContent,
  classifyZhihuUrl,
  countBodyCharacters,
  durationForCard,
  totalVideoDuration,
  escapeSvgText,
  measureBodyLayout,
  paginateParagraphs,
  parseTitleAndTags,
  renderBottomBar,
  renderSummarySvgCards,
  renderZhihuScrollStrip,
  scrollSpeedToPixelsPerSecond,
  simplifyMathMarkup,
  truncateVideoTitle,
  writeSummaryPngCards,
  writeSummarySvgCards,
  writeZhihuReadingPagePngs,
  validateVideoSummary,
  SCROLL_STRIP_WIDTH,
  BOTTOM_BAR_HEIGHT,
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

  const measured = measureBodyLayout("abcd\nefgh");
  equal(measured.lineCount, 2, "measureBodyLayout should count lines");
  equal(
    measured.maxLineUnits,
    4,
    "ASCII lines should count one layout unit per character",
  );
  equal(
    measureBodyLayout("一二三").maxLineUnits,
    6,
    "wide glyphs should count two layout units each",
  );

  // ASCII 密集内容每行可排 36 个窄字符，单页非空白字符数会远超 324，
  // 但行数仍 ≤18，排版完全放得下——校验不应误报 CARD_BODY_TOO_LONG。
  const asciiHeavy = paginateParagraphs([
    "In this section we explain how the LLM training recipe combines tokenizer, optimizer and scheduler. "
      .repeat(6)
      .trim(),
  ]);
  const asciiSummary = validateVideoSummary(
    {
      ...validSummary,
      pages: asciiHeavy.pages,
      truncated: asciiHeavy.truncated,
    },
    { hasVerifiedKeyword: true },
  );
  equal(
    asciiSummary.issues.some((issue) => issue.code === "CARD_BODY_TOO_LONG"),
    false,
    "ASCII-heavy pages that fit the layout must not be flagged as too long",
  );

  // 真正超高（行数超过 linesPerPage）的页面仍应被拦截。
  const tooTall = validateVideoSummary(
    {
      ...validSummary,
      pages: [
        {
          body: Array.from({ length: 19 }, () => "abc").join("\n"),
          sourceRefs: [1],
        },
      ],
    },
    { hasVerifiedKeyword: true },
  );
  equal(
    tooTall.issues.some((issue) => issue.code === "CARD_BODY_TOO_LONG"),
    true,
    "a page taller than the layout line budget should be flagged",
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
    4,
    "card sequence should include cover and body pages (CTA overlaid on last body)",
  );
  equal(cards[0]?.kind, "cover", "first card should be cover");
  equal(cards[1]?.kind, "body", "middle cards should be body cards");
  equal(
    cards[3]?.kind,
    "body",
    "last card should be a body card with CTA overlay",
  );
  equal(
    (cards[3] as { ctaOverlay?: string }).ctaOverlay,
    "来知乎搜索「三个方法」看全文",
    "last body card should have the CTA overlay with the verified keyword",
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
    4,
    "CTA overlay is on the last body card even for a fully shown article",
  );
  equal(
    untruncatedCards.at(-1)?.kind,
    "body",
    "every sequence ends on a body card with CTA overlay",
  );
  equal(
    (untruncatedCards.at(-1) as { ctaOverlay?: string }).ctaOverlay,
    "来知乎搜索「三个方法」看更多",
    "a complete article's CTA should invite viewers to see more, not the full text",
  );
  throws(
    () => buildCardSequence({ ...validSummary, truncated: false }, ""),
    "rendering the CTA overlay still requires a verified keyword",
  );

  equal(
    escapeSvgText('中文 & <标签> "引号"'),
    "中文 &amp; &lt;标签&gt; &quot;引号&quot;",
    "SVG text should escape XML special characters without replacing Chinese",
  );
  const svgCards = renderSummarySvgCards(
    {
      ...validSummary,
      sourceTitle: "标题 & <正文>",
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
    ["1-cover.svg", "2-body.svg", "3-body.svg", "4-body.svg"],
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
    svgCards[3]?.svg.includes("三个方法"),
    true,
    "last body SVG should include the verified search phrase as CTA overlay",
  );
  equal(
    svgCards[3]?.svg.includes("&amp;"),
    true,
    "last body SVG should XML-escape the verified search phrase",
  );

  const metaSummary: VideoSummary = {
    ...validSummary,
    coverMeta: {
      authorName: "摸鱼作家",
      authorBadge: "互联网行业 软件工程师",
      answerCount: "278",
      followCount: "623",
      avatarDataUri: "data:image/jpeg;base64,QUJD",
    },
  };
  const metaCards = buildCardSequence(metaSummary, "三个方法");
  const metaCover = metaCards[0];
  if (metaCover?.kind !== "cover") {
    throw new Error("expected the first card to be the cover");
  }
  deepEqual(
    metaCover.meta,
    metaSummary.coverMeta,
    "cover card should carry the question-header metadata",
  );
  equal(
    metaCover.title,
    metaSummary.sourceTitle,
    "cover should use the original Zhihu question title",
  );
  equal(
    metaCover.text,
    metaSummary.sourceTitle,
    "cover text should preserve the original Zhihu question title",
  );
  const metaCoverSvg = renderSummarySvgCards(metaSummary, "三个方法")[0];
  equal(
    metaCoverSvg?.svg.includes("知乎 · 278 个回答 · 623 关注"),
    true,
    "cover meta line should show answer and follow counters",
  );
  equal(
    metaCoverSvg?.svg.includes("摸鱼作家"),
    true,
    "cover should show the author name",
  );
  equal(
    metaCoverSvg?.svg.includes("互联网行业 软件工程师"),
    true,
    "cover should show the author badge",
  );
  equal(
    metaCoverSvg?.svg.includes("+ 关注"),
    true,
    "cover should show the decorative follow pill",
  );
  equal(
    metaCoverSvg?.svg.includes('clip-path="url(#cover-avatar-clip)"'),
    true,
    "cover avatar should be clipped to a circle",
  );
  equal(
    metaCoverSvg?.svg.includes("data:image/jpeg;base64,QUJD"),
    true,
    "cover should embed the avatar data URI",
  );

  const partialMetaSvg = renderSummarySvgCards(
    {
      ...metaSummary,
      coverMeta: {
        authorName: "匿名",
        authorBadge: null,
        answerCount: "278",
        followCount: null,
        avatarDataUri: null,
      },
    },
    "三个方法",
  )[0];
  equal(
    partialMetaSvg?.svg.includes("知乎 · 278 个回答</text>"),
    true,
    "a missing follow count should end the meta line at the answer count",
  );
  equal(
    partialMetaSvg?.svg.includes('clip-path="url(#cover-avatar-clip)"'),
    false,
    "a missing avatar should fall back to the initial placeholder",
  );

  const legacyCoverSvg = renderSummarySvgCards(validSummary, "三个方法")[0];
  equal(
    legacyCoverSvg?.svg.includes(">知乎</text>"),
    true,
    "a cover without page metadata should keep the plain source meta line",
  );
  equal(
    legacyCoverSvg?.svg.includes("知乎 · 内容创作"),
    false,
    "tags should not be duplicated in the meta line when chips show them",
  );
  equal(
    legacyCoverSvg?.svg.includes("+ 关注"),
    false,
    "a cover without page metadata should not render the author block",
  );
  equal(
    legacyCoverSvg?.svg.includes("第一页正文内容从这里开始"),
    false,
    "cover should never repeat body text shown on the first body card",
  );
  equal(
    legacyCoverSvg?.svg.includes('fill="#F6F6F6"'),
    true,
    "a cover without page metadata should fill the footer with tag chips",
  );
  equal(
    metaCoverSvg?.svg.includes('fill="#F6F6F6"'),
    false,
    "a cover with an author block should not render tag chips",
  );

  const escapedAuthorSvg = renderSummarySvgCards(
    {
      ...metaSummary,
      coverMeta: { ...metaSummary.coverMeta!, authorName: "摸鱼 & <作家>" },
    },
    "三个方法",
  )[0];
  equal(
    escapedAuthorSvg?.svg.includes("摸鱼 &amp; &lt;作家&gt;"),
    true,
    "cover should XML-escape the author name",
  );

  const svgOutputDirectory = await mkdtemp(join(tmpdir(), "zhihu-video-svg-"));
  try {
    const writtenCards = await writeSummarySvgCards(
      svgOutputDirectory,
      validSummary,
      "三个方法",
    );
    equal(writtenCards.length, 4, "every card should be written to disk");
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
    const pngProgress: Array<[number, number]> = [];
    const writtenPngCards = await writeSummaryPngCards(
      pngOutputDirectory,
      validSummary,
      "三个方法",
      (done, total) => {
        pngProgress.push([done, total]);
      },
    );
    equal(writtenPngCards.length, 4, "every SVG card should rasterize to PNG");
    equal(
      pngProgress.length,
      4,
      "the PNG writer should report progress for every card",
    );
    deepEqual(
      pngProgress.map(([, total]) => total),
      [4, 4, 4, 4],
      "each progress callback should carry the full card count",
    );
    deepEqual(
      pngProgress.map(([done]) => done).sort((a, b) => a - b),
      [1, 2, 3, 4],
      "progress should advance exactly once per written card",
    );
    equal(
      pngProgress.at(-1)?.[0],
      4,
      "the final progress report should complete the set",
    );
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
    10,
    "duration should be cover 1s + body pages 3s each (default)",
  );
  const command = buildFfmpegVideoCommand(
    cards,
    ["cover.png", "01.png", "02.png", "03.png"],
    "video.mp4",
  );
  equal(
    command.durationSeconds,
    10,
    "FFmpeg command should report the calculated duration",
  );
  equal(
    command.executable,
    "ffmpeg",
    "FFmpeg should remain an external executable adapter",
  );
  equal(
    command.args.filter((argument) => argument === "-loop").length,
    4,
    "each still image should be looped independently",
  );
  equal(
    command.args.includes("3"),
    true,
    "body cards should be rendered for three seconds by default",
  );
  throws(
    () => buildFfmpegVideoCommand(cards, ["cover.png"], "video.mp4"),
    "mismatched images should fail before FFmpeg is invoked",
  );
  throws(
    () =>
      buildFfmpegVideoCommand(
        cards.slice(1),
        ["01.png", "02.png", "03.png"],
        "video.mp4",
      ),
    "a video without a cover should fail before FFmpeg is invoked",
  );

  const musicCommand = buildFfmpegVideoCommand(
    cards,
    ["cover.png", "01.png", "02.png", "03.png"],
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
      "[4:a]atrim=0:10,asetpts=PTS-STARTPTS,volume=0.3,afade=t=out:st=9:d=1[a]",
    ),
    true,
    "the audio filter should trim to video length, apply volume and a trailing fade-out",
  );
  equal(
    buildFfmpegVideoCommand(
      cards,
      ["cover.png", "01.png", "02.png", "03.png"],
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
      2,
      "a short article should expose cover and one body page with CTA overlay",
    );
    equal(
      readyVideo.cards.at(-1)?.kind,
      "body",
      "even a short article must end on a body card with CTA overlay",
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

  // ── Custom body-page dwell time ─────────────────────────────────────
  equal(durationForCard("cover"), 1, "the cover defaults to one second");
  equal(
    durationForCard("cover", { coverPageDurationSeconds: 3 }),
    3,
    "the cover should honour the configured cover dwell time",
  );
  equal(
    durationForCard("body", { bodyPageDurationSeconds: 4 }),
    4,
    "body pages should honour the configured dwell time",
  );
  equal(
    durationForCard("body", { bodyPageDurationSeconds: -1 }),
    3,
    "non-positive durations should fall back to three seconds",
  );
  equal(
    durationForCard("body", { bodyPageDurationSeconds: Number.NaN }),
    3,
    "non-finite durations should fall back to three seconds",
  );
  equal(
    totalVideoDuration(cards, { bodyPageDurationSeconds: 4 }),
    13,
    "a 4s body dwell time should yield cover 1 + 3×4",
  );
  equal(
    totalVideoDuration(cards, {
      coverPageDurationSeconds: 2,
      bodyPageDurationSeconds: 5,
    }),
    17,
    "cover 2 + 3×5 = 17",
  );

  const customDurationCommand = buildFfmpegVideoCommand(
    cards,
    ["cover.png", "01.png", "02.png", "03.png"],
    "video.mp4",
    undefined,
    { coverPageDurationSeconds: 2, bodyPageDurationSeconds: 4 },
  );
  equal(
    customDurationCommand.durationSeconds,
    14,
    "the FFmpeg command should honour the custom timing options",
  );
  const dwellTimes: string[] = [];
  customDurationCommand.args.forEach((argument, index) => {
    if (argument === "-t") {
      dwellTimes.push(customDurationCommand.args[index + 1]!);
    }
  });
  deepEqual(
    dwellTimes,
    ["2", "4", "4", "4"],
    "per-image dwell times should be cover 2s, body 4s each",
  );

  // ── Full-content output mode ────────────────────────────────────────
  const unlimitedPages = validateVideoSummary(
    {
      ...validSummary,
      pages: Array.from({ length: 11 }, (_, index) => ({
        body: `第${index + 1}页正文内容，全文输出模式取消了十页上限，每一页都需要超过三十八个字符才能通过校验，因此多写一些。`,
        sourceRefs: [index + 1],
      })),
    },
    { hasVerifiedKeyword: true, allowUnlimitedPages: true },
  );
  equal(
    unlimitedPages.status,
    "ready",
    "allowUnlimitedPages should lift the ten-page cap",
  );

  const longArticleParagraphs = Array.from(
    { length: 36 },
    (_, index) =>
      `第${index + 1}段：${"全文输出模式要求分页器完整保留每一段正文内容，不允许截断。".repeat(3)}`,
  );
  const longArticleReader = {
    read: async () =>
      ({
        ok: true,
        content: {
          title: "长文章标题",
          paragraphs: longArticleParagraphs,
        },
      }) as const,
  };
  const longArticleGenerator = {
    summarize: async () => ({
      videoTitle: "长文章的完整输出",
      tags: ["全文", "测试"],
    }),
  };

  const cappedVideo = await buildPreparedVideo(
    {
      sourceUrl: "https://zhuanlan.zhihu.com/p/999",
      sourceType: "article",
      articleKeyword: "全文口令",
    },
    { reader: longArticleReader, generator: longArticleGenerator },
  );
  equal(
    cappedVideo.kind,
    "ready",
    "a long article should still be ready in default mode",
  );
  if (cappedVideo.kind === "ready") {
    equal(
      cappedVideo.summary.pages.length,
      10,
      "default mode should cap the body at ten pages",
    );
    equal(
      cappedVideo.summary.truncated,
      true,
      "default mode should flag the overflow as truncated",
    );
  }

  const fullContentVideo = await buildPreparedVideo(
    {
      sourceUrl: "https://zhuanlan.zhihu.com/p/999",
      sourceType: "article",
      articleKeyword: "全文口令",
      fullContentOutput: true,
    },
    { reader: longArticleReader, generator: longArticleGenerator },
  );
  equal(
    fullContentVideo.kind,
    "ready",
    "full-content mode should lift the page cap instead of entering review",
  );
  if (fullContentVideo.kind === "ready") {
    equal(
      fullContentVideo.summary.pages.length > 10,
      true,
      "full-content mode should keep every paginated body page",
    );
    equal(
      fullContentVideo.summary.truncated,
      false,
      "full-content mode should never mark the article as truncated",
    );
    equal(
      fullContentVideo.cards.length,
      fullContentVideo.summary.pages.length + 1,
      "the card sequence should be cover + every body page (CTA on last)",
    );
    equal(
      fullContentVideo.cards[0]?.kind,
      "cover",
      "the full-content video should still open with the cover",
    );
    equal(
      fullContentVideo.cards.at(-1)?.kind,
      "body",
      "the full-content video should end with a body card with CTA overlay",
    );
  }

  // ─── Scroll speed mapping ───────────────────────────────────────────────
  equal(scrollSpeedToPixelsPerSecond(1), 40, "speed 1 should map to 40 px/s");
  equal(scrollSpeedToPixelsPerSecond(2), 60, "speed 2 should map to 60 px/s");
  equal(scrollSpeedToPixelsPerSecond(3), 80, "speed 3 should map to 80 px/s");
  equal(scrollSpeedToPixelsPerSecond(4), 100, "speed 4 should map to 100 px/s");
  equal(scrollSpeedToPixelsPerSecond(5), 120, "speed 5 should map to 120 px/s");
  equal(
    scrollSpeedToPixelsPerSecond(0),
    40,
    "speed below 1 should clamp to 40 px/s",
  );
  equal(
    scrollSpeedToPixelsPerSecond(10),
    120,
    "speed above 5 should clamp to 120 px/s",
  );

  // ─── Zhihu scroll strip rendering ──────────────────────────────────────
  const stripResult = renderZhihuScrollStrip({
    sourceTitle: "如何理解强化学习",
    paragraphs: ["第一段内容测试。", "第二段内容测试。", "第三段内容测试。"],
    meta: {
      authorName: "测试作者",
      authorBadge: "优秀答主",
      answerCount: "123",
      followCount: "456",
      avatarDataUri: null,
    },
    tags: ["AI", "强化学习"],
    fullContentOutput: false,
    tailNote: "来知乎搜索🔍强化学习可以看到全文",
  });
  equal(
    stripResult.width,
    SCROLL_STRIP_WIDTH,
    "scroll strip width should be 1080",
  );
  equal(stripResult.height > 0, true, "scroll strip height should be positive");
  equal(
    stripResult.svg.includes("如何理解强化学习"),
    true,
    "scroll strip should contain the source title",
  );
  equal(
    stripResult.svg.includes("测试作者"),
    true,
    "scroll strip should contain the author name",
  );
  equal(
    stripResult.svg.includes("123 个回答"),
    true,
    "scroll strip should contain the answer count",
  );
  equal(
    stripResult.svg.includes("456 个关注"),
    true,
    "scroll strip should contain the follow count",
  );
  equal(
    stripResult.svg.includes("第一段内容测试。"),
    true,
    "scroll strip should contain body paragraphs",
  );
  equal(
    stripResult.svg.includes("节选于知乎"),
    true,
    "scroll strip should contain the attribution footer",
  );
  equal(
    stripResult.svg.includes("来知乎搜索强化学习可以看到全文"),
    true,
    "scroll strip should place the verified keyword on its final reading page",
  );
  equal(
    stripResult.svg.includes("🔍"),
    false,
    "tail artwork should keep the visual prompt focused on its keyword",
  );

  const readingPagesDirectory = await mkdtemp(
    join(tmpdir(), "zhihu-reading-pages-"),
  );
  try {
    const readingPages = await writeZhihuReadingPagePngs(
      readingPagesDirectory,
      {
        sourceTitle: "如何理解强化学习",
        paragraphs: Array.from(
          { length: 30 },
          (_, index) =>
            `第${index + 1}段内容测试，用于生成连续的知乎阅读页截图。`,
        ),
        meta: null,
        tags: [],
        fullContentOutput: false,
        tailNote: "来知乎搜索🔍强化学习可以看到全文",
      },
      null,
    );
    equal(
      readingPages.pagePaths.length > 1,
      true,
      "long reading content should be split into source-page screenshots",
    );
    equal(
      readingPages.pagePaths[0]?.endsWith("01-reading.png"),
      true,
      "reading-page screenshots should keep a stable order",
    );
    const firstPage = await readFile(readingPages.pagePaths[0]!);
    deepEqual(
      [...firstPage.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      "reading-page screenshots should be PNG files",
    );
  } finally {
    await rm(readingPagesDirectory, { recursive: true, force: true });
  }

  // Truncation: many paragraphs without fullContentOutput
  const longParagraphs = Array.from(
    { length: 200 },
    (_, i) => `第${i + 1}段很长的内容，用于测试截断逻辑是否正常工作。`,
  );
  const truncatedStrip = renderZhihuScrollStrip({
    sourceTitle: "超长文章",
    paragraphs: longParagraphs,
    meta: null,
    tags: [],
    fullContentOutput: false,
  });
  equal(
    truncatedStrip.svg.includes("……"),
    true,
    "truncated scroll strip should end with an ellipsis",
  );

  // Full content mode: no truncation
  const fullStrip = renderZhihuScrollStrip({
    sourceTitle: "超长文章",
    paragraphs: longParagraphs,
    meta: null,
    tags: [],
    fullContentOutput: true,
  });
  equal(
    fullStrip.height > truncatedStrip.height,
    true,
    "full-content scroll strip should be taller than truncated",
  );

  // ─── Bottom bar rendering ──────────────────────────────────────────────
  const barSvg = renderBottomBar({
    authorName: "作者",
    authorBadge: null,
    answerCount: null,
    followCount: null,
    avatarDataUri: null,
  });
  equal(
    barSvg.includes("作"),
    true,
    "bottom bar should render the author initial when no avatar",
  );
  equal(
    barSvg.includes("+ 关注"),
    true,
    "bottom bar should include the follow button",
  );
  equal(
    barSvg.includes("▲"),
    true,
    "bottom bar should include interaction icons",
  );

  // ─── FFmpeg scroll overlay command ─────────────────────────────────────
  const overlayCmd = buildFfmpegScrollOverlayCommand(
    "/tmp/strip.png",
    10000,
    "/tmp/bar.png",
    "/tmp/video.mp4",
    1,
  );
  equal(overlayCmd.executable, "ffmpeg", "overlay command should use ffmpeg");
  equal(
    overlayCmd.durationSeconds > 0,
    true,
    "overlay command should have positive duration",
  );
  equal(
    overlayCmd.args.includes("-loop"),
    true,
    "overlay command should loop the input",
  );
  const filterArg = overlayCmd.args.find((a) => a.includes("crop="));
  equal(
    filterArg !== undefined,
    true,
    "overlay command should include a crop filter",
  );
  equal(
    filterArg?.includes("1780"),
    true,
    "overlay crop viewport should be 1780px",
  );
  equal(
    filterArg?.includes("pad=1080:1920"),
    true,
    "overlay should pad the canvas to 1920px height",
  );
  const overlayArg = overlayCmd.args.find((a) => a.includes("overlay="));
  equal(
    overlayArg !== undefined,
    true,
    "overlay command should include an overlay filter",
  );
  equal(
    overlayArg?.includes("overlay=0:1780"),
    true,
    "overlay should position the bar at y=1780",
  );
  equal(
    overlayArg?.includes("format=yuv420p"),
    true,
    "overlay output should include format=yuv420p for libx264",
  );
}
