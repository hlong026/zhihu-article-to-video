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
 */
export async function writeSummaryPngCards(
  outputDirectory: string,
  summary: VideoSummary,
  keyword: string,
): Promise<WrittenPngCard[]> {
  const cards = renderSummarySvgCards(summary, keyword);
  await mkdir(outputDirectory, { recursive: true });

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
      return { ...card, outputPath };
    }),
  );
}

function renderCover(
  card: Extract<CardRenderModel, { kind: "cover" }>,
): string {
  const titleLines = wrapText(card.title, 14, 2);
  const metaLine = [card.sourceLabel, ...card.tags]
    .filter((item) => item.trim().length > 0)
    .join(" \u00b7 ");
  const metaY = 240 + titleLines.length * 96 + 40;
  const previewY = metaY + 110;
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
  if (card.preview.length > 0) {
    parts.push(
      `<line x1="90" y1="${metaY + 44}" x2="990" y2="${metaY + 44}" stroke="#EBEBEB" stroke-width="2"/>`,
      svgText(card.preview, {
        x: 90,
        y: previewY,
        fontSize: 48,
        lineHeight: 82,
        fill: "#1A1A1A",
        weight: 400,
      }),
    );
  }
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
