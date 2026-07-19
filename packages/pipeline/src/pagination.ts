/**
 * Splits cleaned article paragraphs into render-ready body pages. The layout
 * constants mirror the 1080×1920 SVG body-card typography so that one page of
 * text always fits one card without further wrapping at render time.
 */
export interface PaginationOptions {
  /** Hard cap of body pages per video; overflow is truncated with an ellipsis. */
  maxPages?: number;
  /** Characters per rendered line (48px font on a 900px content column). */
  charactersPerLine?: number;
  /** Rendered lines per page (82px line height inside a ~1600px content area). */
  linesPerPage?: number;
}

export interface PaginatedPage {
  /** Lines joined by "\n", ready for the SVG body renderer. */
  body: string;
  /** 1-based indexes of the source paragraphs visible on this page. */
  sourceRefs: number[];
}

export interface PaginationResult {
  pages: PaginatedPage[];
  /** True when the article was longer than `maxPages` and got cut off. */
  truncated: boolean;
}

export const defaultPagination = {
  maxPages: 10,
  charactersPerLine: 18,
  linesPerPage: 18,
} as const;

const truncationMark = "……";

interface PaginationLine {
  text: string;
  /** 1-based source paragraph index; blank spacer lines reuse the previous one. */
  paragraphRef: number;
}

/**
 * Paragraphs are wrapped line-by-line and packed greedily: a paragraph may
 * continue on the next page, matching the reference video's continuous
 * reading flow. Blank spacer lines separate paragraphs but never start a page.
 */
export function paginateParagraphs(
  paragraphs: readonly string[],
  options: PaginationOptions = {},
): PaginationResult {
  const { maxPages, charactersPerLine, linesPerPage } = {
    ...defaultPagination,
    ...options,
  };

  const lines: PaginationLine[] = [];
  const maxUnits = charactersPerLine * 2;
  paragraphs.forEach((paragraph, index) => {
    const paragraphRef = index + 1;
    const wrapped = wrapParagraphToLines(paragraph, maxUnits);
    if (wrapped.length === 0) return;
    for (const text of wrapped) {
      lines.push({ text, paragraphRef });
    }
    lines.push({ text: "", paragraphRef });
  });

  const pages: PaginatedPage[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    // A blank spacer at the top of a page wastes a line; skip it.
    while (cursor < lines.length && lines[cursor]!.text === "") cursor += 1;
    if (cursor >= lines.length) break;

    const pageLines = lines.slice(cursor, cursor + linesPerPage);
    // Trailing spacer of the last paragraph on the page is not rendered.
    while (pageLines.length > 0 && pageLines.at(-1)!.text === "") {
      pageLines.pop();
    }
    cursor += linesPerPage;

    pages.push({
      body: pageLines.map((line) => line.text).join("\n"),
      sourceRefs: [
        ...new Set(pageLines.map((line) => line.paragraphRef)),
      ],
    });
  }

  if (pages.length > maxPages) {
    const kept = pages.slice(0, maxPages);
    const lastPage = kept[maxPages - 1]!;
    lastPage.body = appendTruncationMark(lastPage.body, charactersPerLine);
    return { pages: kept, truncated: true };
  }

  return { pages, truncated: false };
}

/** Counts non-whitespace characters; validation uses this for the 38-floor. */
export function countBodyCharacters(body: string): number {
  return Array.from(body.replace(/\s/g, "")).length;
}

// Wide glyphs (CJK, full-width punctuation) occupy two layout units and may
// break between any two; ASCII runs are one unit each and break only at spaces
// so Latin words like "training recipe" are never split mid-word.
const wideCharacter =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u4E00-\u9FFF]/;

/**
 * 测量已排版正文的布局占用，与分页器/渲染器使用同一宽度模型
 * （宽字符=2 单位，ASCII=1 单位）。校验据此判断单页是否超出排版容量：
 * 行数超过 linesPerPage 即为超高。纯字符数会误报 ASCII 密集内容
 * （每格可排两个窄字符），故不用字符数衡量上限。
 */
export function measureBodyLayout(body: string): {
  lineCount: number;
  maxLineUnits: number;
} {
  const lines = body.split("\n");
  let maxLineUnits = 0;
  for (const line of lines) {
    let units = 0;
    for (const character of Array.from(line)) {
      units += wideCharacter.test(character) ? 2 : 1;
    }
    if (units > maxLineUnits) maxLineUnits = units;
  }
  return { lineCount: lines.length, maxLineUnits };
}

type WrapUnit = { text: string; width: number; space: boolean };

function toWrapUnits(text: string): WrapUnit[] {
  const units: WrapUnit[] = [];
  let word = "";
  const flushWord = () => {
    if (word) {
      units.push({ text: word, width: Array.from(word).length, space: false });
      word = "";
    }
  };
  for (const character of Array.from(text)) {
    if (character === " " || character === "\t") {
      flushWord();
      units.push({ text: " ", width: 1, space: true });
    } else if (wideCharacter.test(character)) {
      flushWord();
      units.push({ text: character, width: 2, space: false });
    } else {
      word += character;
    }
  }
  flushWord();
  return units;
}

/**
 * Greedily packs a paragraph into lines no wider than `maxUnits`, keeping Latin
 * words whole. A word longer than a full line is hard-split as a last resort.
 */
function wrapParagraphToLines(text: string, maxUnits: number): string[] {
  const lines: string[] = [];
  let line: WrapUnit[] = [];
  let width = 0;
  const flush = () => {
    while (line.length > 0 && line[line.length - 1]!.space) {
      width -= line.pop()!.width;
    }
    if (line.length > 0) lines.push(line.map((unit) => unit.text).join(""));
    line = [];
    width = 0;
  };

  for (const unit of toWrapUnits(text)) {
    if (unit.space) {
      if (line.length === 0) continue;
      if (width + 1 > maxUnits) {
        flush();
        continue;
      }
      line.push(unit);
      width += 1;
      continue;
    }
    if (unit.width > maxUnits) {
      flush();
      let chunk = "";
      let chunkWidth = 0;
      for (const character of Array.from(unit.text)) {
        if (chunkWidth + 1 > maxUnits) {
          lines.push(chunk);
          chunk = "";
          chunkWidth = 0;
        }
        chunk += character;
        chunkWidth += 1;
      }
      if (chunk) {
        line = [{ text: chunk, width: chunkWidth, space: false }];
        width = chunkWidth;
      }
      continue;
    }
    if (width + unit.width > maxUnits) flush();
    line.push(unit);
    width += unit.width;
  }
  flush();
  return lines;
}

function appendTruncationMark(body: string, charactersPerLine: number): string {
  const lines = body.split("\n");
  const lastLine = lines.at(-1) ?? "";
  const room = charactersPerLine - Array.from(truncationMark).length;
  const trimmed =
    Array.from(lastLine).length > room
      ? Array.from(lastLine).slice(0, room).join("")
      : lastLine;
  lines[lines.length - 1] = `${trimmed}${truncationMark}`;
  return lines.join("\n");
}
