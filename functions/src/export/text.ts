/**
 * Plain-text résumé renderer (#517, parent #33).
 *
 * A deterministic markdown-to-text emit for email bodies and ATS paste-ins.
 * Layout, in the order the Application Editor shows the sections:
 *
 *     SUMMARY
 *     {summary}
 *
 *     EXPERIENCE
 *     - {bullet}
 *
 *     SKILLS
 *     - {skill}
 *
 *     EDUCATION
 *     - {education}
 *
 * Guarantees:
 *   - the same content always gives byte-identical output;
 *   - `\n` line endings only, one blank line between sections, one
 *     trailing `\n`, and no trailing whitespace on any line;
 *   - every non-empty item appears exactly once, in its stored order
 *     (never re-sorted or de-duplicated); an item whose text is empty
 *     after markup reduction is skipped, and a section with no lines
 *     emits no heading;
 *   - inline markdown markup (`**`, `*`, `__`, `_`, links, images,
 *     autolinks, escapes) is reduced to plain text, with two exceptions.
 *     `**…**` is reduced only at non-word boundaries (the opening `**` not
 *     preceded and the closing `**` not followed by a letter, digit or
 *     `_`), so a `**` inside a word or number is kept as typed and
 *     exponent operators like `10**6 to 10**9` and `x**2` survive, as
 *     `5*3*2` does under the single-`*` rule. And `__…__` is reduced
 *     only when its inner text has whitespace or a non-word character,
 *     and around a single identifier-like token (letters, digits and
 *     `_`, as in `__init__` or `__slots__`) it is a dunder name and keeps
 *     its underscores, whatever follows it. A word-only `__x__` is kept
 *     on purpose, even where Markdown would bold it: keeping characters
 *     is the safe side of the zero-fabrication invariant;
 *   - a code span's backticks are removed and its text is exported as
 *     typed, with backslashes, `*`, `_`, `~`, `#`, `>` and link syntax
 *     kept literal (a backslash inside a code span escapes nothing, as in
 *     CommonMark), so `\d+\.\d+` and `C:\*` keep every character. Only
 *     its whitespace is laid out: a line break in it becomes a space, one
 *     space is trimmed from each side when both sides have one, and ASCII
 *     whitespace runs collapse as everywhere else;
 *   - at a line start only a `#` heading marker, a `-`/`*`/`+` bullet
 *     marker (neither when the first visible character after it is a
 *     number, a sign or a backslash-escaped literal: the guard looks
 *     through any whitespace, inline formatting (`*`, `_`, `~`, a stray
 *     backtick, the `[` or `![` of a link or image whose label starts the
 *     content) and escapes, and reads a code span by the first
 *     non-whitespace character of its text, so `- **30%** cost`,
 *     `` - `-30%` cost `` and `- \-30% cost` keep their minus) and a
 *     thematic break are removed, and blockquote `>`, ordered-list `1.`
 *     and strikethrough `~~` are kept as typed, so no character that can
 *     carry a claim is dropped;
 *   - Unicode passes through untouched: em dashes, arrows, curly quotes,
 *     accents, CJK and emoji are kept as typed, with no normalization
 *     (the #141 glyph-loss failure must not recur here);
 *   - no name or contact header: the content carries none, and nothing
 *     is invented.
 *
 * Processing order, per item ({@link plainTextOf}):
 *   1. one left-to-right pass holds code spans and backslash escapes. A
 *      code span is held as typed before any escape is reduced, and
 *      outside code spans an escape holds the character it escapes, so an
 *      escaped backtick never opens a span;
 *   2. block markers are stripped per line, guarded by the first visible
 *      character, and the lines are joined into one;
 *   3. inline markup (images, links, autolinks, emphasis) is reduced, with
 *      every URL held;
 *   4. the held text is restored, ASCII whitespace runs collapse to one
 *      space, and the edges are trimmed.
 *
 * Pure: no network, Firestore or Storage access.
 */

import type { GeneratedAssetContent, GeneratedItem } from "../types/crm.js";
import { isAttestableContent } from "../validation/attestation.js";
import { InvalidExportContent, type AssetRenderer, type RenderedExport } from "./types.js";

export const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/** Line breaks markdown or pasted text can carry: CRLF, CR, LF, NEL, LS, PS. */
const LINE_BREAKS = /\r\n|[\r\n\u0085\u2028\u2029]/;
/** ASCII horizontal whitespace; NBSP and other Unicode spaces are content. */
const ASCII_SPACE_RUN = /[ \t\f\v]+/g;
/** ASCII punctuation: the characters a backslash escapes in CommonMark. */
const ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

/** Letter, digit or underscore: the "word" side of an emphasis boundary. */
const W = String.raw`[\p{L}\p{N}_]`;
/** One identifier-like token: what a `__x__` dunder name wraps. */
const IDENTIFIER_TOKEN = /^[\p{L}\p{N}_]+$/u;

/**
 * A sentinel from the Private Use Area that does not occur in `text`, so a
 * placeholder can never collide with real content.
 */
function sentinelFor(text: string): string {
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const ch = String.fromCharCode(code);
    if (!text.includes(ch)) return ch;
  }
  // 6,400 distinct private-use characters in one résumé item: not real input.
  throw new InvalidExportContent("Export content item contains too many private-use characters to render.");
}

/**
 * Literals held out of reach of markup reduction: each sits in the text as
 * a `{sentinel}{index}{sentinel}` placeholder until step 4 of
 * {@link plainTextOf} restores it.
 */
interface Held {
  readonly sentinel: string;
  readonly literals: readonly string[];
  /** Indices of the literals that are code-span text; the others are escaped characters and URLs. */
  readonly codeSpans: ReadonlySet<number>;
}

/** The end of the run of backticks that starts at `start`. */
function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (text.charAt(end) === "`") end += 1;
  return end;
}

/** Where the next run of exactly `length` backticks at or after `from` starts, or -1 when there is none. */
function closingRun(text: string, from: number, length: number): number {
  for (let start = text.indexOf("`", from); start !== -1; ) {
    const end = backtickRunEnd(text, start);
    if (end - start === length) return start;
    start = text.indexOf("`", end);
  }
  return -1;
}

/**
 * A code span's text as CommonMark reads it: line breaks become spaces,
 * then one space is trimmed from each side when both sides have one and
 * the text is not all whitespace. Every other character is kept as typed.
 */
function codeSpanText(raw: string): string {
  const code = raw.split(LINE_BREAKS).join(" ");
  return code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1");
}

/**
 * Step 1 of {@link plainTextOf}: one left-to-right pass that holds code
 * spans and backslash escapes, with CommonMark's precedence between them.
 * A run of N backticks opens a code span that the next run of exactly N
 * backticks closes, and the text between is held as typed
 * ({@link codeSpanText}): a backslash inside a code span is literal, so
 * `\d+\.\d+` and `C:\*` keep every character. A backtick run with no
 * closer is literal text, and the scan resumes after it. Outside code
 * spans, a backslash before ASCII punctuation holds that character as a
 * literal, so an escaped backtick never opens a span.
 */
function holdCodeSpansAndEscapes(text: string, hold: (literal: string) => string, holdCode: (code: string) => string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);
    if (char === "\\" && ESCAPABLE.test(next)) {
      out += hold(next);
      i += 2;
    } else if (char === "`") {
      const end = backtickRunEnd(text, i);
      const close = closingRun(text, end, end - i);
      if (close === -1) {
        out += text.slice(i, end);
        i = end;
      } else {
        out += holdCode(codeSpanText(text.slice(end, close)));
        i = close + (end - i);
      }
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** An image and a link, as step 3 of {@link plainTextOf} reduces them. */
const IMAGE = String.raw`!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`;
const LINK = String.raw`\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`;
const OPENS_IMAGE = new RegExp(`^${IMAGE}`);
const OPENS_LINK = new RegExp(`^${LINK}`);
/**
 * Inline opening delimiters: emphasis `*` and `_`, strikethrough `~`, and a
 * backtick. Every code span is held before block markup is stripped, so a
 * backtick left in the text opens nothing; looking past it anyway errs
 * toward keeping a marker.
 */
const INLINE_OPENERS: ReadonlySet<string> = new Set(["*", "_", "`", "~"]);

/** The first character a reader sees after a block marker. */
interface Visible {
  /** The character: a held escape resolves to the literal it holds, a held code span to the first non-whitespace character of its text. */
  readonly char: string;
  /** True when the author typed a backslash to make this character literal content (never for code-span text, where a backslash is just a character). */
  readonly escaped: boolean;
}

/**
 * The first visible character of `rest` once inline markup is reduced, or
 * `undefined` when nothing visible follows. It looks past whitespace (`\s`,
 * not only `[ \t]`, because the final trim eats NBSP and the other Unicode
 * spaces too), the {@link INLINE_OPENERS}, and the `[` or `![` that opens a
 * link or image whose label starts the content (an image with an empty
 * label reduces to nothing, so it is skipped whole). A held code span is
 * read by the first non-whitespace character of its text, as typed (a
 * whitespace-only span is skipped whole), so `` - `30%` cost `` keeps its
 * marker and `` + `dbt` models `` loses it. A held escape resolves to the
 * literal it holds (`\-`, `\+`, `\#`, `\*`), and a backslash that escapes
 * nothing (`\3`: CommonMark escapes only ASCII punctuation, so it is kept
 * as typed) is visible itself; both count as escaped.
 */
function firstVisibleChar(rest: string, held: Held): Visible | undefined {
  const placeholder = new RegExp(`^${held.sentinel}(\\d+)${held.sentinel}`);
  for (let i = 0; i < rest.length; ) {
    const tail = rest.slice(i);
    const char = String.fromCodePoint(rest.codePointAt(i) ?? 0);
    if (/^\s$/u.test(char) || INLINE_OPENERS.has(char)) {
      i += char.length;
      continue;
    }
    const image = OPENS_IMAGE.exec(tail);
    if (image !== null) {
      i += image[1] === "" ? image[0].length : "![".length;
      continue;
    }
    if (OPENS_LINK.test(tail)) {
      i += "[".length;
      continue;
    }
    const placed = placeholder.exec(tail);
    if (placed !== null) {
      const index = Number(placed[1]);
      const literal = held.literals[index] ?? "";
      if (!held.codeSpans.has(index)) return { char: literal, escaped: true };
      const visible = /\S/u.exec(literal);
      if (visible !== null) return { char: visible[0], escaped: false };
      i += placed[0].length;
      continue;
    }
    return { char, escaped: char === "\\" };
  }
  return undefined;
}

/**
 * A leading character that is content, not a list or heading marker: a
 * number, a currency sign, a percent sign or another sign. `- 30% cost`,
 * `+ 12% NRR` and `# 1 ranked` keep their first character.
 */
const CONTENT_START = /^[\p{N}\p{Sc}%+\-\u2212.]$/u;
const HEADING_MARKER = /^#{1,6}[ \t]+/;
const BULLET_MARKER = /^[-*+][ \t]+/;

/**
 * Remove `marker` (with the whitespace after it) from the start of `line`,
 * unless what follows starts with content: its first visible character
 * ({@link firstVisibleChar}) is in {@link CONTENT_START} or is a literal
 * the author escaped. Deciding on the raw next character let inline
 * formatting hide a sign: `- **30%** cost` met `*`, and rendered as
 * `30% cost`.
 */
function stripMarker(line: string, marker: RegExp, held: Held): string {
  const match = marker.exec(line);
  if (match === null) return line;
  const rest = line.slice(match[0].length);
  const first = firstVisibleChar(rest, held);
  const startsWithContent = first !== undefined && (first.escaped || CONTENT_START.test(first.char));
  return startsWithContent ? line : rest;
}

/**
 * Strip the block-level markup that cannot be content, at a line start.
 *
 * Zero fabrication: the Application Editor shows an item's text verbatim,
 * and the validator checked those characters, so only markers that carry
 * no meaning are removed: a thematic-break line, a `#` heading marker and a
 * `-`/`*`/`+` bullet marker, and the last two only when the first visible
 * character after them, looking through whitespace, inline formatting and
 * escapes, is not a number, a sign or an escaped literal. Blockquote `>`
 * and ordered-list `1.`/`1)` markers are kept as typed, because
 * `>40% faster`, `2019. B.A.` and `1999) Founded` are claims, not markup.
 */
function stripBlockMarkup(line: string, held: Held): string | null {
  const trimmed = line.replace(/^[ \t]+/, "");
  // A thematic break line (---, ***, ___, optionally spaced) carries no text.
  if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(trimmed)) return null;
  return stripMarker(stripMarker(trimmed, HEADING_MARKER, held), BULLET_MARKER, held);
}

/**
 * Reduce one item's markdown text to a single plain-text line. Exported for
 * tests; callers render whole assets through {@link renderPlainText}.
 */
export function plainTextOf(text: string): string {
  const sentinel = sentinelFor(text);
  const literals: string[] = [];
  const codeSpans = new Set<number>();
  const held: Held = { sentinel, literals, codeSpans };
  const hold = (literal: string): string => {
    literals.push(literal);
    return `${sentinel}${literals.length - 1}${sentinel}`;
  };
  const holdCode = (code: string): string => {
    codeSpans.add(literals.length);
    return hold(code);
  };

  // 1. Code spans and backslash escapes, in one pass, become literals that no later step may
  //    touch. A code span is held as typed before any escape is reduced, so a backslash inside
  //    it stays (`\d+\.\d+`, `C:\*`); outside code spans each escape holds the character it escapes.
  let out = holdCodeSpansAndEscapes(text, hold, holdCode);

  // 2. Block markup, per line; then the item becomes one line.
  out = out
    .split(LINE_BREAKS)
    .map((line) => stripBlockMarkup(line, held))
    .filter((line): line is string => line !== null)
    .join(" ");

  // 3. Inline markup. Code spans are held already, so markup inside them stays literal.
  out = out.replace(new RegExp(IMAGE, "g"), "$1");
  out = out.replace(new RegExp(LINK, "g"), (_m, label: string, url: string) =>
    label.trim() === url ? hold(url) : `${label} (${hold(url)})`,
  );
  // URLs are held too, so emphasis stripping never eats a `_x_` or `*x*` inside one.
  out = out.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, (_m, url: string) => hold(url));
  out = out.replace(/https?:\/\/[^\s<>()[\]*]*[^\s<>()[\]*.,;:!?'"]/gi, (url) => hold(url));
  // Strikethrough `~~x~~` is kept as typed: plain text has no strikethrough,
  // and dropping the tildes would present a deleted figure as a live one.
  // `**x**` is strong emphasis only at a non-word boundary: the opening `**`
  // not preceded and the closing `**` not followed by a letter, digit or `_`.
  // Anywhere else `**` is kept as typed, so the exponent operators in
  // `10**6 to 10**9`, `x**2 + y**2` and `a**b**c` keep their meaning.
  out = out.replace(new RegExp(String.raw`(?<!${W})\*\*(?=\S)(.+?)(?<=\S)\*\*(?!${W})`, "gu"), "$1");
  // `__x__` is strong emphasis only when `x` has whitespace or a non-word
  // character. Around a single identifier-like token it is a dunder name
  // (`__init__`, `__slots__`, `__call__()`), whatever follows, and keeps its
  // underscores: dropping them could misstate a claim, keeping them cannot.
  out = out.replace(new RegExp(String.raw`(?<!${W})__(?=\S)(.+?)(?<=\S)__(?!${W})`, "gu"), (match: string, inner: string) =>
    IDENTIFIER_TOKEN.test(inner) ? match : inner,
  );
  // Single-delimiter emphasis only at a non-word boundary, so `5*3*2`,
  // `2 * 3`, `snake_case_name` and `a_b` keep their characters.
  out = out.replace(new RegExp(String.raw`(?<![\p{L}\p{N}*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?![\p{L}\p{N}*])`, "gu"), "$1");
  out = out.replace(new RegExp(String.raw`(?<!${W})_([^\s_](?:[^_]*?[^\s_])?)_(?!${W})`, "gu"), "$1");

  // 4. Restore held literals, then collapse ASCII whitespace and trim the edges.
  const restore = new RegExp(`${sentinel}(\\d+)${sentinel}`, "g");
  // A held URL may itself contain held escapes and code spans, so restore until stable.
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(restore, (_m, index: string) => literals[Number(index)] ?? "");
  }
  return out.replace(ASCII_SPACE_RUN, " ").replace(/^\s+|\s+$/gu, "");
}

function section(heading: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [`${heading}\n${lines.join("\n")}`];
}

function listLines(items: readonly GeneratedItem[] | undefined): string[] {
  return (items ?? []).map((item) => plainTextOf(item.text)).filter((line) => line !== "").map((line) => `- ${line}`);
}

/**
 * Render a résumé's content as plain text. Throws
 * {@link InvalidExportContent} for malformed content (the same shape check
 * the validation attestation applies, so anything attestable renders).
 */
export function renderPlainText(content: GeneratedAssetContent): string {
  if (!isAttestableContent(content)) throw new InvalidExportContent();
  const summary = plainTextOf(content.summary.text);
  const blocks = [
    ...section("SUMMARY", summary === "" ? [] : [summary]),
    ...section("EXPERIENCE", listLines(content.bullets)),
    ...section("SKILLS", listLines(content.skills)),
    ...section("EDUCATION", listLines(content.education)),
  ];
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

/** The `txt` renderer registered with the export callable (#521). */
export const textRenderer: AssetRenderer = {
  format: "txt",
  contentType: TEXT_CONTENT_TYPE,
  extension: "txt",
  async render(content: GeneratedAssetContent): Promise<RenderedExport> {
    return {
      bytes: new TextEncoder().encode(renderPlainText(content)),
      contentType: TEXT_CONTENT_TYPE,
      extension: "txt",
    };
  },
};
