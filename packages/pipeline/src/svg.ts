import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

import {
  buildCardSequence,
  cardCanvas,
  cardHeights,
  type CardRenderModel,
  type CardRenderOptions,
} from "./cards.js";
import type { VideoSummary } from "./summary.js";

export interface SvgCard {
  card: CardRenderModel;
  filename: string;
  svg: string;
}

export interface WrittenSvgCard extends SvgCard {
  outputPath: string;
}

export interface WrittenPngCard extends SvgCard {
  outputPath: string;
}

/**
 * Escapes text nodes while retaining Unicode, so Chinese characters are not
 * converted into numeric entities and can use the host's CJK font fallback.
 */
export function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The page number makes output names stable across repeated renders. */
export function svgCardFilename(card: CardRenderModel): string {
  const page = String(card.pageNumber).padStart(
    String(card.totalPages).length,
    "0",
  );
  return `${page}-${card.kind}.svg`;
}

export function renderSvgCard(card: CardRenderModel): string {
  const content = card.kind === "cover" ? renderCover(card) : renderBody(card);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${card.canvas.width}" height="${card.canvas.height}" viewBox="0 0 ${card.canvas.width} ${card.canvas.height}" role="img">`,
    "<style>text { font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif; }</style>",
    content,
    "</svg>",
  ].join("\n");
}

/**
 * Builds SVGs directly from the validated summary. `keyword` is the verified
 * Zhihu search phrase interpolated into the fixed tail-page copy.
 */
export function renderSummarySvgCards(
  summary: VideoSummary,
  keyword: string,
  options?: CardRenderOptions | string, // allow legacy tailTemplate arg
  tailTemplate?: string,
): SvgCard[];

export function renderSummarySvgCards(
  summary: VideoSummary,
  keyword: string,
  options?: CardRenderOptions | string,
  tailTemplate?: string,
): SvgCard[] {
  return buildCardSequence(summary, keyword, options, tailTemplate).map(
    (card) => ({
      card,
      filename: svgCardFilename(card),
      svg: renderSvgCard(card),
    }),
  );
}

export async function writeSummarySvgCards(
  outputDirectory: string,
  summary: VideoSummary,
  keyword: string,
  options?: CardRenderOptions | string, // allow legacy tailTemplate arg
  tailTemplate?: string,
): Promise<WrittenSvgCard[]> {
  const cards = renderSummarySvgCards(summary, keyword, options, tailTemplate);
  await mkdir(outputDirectory, { recursive: true });

  return Promise.all(
    cards.map(async (card) => {
      const outputPath = join(outputDirectory, card.filename);
      await writeFile(outputPath, card.svg, "utf8");
      return { ...card, outputPath };
    }),
  );
}

/**
 * Renders the same static SVG artwork as 1080×1920 PNG files. Sharp is used
 * instead of relying on a host FFmpeg build having optional SVG decoding.
 * `onCardWritten` reports (done, total) so callers can stream progress.
 */
export async function writeSummaryPngCards(
  outputDirectory: string,
  summary: VideoSummary,
  keyword: string,
  onCardWritten?: (done: number, total: number) => void,
  options?: CardRenderOptions | string, // allow legacy tailTemplate arg
  tailTemplate?: string,
): Promise<WrittenPngCard[]> {
  const cards = renderSummarySvgCards(summary, keyword, options, tailTemplate);
  await mkdir(outputDirectory, { recursive: true });

  let done = 0;
  return Promise.all(
    cards.map(async (card) => {
      const outputPath = join(
        outputDirectory,
        card.filename.replace(/\.svg$/, ".png"),
      );
      await sharp(Buffer.from(card.svg, "utf8"))
        .resize(card.card.canvas.width, card.card.canvas.height, {
          fit: "fill",
        })
        .png()
        .toFile(outputPath);
      done += 1;
      onCardWritten?.(done, cards.length);
      return { ...card, outputPath };
    }),
  );
}

/**
 * Export PNG cards at a specific aspect ratio with optional button hiding.
 * This is the entry point for download features (3:4 or 9:16).
 */
export async function writePngCardsAtRatio(
  outputDirectory: string,
  summary: VideoSummary,
  keyword: string,
  ratio: "9:16" | "3:4",
  hideInteractionButtons?: boolean,
  tailTemplate?: string,
): Promise<WrittenPngCard[]> {
  const opts: CardRenderOptions = {
    height: cardHeights[ratio],
    hideInteractionButtons,
  };
  return writeSummaryPngCards(
    outputDirectory,
    summary,
    keyword,
    undefined,
    opts,
    tailTemplate,
  );
}

/**
 * Pure title card: no body text, so the first body card never repeats the
 * cover. The title block is vertically centered between the top margin and
 * the footer band (author block or tag chips), so short titles and missing
 * author metadata never leave the canvas looking half-empty.
 */
function renderCover(
  card: Extract<CardRenderModel, { kind: "cover" }>,
): string {
  const titleLines = wrapText(card.title, 13, 4);
  const metaLine = coverMetaLine(card);
  const showAuthor = Boolean(card.meta?.authorName?.trim());

  const canvasHeight = card.canvas.height;
  // Calculate layout based on canvas height (9:16 vs 3:4)
  const zoneTop = Math.round(0.15 * canvasHeight); // 15% from top
  const footerTop = Math.round(0.85 * canvasHeight); // 85% from top
  const zoneBottom = footerTop - Math.round(0.05 * canvasHeight);
  const titleLineHeight = Math.round(0.058 * canvasHeight);
  const titleToMetaGap = Math.round(0.03 * canvasHeight);
  const metaFontSize = Math.round(0.021 * canvasHeight);
  const blockHeight =
    titleLines.length * titleLineHeight + titleToMetaGap + metaFontSize;
  const titleY =
    zoneTop + Math.max(0, Math.round((zoneBottom - zoneTop - blockHeight) / 2));
  const metaY = titleY + titleLines.length * titleLineHeight + titleToMetaGap;

  const opts = card.opts ?? {};
  const hideButtons = opts.hideInteractionButtons ?? false;

  const parts = [
    `<rect width="${card.canvas.width}" height="${canvasHeight}" fill="#FFFFFF"/>`,
    // Zhihu-blue accent bar floating above the title block.
    `<rect x="90" y="${titleY - 100}" width="72" height="10" rx="5" fill="#056DE8"/>`,
    svgText(titleLines, {
      x: 90,
      y: titleY,
      fontSize: 76,
      lineHeight: titleLineHeight,
      fill: "#111111",
      weight: 700,
    }),
    `<text x="90" y="${metaY}" fill="#8590A6" font-size="${metaFontSize}">${escapeSvgText(metaLine)}</text>`,
  ];

  // Footer band: the author block mirrors Zhihu's question header when the
  // reader captured an author; otherwise tags render as chips filling the
  // same band so the bottom of the card is never blank.
  if (showAuthor && card.meta) {
    parts.push(renderAuthorBlock(card.meta, footerTop, hideButtons));
  } else {
    const chips = renderTagChips(card.tags, footerTop);
    if (chips) parts.push(chips);
  }
  return parts.join("\n");
}

/**
 * Rounded tag chips anchored to the cover footer when no author is shown.
 * Tags are capped at 12 characters so a single chip (≤504px) can never
 * overflow the 90→990 content column.
 */
function renderTagChips(tags: string[], top: number): string {
  const parts: string[] = [];
  let x = 90;
  let row = 0;
  for (const rawTag of tags) {
    const tag = Array.from(rawTag.trim()).slice(0, 12).join("");
    if (!tag) continue;
    const chipWidth = Array.from(tag).length * 38 + 48;
    if (x + chipWidth > 990) {
      row += 1;
      x = 90;
      if (row > 1) break;
    }
    const y = top + 12 + row * 84;
    parts.push(
      `<rect x="${x}" y="${y}" width="${chipWidth}" height="64" rx="32" fill="#F6F6F6"/>`,
      `<text x="${x + chipWidth / 2}" y="${y + 43}" text-anchor="middle" fill="#444444" font-size="34">${escapeSvgText(tag)}</text>`,
    );
    x += chipWidth + 20;
  }
  return parts.join("\n");
}

/**
 * "知乎 · N 个回答 · M 关注" when counters exist, else just "知乎" — tags
 * live only in the footer chips so they never appear twice on one cover.
 */
function coverMetaLine(
  card: Extract<CardRenderModel, { kind: "cover" }>,
): string {
  const segments: string[] = [card.sourceLabel];
  if (card.meta?.answerCount?.trim()) {
    segments.push(`${card.meta.answerCount.trim()} 个回答`);
  }
  if (card.meta?.followCount?.trim()) {
    segments.push(`${card.meta.followCount.trim()} 关注`);
  }
  return segments.filter((item) => item.trim().length > 0).join(" · ");
}

/** Zhihu-style author row: 88px avatar, name/badge, decorative follow pill. */
function renderAuthorBlock(
  meta: NonNullable<Extract<CardRenderModel, { kind: "cover" }>["meta"]>,
  top: number,
  hideButtons?: boolean,
): string {
  const centerY = top + 44;
  const parts: string[] = [
    `<clipPath id="cover-avatar-clip"><circle cx="134" cy="${centerY}" r="44"/></clipPath>`,
  ];
  if (meta.avatarDataUri) {
    parts.push(
      `<image href="${escapeSvgText(meta.avatarDataUri)}" x="90" y="${top}" width="88" height="88" preserveAspectRatio="xMidYMid slice" clip-path="url(#cover-avatar-clip)"/>`,
    );
  } else {
    const initial = wrapText(meta.authorName ?? "知", 1, 1)[0] ?? "知";
    parts.push(
      `<circle cx="134" cy="${centerY}" r="44" fill="#EBEBEB"/>`,
      `<text x="134" y="${centerY + 16}" text-anchor="middle" fill="#8590A6" font-size="44" font-weight="600">${escapeSvgText(initial)}</text>`,
    );
  }

  const authorName = wrapText((meta.authorName ?? "").trim(), 12, 1)[0] ?? "";
  parts.push(
    `<text x="206" y="${top + 38}" fill="#111111" font-size="40" font-weight="600">${escapeSvgText(authorName)}</text>`,
  );
  const badge = (meta.authorBadge ?? "").trim();
  if (badge) {
    parts.push(
      `<text x="206" y="${top + 84}" fill="#8590A6" font-size="30">${escapeSvgText(wrapText(badge, 16, 1)[0] ?? "")}</text>`,
    );
  }
  // Hide the decorative "+关注" button when requested
  if (!hideButtons) {
    parts.push(
      `<rect x="822" y="${top + 12}" width="168" height="64" rx="32" fill="#ECF5FF"/>`,
      `<text x="906" y="${top + 55}" text-anchor="middle" fill="#056DE8" font-size="32" font-weight="600">+ 关注</text>`,
    );
  }
  return parts.join("\n");
}

function renderBody(card: Extract<CardRenderModel, { kind: "body" }>): string {
  // The body is already paginated into wrapped lines (with blank spacer lines
  // separating paragraphs), so it renders verbatim without re-wrapping.
  const bodyLines = card.body.split("\n");
  const canvasHeight = card.canvas.height;

  // CTA metrics scale with the canvas height so 9:16 and 3:4 exports keep the
  // same visual hierarchy.
  const ctaLineHeight = Math.round(0.06 * canvasHeight);
  const ctaFontSize = Math.round(0.04 * canvasHeight);
  const ctaYOffset = Math.round(0.08 * canvasHeight); // padding from top

  const parts = [
    `<rect width="${card.canvas.width}" height="${canvasHeight}" fill="#FFFFFF"/>`,
    svgText(bodyLines, {
      x: 90,
      y: ctaYOffset,
      fontSize: 48,
      lineHeight: 82,
      fill: "#1A1A1A",
      weight: 400,
    }),
  ];

  // CTA overlay: yellow bold text centered on the card with a semi-transparent
  // dark backdrop for readability against the black body text.
  if (card.ctaOverlay) {
    const ctaLines = wrapText(card.ctaOverlay, 14, 3);
    const blockHeight = ctaLines.length * ctaLineHeight + 40;
    const blockTop = (canvasHeight - blockHeight) / 2;
    parts.push(
      `<rect x="60" y="${blockTop}" width="960" height="${blockHeight}" rx="24" fill="rgba(0,0,0,0.72)"/>`,
      svgText(ctaLines, {
        x: 540,
        y: blockTop + 52,
        fontSize: ctaFontSize,
        lineHeight: ctaLineHeight,
        fill: "#FFD700",
        weight: 700,
        anchor: "middle",
      }),
    );
  }
  return parts.join("\n");
}

interface TextLayout {
  x: number;
  y: number;
  fontSize: number;
  lineHeight: number;
  fill: string;
  weight: number;
  anchor?: "start" | "middle" | "end";
}

function svgText(lines: string[], layout: TextLayout): string {
  const anchor = layout.anchor ? ` text-anchor="${layout.anchor}"` : "";
  // librsvg does not advance the baseline for an empty <tspan>, so a blank
  // spacer line is folded into the next visible line's dy to yield real
  // paragraph spacing instead of a collapsed gap.
  const spans: string[] = [];
  let pendingLineHeight = 0;
  let isFirstSpan = true;
  for (const line of lines) {
    if (line === "") {
      pendingLineHeight += layout.lineHeight;
      continue;
    }
    const dy = isFirstSpan ? 0 : pendingLineHeight + layout.lineHeight;
    spans.push(
      `<tspan x="${layout.x}" dy="${dy}">${escapeSvgText(line)}</tspan>`,
    );
    isFirstSpan = false;
    pendingLineHeight = 0;
  }
  return `<text x="${layout.x}" y="${layout.y}"${anchor} fill="${layout.fill}" font-size="${layout.fontSize}" font-weight="${layout.weight}">${spans.join("")}</text>`;
}

function wrapText(
  text: string,
  maxCharacters: number,
  maxLines: number,
): string[] {
  const characters = Array.from(text.replace(/\r\n?/g, "\n"));
  const lines: string[] = [];
  let line = "";

  for (const character of characters) {
    if (character === "\n" || Array.from(line).length >= maxCharacters) {
      if (line) lines.push(line);
      line = "";
      if (lines.length === maxLines) break;
      if (character === "\n") continue;
    }
    line += character;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.length > 0 ? lines : [""];
}
