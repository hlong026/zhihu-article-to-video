/**
 * Renders a Zhihu mobile answer-page simulation as a single tall SVG strip.
 * Used exclusively by the vertical-scroll video mode: the strip is rasterized
 * to one PNG, then FFmpeg crops a moving viewport over it while a fixed
 * bottom interaction bar is overlaid separately.
 */
import type { SourcePageMeta } from "./source.js";
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// ─── Layout constants ────────────────────────────────────────────────────────

export const SCROLL_STRIP_WIDTH = 1080;
/** Height of the fixed bottom interaction bar rendered as a separate image. */
export const BOTTOM_BAR_HEIGHT = 140;
/** Visible scroll viewport height = 1920 - bottom bar. */
export const SCROLL_VIEWPORT_HEIGHT = 1920 - BOTTOM_BAR_HEIGHT;

const CONTENT_LEFT = 72;
const CONTENT_RIGHT = 1008;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

const BODY_FONT_SIZE = 46;
const BODY_LINE_HEIGHT = 78;
const BODY_CHAR_UNITS = 20; // wide-char slots per line (each CJK = 2 units → ~20 chars)

const HEADER_PADDING_TOP = 60;
const TITLE_FONT_SIZE = 54;
const TITLE_LINE_HEIGHT = 76;

const AUTHOR_BLOCK_HEIGHT = 160;
const AUTHOR_PADDING_TOP = 32;

const FOOTER_PADDING = 80;
const FOOTER_FONT_SIZE = 34;
/** Keeps the tail prompt in the lower half of the final 9:16 screenshot. */
const TAIL_NOTE_SECTION_HEIGHT = 720;

/** Maximum body lines when fullContentOutput is off (~3000 chars). */
const MAX_BODY_LINES_CAPPED = 120;
/** Maximum body lines even with fullContentOutput (prevents OOM on very long articles). */
const MAX_BODY_LINES_FULL = 500;

// ─── Public interface ────────────────────────────────────────────────────────

export interface ZhihuScrollRenderInput {
  sourceTitle: string;
  paragraphs: string[];
  meta: SourcePageMeta | null;
  tags: string[];
  fullContentOutput: boolean;
  /** Attribution template; {title} is interpolated. */
  attributionTemplate?: string;
  /** Verified search prompt overlaid above the bottom bar on the final page. */
  tailNote?: string;
}

export interface ZhihuScrollRenderOutput {
  svg: string;
  width: number;
  height: number;
}

// ─── Main render function ────────────────────────────────────────────────────

export function renderZhihuScrollStrip(
  input: ZhihuScrollRenderInput,
): ZhihuScrollRenderOutput {
  const titleLines = wrapText(input.sourceTitle, 14, 6);
  const headerHeight =
    HEADER_PADDING_TOP +
    titleLines.length * TITLE_LINE_HEIGHT +
    48 + // meta line
    40; // bottom padding

  const authorHeight = input.meta?.authorName ? AUTHOR_BLOCK_HEIGHT : 0;

  // Wrap all paragraphs into body lines with blank spacers between paragraphs.
  const allBodyLines = wrapParagraphs(input.paragraphs);
  const maxLines = input.fullContentOutput
    ? MAX_BODY_LINES_FULL
    : MAX_BODY_LINES_CAPPED;
  const truncated = allBodyLines.length > maxLines;
  const bodyLines = truncated ? allBodyLines.slice(0, maxLines) : allBodyLines;
  if (truncated && bodyLines.length > 0) {
    bodyLines[bodyLines.length - 1] = bodyLines[bodyLines.length - 1] + "……";
  }

  const bodyHeight = bodyLines.length * BODY_LINE_HEIGHT + 60;

  // Attribution footer
  const attribution = buildAttribution(input);
  const footerHeight = FOOTER_PADDING + FOOTER_FONT_SIZE + FOOTER_PADDING;
  const tailNoteHeight = input.tailNote?.trim() ? TAIL_NOTE_SECTION_HEIGHT : 0;

  const totalHeight =
    headerHeight + authorHeight + bodyHeight + footerHeight + tailNoteHeight;

  // ─── Build SVG ───────────────────────────────────────────────────────────
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SCROLL_STRIP_WIDTH}" height="${totalHeight}" viewBox="0 0 ${SCROLL_STRIP_WIDTH} ${totalHeight}">`,
    "<style>text { font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif; }</style>",
    `<rect width="${SCROLL_STRIP_WIDTH}" height="${totalHeight}" fill="#FFFFFF"/>`,
  ];

  let y = HEADER_PADDING_TOP;

  // Question title
  parts.push(
    renderMultiLine(titleLines, {
      x: CONTENT_LEFT,
      y,
      fontSize: TITLE_FONT_SIZE,
      lineHeight: TITLE_LINE_HEIGHT,
      fill: "#111111",
      weight: 700,
    }),
  );
  y += titleLines.length * TITLE_LINE_HEIGHT + 16;

  // Meta line: "N 个回答 · M 个关注"
  const metaLine = buildMetaLine(input.meta);
  parts.push(
    `<text x="${CONTENT_LEFT}" y="${y + 34}" fill="#8590A6" font-size="32">${escapeSvg(metaLine)}</text>`,
  );
  y += 48 + 40;

  // Author block
  if (input.meta?.authorName) {
    parts.push(renderAuthorBlock(input.meta, y));
    y += AUTHOR_BLOCK_HEIGHT;
  }

  // Separator line
  parts.push(
    `<line x1="${CONTENT_LEFT}" y1="${y}" x2="${CONTENT_RIGHT}" y2="${y}" stroke="#F0F0F0" stroke-width="1"/>`,
  );
  y += 30;

  // Body text
  parts.push(renderBodyLines(bodyLines, y));
  y += bodyHeight;

  // Attribution footer
  parts.push(
    `<text x="${CONTENT_LEFT}" y="${y + FOOTER_PADDING}" fill="#999999" font-size="${FOOTER_FONT_SIZE}">${escapeSvg(attribution)}</text>`,
  );
  y += footerHeight;

  if (input.tailNote?.trim()) {
    parts.push(renderTailNote(input.tailNote, y));
  }

  parts.push("</svg>");

  return {
    svg: parts.join("\n"),
    width: SCROLL_STRIP_WIDTH,
    height: totalHeight,
  };
}

// ─── Bottom interaction bar (separate image) ─────────────────────────────────

export function renderBottomBar(meta: SourcePageMeta | null): string {
  const w = SCROLL_STRIP_WIDTH;
  const h = BOTTOM_BAR_HEIGHT;
  const centerY = h / 2;

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    "<style>text { font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif; }</style>",
    `<rect width="${w}" height="${h}" fill="#FFFFFF"/>`,
    `<line x1="0" y1="0" x2="${w}" y2="0" stroke="#E8E8E8" stroke-width="1"/>`,
  ];

  // Left: avatar + follow button
  const avatarR = 28;
  const avatarCx = CONTENT_LEFT + avatarR;
  if (meta?.avatarDataUri) {
    parts.push(
      `<clipPath id="bar-avatar"><circle cx="${avatarCx}" cy="${centerY}" r="${avatarR}"/></clipPath>`,
      `<image href="${escapeSvg(meta.avatarDataUri)}" x="${CONTENT_LEFT}" y="${centerY - avatarR}" width="${avatarR * 2}" height="${avatarR * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#bar-avatar)"/>`,
    );
  } else {
    const initial = meta?.authorName?.trim()?.charAt(0) ?? "知";
    parts.push(
      `<circle cx="${avatarCx}" cy="${centerY}" r="${avatarR}" fill="#EBEBEB"/>`,
      `<text x="${avatarCx}" y="${centerY + 10}" text-anchor="middle" fill="#8590A6" font-size="28" font-weight="600">${escapeSvg(initial)}</text>`,
    );
  }

  // Follow button
  parts.push(
    `<rect x="${CONTENT_LEFT + 72}" y="${centerY - 24}" width="120" height="48" rx="24" fill="#ECF5FF"/>`,
    `<text x="${CONTENT_LEFT + 132}" y="${centerY + 8}" text-anchor="middle" fill="#056DE8" font-size="26" font-weight="600">+ 关注</text>`,
  );

  // Right: interaction icons (simplified as text glyphs)
  const icons = [
    { label: "▲", x: 580 },
    { label: "▼", x: 660 },
    { label: "★", x: 740 },
    { label: "💬", x: 830 },
    { label: "···", x: 930 },
  ];
  for (const icon of icons) {
    parts.push(
      `<text x="${icon.x}" y="${centerY + 10}" text-anchor="middle" fill="#666666" font-size="30">${escapeSvg(icon.label)}</text>`,
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
}

// ─── PNG writing helpers (use sharp from pipeline's dependencies) ────────────

export interface ScrollPngOutput {
  stripPath: string;
  barPath: string;
  stripHeight: number;
}

export interface ReadingPagePngOutput extends ScrollPngOutput {
  /** Consecutive 9:16 source-page screenshots used by the horizontal mode. */
  pagePaths: string[];
}

/**
 * Renders the scroll strip and bottom bar as PNG files in the given directory.
 */
export async function writeScrollPngs(
  outputDirectory: string,
  input: ZhihuScrollRenderInput,
  barMeta: SourcePageMeta | null,
): Promise<ScrollPngOutput> {
  await mkdir(outputDirectory, { recursive: true });

  const strip = renderZhihuScrollStrip(input);
  const stripPath = join(outputDirectory, "scroll-strip.png");
  await sharp(Buffer.from(strip.svg, "utf8"))
    .resize(strip.width, strip.height, { fit: "fill" })
    .png()
    .toFile(stripPath);

  const barSvg = renderBottomBar(barMeta);
  const barPath = join(outputDirectory, "bottom-bar.png");
  await sharp(Buffer.from(barSvg, "utf8"))
    .resize(1080, 140, { fit: "fill" })
    .png()
    .toFile(barPath);

  return { stripPath, barPath, stripHeight: strip.height };
}

/**
 * Splits the same Zhihu reading strip into full-phone screenshots. This is
 * intentionally a hard-cut sequence: the supplied horizontal reference is a
 * viewer swiping between screenshots, rather than a fake pan animation.
 */
export async function writeZhihuReadingPagePngs(
  outputDirectory: string,
  input: ZhihuScrollRenderInput,
  barMeta: SourcePageMeta | null,
): Promise<ReadingPagePngOutput> {
  const rendered = await writeScrollPngs(outputDirectory, input, barMeta);
  const viewportHeight = SCROLL_VIEWPORT_HEIGHT;
  const maxOffset = Math.max(0, rendered.stripHeight - viewportHeight);
  const offsets = Array.from(
    { length: Math.max(1, Math.ceil(maxOffset / viewportHeight) + 1) },
    (_, index) => Math.min(index * viewportHeight, maxOffset),
  ).filter((offset, index, all) => index === 0 || offset !== all[index - 1]);

  const pagePaths: string[] = [];
  for (const [index, top] of offsets.entries()) {
    const pagePath = join(
      outputDirectory,
      `${String(index + 1).padStart(2, "0")}-reading.png`,
    );
    const sourceHeight = Math.min(viewportHeight, rendered.stripHeight - top);
    const source = await sharp(rendered.stripPath)
      .extract({
        left: 0,
        top,
        width: SCROLL_STRIP_WIDTH,
        height: sourceHeight,
      })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width: SCROLL_STRIP_WIDTH,
        height: 1920,
        channels: 4,
        background: "#FFFFFF",
      },
    })
      .composite([
        { input: source, left: 0, top: 0 },
        { input: rendered.barPath, left: 0, top: SCROLL_VIEWPORT_HEIGHT },
      ])
      .png()
      .toFile(pagePath);
    pagePaths.push(pagePath);
  }

  return { ...rendered, pagePaths };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function buildMetaLine(meta: SourcePageMeta | null): string {
  const segments: string[] = [];
  if (meta?.answerCount?.trim())
    segments.push(`${meta.answerCount.trim()} 个回答`);
  if (meta?.followCount?.trim())
    segments.push(`${meta.followCount.trim()} 个关注`);
  return segments.length > 0 ? segments.join(" · ") : "知乎";
}

function buildAttribution(input: ZhihuScrollRenderInput): string {
  const template =
    input.attributionTemplate ?? "内容较长，节选于知乎【{title}】";
  const shortTitle = Array.from(input.sourceTitle).slice(0, 12).join("");
  return template.replace("{title}", shortTitle);
}

function renderAuthorBlock(meta: SourcePageMeta, top: number): string {
  const avatarR = 40;
  const avatarCx = CONTENT_LEFT + avatarR;
  const avatarCy = top + AUTHOR_PADDING_TOP + avatarR;
  const parts: string[] = [];

  if (meta.avatarDataUri) {
    parts.push(
      `<clipPath id="strip-avatar"><circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR}"/></clipPath>`,
      `<image href="${escapeSvg(meta.avatarDataUri)}" x="${CONTENT_LEFT}" y="${top + AUTHOR_PADDING_TOP}" width="${avatarR * 2}" height="${avatarR * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#strip-avatar)"/>`,
    );
  } else {
    const initial = meta.authorName?.trim()?.charAt(0) ?? "知";
    parts.push(
      `<circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR}" fill="#EBEBEB"/>`,
      `<text x="${avatarCx}" y="${avatarCy + 14}" text-anchor="middle" fill="#8590A6" font-size="38" font-weight="600">${escapeSvg(initial)}</text>`,
    );
  }

  const textX = CONTENT_LEFT + avatarR * 2 + 24;
  const name = Array.from(meta.authorName?.trim() ?? "")
    .slice(0, 14)
    .join("");
  parts.push(
    `<text x="${textX}" y="${top + AUTHOR_PADDING_TOP + 34}" fill="#111111" font-size="36" font-weight="600">${escapeSvg(name)}</text>`,
  );

  const badge = meta.authorBadge?.trim();
  if (badge) {
    const shortBadge = Array.from(badge).slice(0, 18).join("");
    parts.push(
      `<text x="${textX}" y="${top + AUTHOR_PADDING_TOP + 74}" fill="#8590A6" font-size="28">${escapeSvg(shortBadge)}</text>`,
    );
  }

  // Follow button on the right
  parts.push(
    `<rect x="${CONTENT_RIGHT - 148}" y="${top + AUTHOR_PADDING_TOP + 12}" width="148" height="56" rx="28" fill="#ECF5FF"/>`,
    `<text x="${CONTENT_RIGHT - 74}" y="${top + AUTHOR_PADDING_TOP + 50}" text-anchor="middle" fill="#056DE8" font-size="30" font-weight="600">+ 关注</text>`,
  );

  return parts.join("\n");
}

function renderBodyLines(lines: string[], top: number): string {
  const spans: string[] = [];
  let pendingGap = 0;
  let isFirst = true;

  for (const line of lines) {
    if (line === "") {
      pendingGap += BODY_LINE_HEIGHT;
      continue;
    }
    const dy = isFirst ? 0 : pendingGap + BODY_LINE_HEIGHT;
    spans.push(
      `<tspan x="${CONTENT_LEFT}" dy="${dy}">${escapeSvg(line)}</tspan>`,
    );
    isFirst = false;
    pendingGap = 0;
  }

  return `<text x="${CONTENT_LEFT}" y="${top + BODY_LINE_HEIGHT}" fill="#1A1A1A" font-size="${BODY_FONT_SIZE}" font-weight="400">${spans.join("")}</text>`;
}

/**
 * The local reference keeps the final source-page screenshot visible and
 * places a bold orange search prompt above the fixed interaction bar.
 */
function renderTailNote(note: string, top: number): string {
  const displayNote = note.trim().replaceAll("🔍", "");
  const lines = wrapText(displayNote, 13, 3);
  const lineHeight = 78;
  const baseline = top + 82;
  const spans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : lineHeight;
      return `<tspan x="${CONTENT_LEFT}" dy="${dy}">${escapeSvg(line)}</tspan>`;
    })
    .join("");

  return [
    `<g aria-label="${escapeSvg(displayNote)}">`,
    `<rect x="${CONTENT_LEFT - 16}" y="${top + 12}" width="${CONTENT_WIDTH - 40}" height="${Math.max(148, lines.length * lineHeight + 46)}" rx="16" fill="#FFF4EF"/>`,
    `<text x="${CONTENT_LEFT}" y="${baseline}" fill="#F04B2F" font-size="64" font-weight="800" transform="rotate(-3 ${CONTENT_LEFT} ${baseline})">${spans}</text>`,
    "</g>",
  ].join("");
}

function renderMultiLine(
  lines: string[],
  opts: {
    x: number;
    y: number;
    fontSize: number;
    lineHeight: number;
    fill: string;
    weight: number;
  },
): string {
  const spans = lines.map((line, i) => {
    const dy = i === 0 ? 0 : opts.lineHeight;
    return `<tspan x="${opts.x}" dy="${dy}">${escapeSvg(line)}</tspan>`;
  });
  return `<text x="${opts.x}" y="${opts.y + opts.fontSize}" fill="${opts.fill}" font-size="${opts.fontSize}" font-weight="${opts.weight}">${spans.join("")}</text>`;
}

// ─── Text wrapping (reuses the same wide-char model as pagination) ───────────

const wideChar =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u4E00-\u9FFF]/;

function wrapParagraphs(paragraphs: string[]): string[] {
  const maxUnits = BODY_CHAR_UNITS * 2;
  const result: string[] = [];

  for (const paragraph of paragraphs) {
    const wrapped = wrapToLines(paragraph, maxUnits);
    if (wrapped.length === 0) continue;
    result.push(...wrapped);
    result.push(""); // blank spacer between paragraphs
  }

  // Trim trailing blank
  while (result.length > 0 && result[result.length - 1] === "") result.pop();
  return result;
}

function wrapToLines(text: string, maxUnits: number): string[] {
  const lines: string[] = [];
  let line = "";
  let width = 0;

  for (const char of Array.from(text)) {
    const charWidth = wideChar.test(char) ? 2 : 1;
    if (width + charWidth > maxUnits) {
      lines.push(line);
      line = "";
      width = 0;
    }
    line += char;
    width += charWidth;
  }
  if (line) lines.push(line);
  return lines;
}

function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const chars = Array.from(text.replace(/\r\n?/g, "\n"));
  const lines: string[] = [];
  let line = "";

  for (const char of chars) {
    if (char === "\n" || Array.from(line).length >= maxChars) {
      if (line) lines.push(line);
      line = "";
      if (lines.length === maxLines) break;
      if (char === "\n") continue;
    }
    line += char;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

function escapeSvg(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
