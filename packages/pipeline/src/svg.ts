import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

import {
  buildCardSequence,
  cardCanvas,
  type CardRenderModel,
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
  const content =
    card.kind === "cover"
      ? renderCover(card)
      : card.kind === "body"
        ? renderBody(card)
        : renderTail(card);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cardCanvas.width}" height="${cardCanvas.height}" viewBox="0 0 ${cardCanvas.width} ${cardCanvas.height}" role="img">`,
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
): SvgCard[] {
  return buildCardSequence(summary, keyword).map((card) => ({
    card,
    filename: svgCardFilename(card),
    svg: renderSvgCard(card),
  }));
}

export async function writeSummarySvgCards(
  outputDirectory: string,
  summary: VideoSummary,
  keyword: string,
): Promise<WrittenSvgCard[]> {
  const cards = renderSummarySvgCards(summary, keyword);
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
): Promise<WrittenPngCard[]> {
  const cards = renderSummarySvgCards(summary, keyword);
  await mkdir(outputDirectory, { recursive: true });

  let done = 0;
  return Promise.all(
    cards.map(async (card) => {
      const outputPath = join(
        outputDirectory,
        card.filename.replace(/\.svg$/, ".png"),
      );
      await sharp(Buffer.from(card.svg, "utf8"))
        .resize(cardCanvas.width, cardCanvas.height, { fit: "fill" })
        .png()
        .toFile(outputPath);
      done += 1;
      onCardWritten?.(done, cards.length);
      return { ...card, outputPath };
    }),
  );
}

function renderCover(
  card: Extract<CardRenderModel, { kind: "cover" }>,
): string {
  const titleLines = wrapText(card.title, 14, 3);
  const metaLine = coverMetaLine(card);
  const metaY = 240 + titleLines.length * 96 + 40;
  const parts = [
    '<rect width="1080" height="1920" fill="#FFFFFF"/>',
    svgText(titleLines, {
      x: 90,
      y: 240,
      fontSize: 64,
      lineHeight: 96,
      fill: "#111111",
      weight: 700,
    }),
    `<text x="90" y="${metaY}" fill="#8590A6" font-size="36">${escapeSvgText(metaLine)}</text>`,
  ];

  // The author block mirrors Zhihu's question header: avatar, name + badge,
  // and a decorative follow pill. It only renders when the reader captured
  // an author name; otherwise the legacy layout positions are untouched.
  const showAuthor = Boolean(card.meta?.authorName?.trim());
  const dividerY = showAuthor ? metaY + 56 + 88 + 40 : metaY + 44;
  if (showAuthor && card.meta) {
    parts.push(renderAuthorBlock(card.meta, metaY + 56));
  }
  if (card.preview.length > 0) {
    parts.push(
      `<line x1="90" y1="${dividerY}" x2="990" y2="${dividerY}" stroke="#EBEBEB" stroke-width="2"/>`,
      svgText(card.preview, {
        x: 90,
        y: dividerY + 66,
        fontSize: 48,
        lineHeight: 82,
        fill: "#1A1A1A",
        weight: 400,
      }),
    );
  }
  return parts.join("\n");
}

/** "知乎 · N 个回答 · M 关注" when counters exist, else the tags line. */
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
  if (segments.length === 1) {
    segments.push(...card.tags);
  }
  return segments.filter((item) => item.trim().length > 0).join(" · ");
}

/** Zhihu-style author row: 88px avatar, name/badge, decorative follow pill. */
function renderAuthorBlock(
  meta: NonNullable<Extract<CardRenderModel, { kind: "cover" }>["meta"]>,
  top: number,
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
  parts.push(
    `<rect x="822" y="${top + 12}" width="168" height="64" rx="32" fill="#ECF5FF"/>`,
    `<text x="906" y="${top + 55}" text-anchor="middle" fill="#056DE8" font-size="32" font-weight="600">+ 关注</text>`,
  );
  return parts.join("\n");
}

function renderBody(card: Extract<CardRenderModel, { kind: "body" }>): string {
  // The body is already paginated into wrapped lines (with blank spacer lines
  // separating paragraphs), so it renders verbatim without re-wrapping.
  const bodyLines = card.body.split("\n");
  return [
    '<rect width="1080" height="1920" fill="#FFFFFF"/>',
    svgText(bodyLines, {
      x: 90,
      y: 150,
      fontSize: 48,
      lineHeight: 82,
      fill: "#1A1A1A",
      weight: 400,
    }),
  ].join("\n");
}

function renderTail(card: Extract<CardRenderModel, { kind: "tail" }>): string {
  // A truncated article warns the viewer the excerpt is partial; a fully shown
  // article invites them to find more from the author instead.
  const leadLine = card.truncated ? "原文较长，以上为节选" : "全文完";
  const cta = card.truncated
    ? `来知乎搜索「${card.keyword}」看全文`
    : `来知乎搜索「${card.keyword}」看更多`;
  const keywordLines = wrapText(cta, 14, 2);
  return [
    '<rect width="1080" height="1920" fill="#FFFFFF"/>',
    '<g transform="rotate(-6 540 960)">',
    `<text x="540" y="800" text-anchor="middle" fill="#D95D39" font-size="52" font-weight="700">${escapeSvgText(leadLine)}</text>`,
    svgText(keywordLines, {
      x: 540,
      y: 940,
      fontSize: 64,
      lineHeight: 104,
      fill: "#D95D39",
      weight: 700,
      anchor: "middle",
    }),
    "</g>",
  ].join("\n");
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
