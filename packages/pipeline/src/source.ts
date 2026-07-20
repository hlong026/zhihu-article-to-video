export type ZhihuSourceType = "answer" | "article";

export interface UrlClassification {
  sourceType: ZhihuSourceType | null;
  canonicalUrl: string | null;
}

export interface RawReadableContent {
  title: string;
  paragraphs: string[];
  meta?: SourcePageMeta | null;
}

export interface CleanReadableContent {
  title: string;
  paragraphs: string[];
  meta?: SourcePageMeta | null;
}

/**
 * Optional Zhihu page metadata rendered on the cover card: the author block
 * and the question-header counters. Counts keep their original display text
 * (e.g. "433" or "1.2万") so no locale number parsing is involved. Every
 * field degrades to null when the page layout does not provide it, and the
 * cover simply skips the missing pieces.
 */
export interface SourcePageMeta {
  authorName: string | null;
  authorBadge: string | null;
  answerCount: string | null;
  followCount: string | null;
  /** Ready-to-embed data URI of the author's avatar image, when downloaded. */
  avatarDataUri: string | null;
}

export interface SourceReadFailure {
  code:
    | "SOURCE_NOT_FOUND"
    | "SOURCE_ACCESS_RESTRICTED"
    | "CONTENT_EMPTY"
    | "SOURCE_LAYOUT_CHANGED"
    | "NETWORK_ERROR";
  message: string;
}

export type SourceReadResult =
  | { ok: true; content: CleanReadableContent; snapshotPath?: string }
  | { ok: false; failure: SourceReadFailure };

/**
 * The application supplies the Playwright-backed implementation. This package
 * intentionally has no browser dependency and never carries credentials.
 *
 * `snapshotDir` asks the reader to persist the raw page snapshot (HTML/JSON)
 * for later manual review; implementations may ignore it when persisting is
 * impossible.
 */
export interface ZhihuContentReader {
  read(source: {
    sourceType: ZhihuSourceType;
    canonicalUrl: string;
    snapshotDir?: string;
  }): Promise<SourceReadResult>;
}

const ignoredParagraphs = new Set([
  "知乎首页",
  "首页",
  "发现",
  "等你来答",
  "广告",
  "更多回答",
  "相关推荐",
  "登录",
  "注册",
]);

export function classifyZhihuUrl(rawUrl: string): UrlClassification {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return { sourceType: null, canonicalUrl: null };
  }

  // Accept http:// by upgrading to https (kept in sync with the importer's
  // classifyZhihuUrl): users often paste non-https links from share dialogs.
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }
  if (url.protocol !== "https:") {
    return { sourceType: null, canonicalUrl: null };
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");
  // Zhihu answers have two public URL shapes. The Excel fixture uses the
  // shorter /answer/{id} form, while copied browser URLs often include the
  // question segment. Both resolve to the same source type.
  const answerMatch = /^\/(?:answer\/\d+|question\/\d+\/answer\/\d+)$/.test(
    path,
  );
  if ((host === "www.zhihu.com" || host === "zhihu.com") && answerMatch) {
    return {
      sourceType: "answer",
      canonicalUrl: `https://www.zhihu.com${path}`,
    };
  }

  const articleMatch = /^\/p\/\d+$/.test(path);
  if (host === "zhuanlan.zhihu.com" && articleMatch) {
    return {
      sourceType: "article",
      canonicalUrl: `https://zhuanlan.zhihu.com${path}`,
    };
  }

  return { sourceType: null, canonicalUrl: null };
}

export function cleanReadableContent(
  raw: RawReadableContent,
): CleanReadableContent {
  const seen = new Set<string>();
  const paragraphs = raw.paragraphs.flatMap((paragraph) => {
    const normalized = normalizeWhitespace(simplifyMathMarkup(paragraph));
    const duplicateKey = normalized.replace(/\s/g, "");

    if (
      !normalized ||
      ignoredParagraphs.has(normalized) ||
      seen.has(duplicateKey)
    ) {
      return [];
    }

    seen.add(duplicateKey);
    return [normalized];
  });

  return {
    title: normalizeWhitespace(simplifyMathMarkup(raw.title)),
    paragraphs,
    meta: raw.meta ?? null,
  };
}

// Known LaTeX commands mapped to a readable Unicode glyph. Function-like names
// (log, sin, ...) map to themselves so they survive command stripping.
const mathSymbols: Record<string, string> = {
  rightarrow: "\u2192", Rightarrow: "\u21d2", to: "\u2192", longrightarrow: "\u2192",
  leftarrow: "\u2190", Leftarrow: "\u21d0", leftrightarrow: "\u2194", mapsto: "\u21a6",
  times: "\u00d7", cdot: "\u00b7", div: "\u00f7", pm: "\u00b1", mp: "\u2213", ast: "\u2217",
  leq: "\u2264", le: "\u2264", geq: "\u2265", ge: "\u2265", neq: "\u2260", ne: "\u2260",
  approx: "\u2248", equiv: "\u2261", cong: "\u2245", sim: "~", simeq: "\u2243", propto: "\u221d",
  infty: "\u221e", partial: "\u2202", nabla: "\u2207", forall: "\u2200", exists: "\u2203",
  in: "\u2208", notin: "\u2209", subset: "\u2282", subseteq: "\u2286", supset: "\u2283",
  supseteq: "\u2287", cup: "\u222a", cap: "\u2229", emptyset: "\u2205", varnothing: "\u2205",
  sum: "\u03a3", prod: "\u03a0", int: "\u222b", oint: "\u222e", sqrt: "\u221a", angle: "\u2220",
  cdots: "\u22ef", ldots: "\u2026", dots: "\u2026", vdots: "\u22ee", ddots: "\u22f1",
  alpha: "\u03b1", beta: "\u03b2", gamma: "\u03b3", delta: "\u03b4", epsilon: "\u03b5",
  varepsilon: "\u03b5", zeta: "\u03b6", eta: "\u03b7", theta: "\u03b8", vartheta: "\u03d1",
  iota: "\u03b9", kappa: "\u03ba", lambda: "\u03bb", mu: "\u03bc", nu: "\u03bd", xi: "\u03be",
  pi: "\u03c0", rho: "\u03c1", sigma: "\u03c3", tau: "\u03c4", upsilon: "\u03c5", phi: "\u03c6",
  varphi: "\u03c6", chi: "\u03c7", psi: "\u03c8", omega: "\u03c9",
  Gamma: "\u0393", Delta: "\u0394", Theta: "\u0398", Lambda: "\u039b", Xi: "\u039e", Pi: "\u03a0",
  Sigma: "\u03a3", Upsilon: "\u03a5", Phi: "\u03a6", Psi: "\u03a8", Omega: "\u03a9",
  langle: "\u27e8", rangle: "\u27e9", Vert: "\u2016",
  log: "log", ln: "ln", exp: "exp", max: "max", min: "min", arg: "arg",
  det: "det", dim: "dim", gcd: "gcd", sin: "sin", cos: "cos", tan: "tan", lim: "lim",
};

// Commands whose brace argument holds the readable content to keep.
const contentWrappers =
  "text|textbf|textit|textrm|mathrm|mathbf|mathbb|mathcal|mathsf|mathtt|mathfrak|boxed|operatorname|hat|bar|tilde|vec|overline|underline";

// Layout-only commands that carry no readable content.
const dropCommands =
  "left|right|big|bigg|Big|Bigg|displaystyle|textstyle|scriptstyle|limits|nolimits|nonumber|notag|quad|qquad|hspace|vspace|label";

/**
 * Converts inline/block LaTeX into readable plain text. Zhihu technical
 * articles embed math (e.g. `\mathcal L_{\mathrm{PT}} = ...`) that must never
 * reach a card as raw backslash commands. Symbols become Unicode, content
 * wrappers keep their inner text, and any leftover command or brace is stripped
 * so nothing ever renders a stray "\" or "{}". Paragraphs without a backslash or
 * `$` are returned untouched so ordinary prose is never altered.
 */
export function simplifyMathMarkup(input: string): string {
  if (!/[\\$]/.test(input)) return input;

  let s = input;
  // 1. Strip math delimiters, keeping the inner expression.
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, " $1 ");
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, " $1 ");
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, " $1 ");
  s = s.replace(/\$([^$]+)\$/g, " $1 ");
  // 2. Math line breaks and thin spaces.
  s = s.replace(/\\\\/g, " ").replace(/\\[,;:!]/g, " ");
  // 3. \frac{a}{b} -> (a)/(b) (also \dfrac/\tfrac).
  s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  // 4. Unwrap content commands repeatedly to resolve nesting.
  const wrapperRe = new RegExp(`\\\\(?:${contentWrappers})\\s*\\{([^{}]*)\\}`, "g");
  for (let i = 0; i < 6 && wrapperRe.test(s); i += 1) {
    s = s.replace(wrapperRe, "$1");
  }
  // 5. Drop layout-only commands (\b keeps \leftarrow from matching \left).
  s = s.replace(new RegExp(`\\\\(?:${dropCommands})\\b`, "g"), " ");
  // 6. Replace remaining known commands with symbols; unknown -> space.
  s = s.replace(/\\([A-Za-z]+)/g, (_m, name: string) => mathSymbols[name] ?? " ");
  // 7. Flatten sub/superscripts repeatedly to unwrap nested braces.
  for (let i = 0; i < 4; i += 1) {
    s = s.replace(/_\{([^{}]*)\}/g, "_$1").replace(/\^\{([^{}]*)\}/g, "^$1");
  }
  // 8. Remove any leftover braces so no "{}" leaks to a card.
  return s.replace(/[{}]/g, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
