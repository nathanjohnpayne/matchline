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
 *   - inline markdown markup (`**`, `*`, `__`, `_`, code spans, links,
 *     images, autolinks, escapes) is reduced to plain text, with one
 *     exception: `__…__` is reduced only when its inner text has
 *     whitespace or a non-word character, and around a single
 *     identifier-like token (letters, digits and `_`, as in `__init__` or
 *     `__slots__`) it is a dunder name and keeps its underscores,
 *     whatever follows it. A word-only `__x__` is kept on purpose, even
 *     where Markdown would bold it: keeping characters is the safe side
 *     of the zero-fabrication invariant;
 *   - at a line start only a `#` heading marker, a `-`/`*`/`+` bullet
 *     marker (neither when the first non-whitespace character after it is
 *     a number or sign, however much whitespace comes between) and a
 *     thematic break are removed, and blockquote `>`, ordered-list `1.`
 *     and strikethrough `~~` are kept as typed, so no character that can
 *     carry a claim is dropped;
 *   - Unicode passes through untouched: em dashes, arrows, curly quotes,
 *     accents, CJK and emoji are kept as typed, with no normalization
 *     (the #141 glyph-loss failure must not recur here);
 *   - no name or contact header: the content carries none, and nothing
 *     is invented.
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
/** Characters a backslash escapes in CommonMark. */
const ESCAPABLE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

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
 * A leading token that is content, not a list or heading marker: a number,
 * a currency sign, a percent sign or another sign. `- 30% cost`,
 * `+ 12% NRR` and `# 1 ranked` keep their first character.
 */
const CONTENT_START = String.raw`[\p{N}\p{Sc}%+\-\u2212.]`;
/**
 * The guard after a marker's whitespace. It skips any remaining whitespace
 * itself (`\s*`) before testing for {@link CONTENT_START}, so it always
 * inspects the first non-whitespace character. A bare `(?!CONTENT_START)`
 * let `[ \t]+` backtrack: in `-  30% cost` (two spaces) the guard ran
 * against the second space, passed, and the minus was dropped. `\s`, not
 * `[ \t]`, because the final trim eats NBSP and the other Unicode spaces
 * too, so `- \u00a030%` must keep its minus as well.
 */
const NOT_CONTENT_NEXT = String.raw`(?!\s*${CONTENT_START})`;
const HEADING_MARKER = new RegExp(String.raw`^#{1,6}[ \t]+${NOT_CONTENT_NEXT}`, "u");
const BULLET_MARKER = new RegExp(String.raw`^[-*+][ \t]+${NOT_CONTENT_NEXT}`, "u");

/**
 * Strip the block-level markup that cannot be content, at a line start.
 *
 * Zero fabrication: the Application Editor shows an item's text verbatim,
 * and the validator checked those characters, so only markers that carry
 * no meaning are removed: a thematic-break line, a `#` heading marker and a
 * `-`/`*`/`+` bullet marker, and the last two only when the first
 * non-whitespace character after them is not a number or sign. Blockquote
 * `>` and ordered-list `1.`/`1)` markers are kept as typed, because
 * `>40% faster`, `2019. B.A.` and `1999) Founded` are claims, not markup.
 */
function stripBlockMarkup(line: string): string | null {
  const trimmed = line.replace(/^[ \t]+/, "");
  // A thematic break line (---, ***, ___, optionally spaced) carries no text.
  if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(trimmed)) return null;
  return trimmed.replace(HEADING_MARKER, "").replace(BULLET_MARKER, "");
}

/**
 * Reduce one item's markdown text to a single plain-text line. Exported for
 * tests; callers render whole assets through {@link renderPlainText}.
 */
export function plainTextOf(text: string): string {
  const sentinel = sentinelFor(text);
  const held: string[] = [];
  const hold = (literal: string): string => {
    held.push(literal);
    return `${sentinel}${held.length - 1}${sentinel}`;
  };

  // 1. Backslash escapes become literals that no later step may touch.
  let out = text.replace(ESCAPABLE, (_m, ch: string) => hold(ch));

  // 2. Block markup, per line; then the item becomes one line.
  out = out
    .split(LINE_BREAKS)
    .map(stripBlockMarkup)
    .filter((line): line is string => line !== null)
    .join(" ");

  // 3. Inline markup. Code spans first, and held, so markup inside them stays literal.
  out = out.replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => hold(code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1")));
  out = out.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, "$1");
  out = out.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g, (_m, label: string, url: string) =>
    label.trim() === url ? hold(url) : `${label} (${hold(url)})`,
  );
  // URLs are held too, so emphasis stripping never eats a `_x_` or `*x*` inside one.
  out = out.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, (_m, url: string) => hold(url));
  out = out.replace(/https?:\/\/[^\s<>()[\]*]*[^\s<>()[\]*.,;:!?'"]/gi, (url) => hold(url));
  // Strikethrough `~~x~~` is kept as typed: plain text has no strikethrough,
  // and dropping the tildes would present a deleted figure as a live one.
  out = out.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1");
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
  // Held code spans may themselves contain held escapes, so restore until stable.
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(restore, (_m, index: string) => held[Number(index)] ?? "");
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
