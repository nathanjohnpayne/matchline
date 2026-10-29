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
 *     autolinks, escapes) is reduced to plain text, but an emphasis
 *     delimiter pairs only at a word-like boundary, where it reads as
 *     emphasis; anywhere else it is an operator, a glob, a path or a
 *     footnote mark, and it is kept as typed:
 *       - `*…*` and `**…**` never pair inside a word or number: the
 *         opener is not preceded and the closer not followed by a letter,
 *         a combining mark or a digit (or `_`, for `**`), so `5*3*2`,
 *         `10**6 to 10**9`, `x**2` and `cafe\u0301*2*` (a decomposed
 *         `é`, whose combining mark counts as part of the letter) keep
 *         their stars;
 *       - a `*` or `**` glued to punctuation or a symbol pairs only at a
 *         boundary: an opener followed by one must come after the start,
 *         whitespace, an opening bracket or quote, a dash or a held
 *         literal, and a closer preceded by one must come before the end,
 *         whitespace, closing punctuation, a dash, `/` or a held literal.
 *         Emphasised text never starts with `)`, `]`, `}`, `,`, `.`, `;`,
 *         `:`, `!`, `?`, `/`, `%` or a closing quote, nor ends with `(`,
 *         `[`, `{`, an opening quote or `/`. So `COUNT(*)`, `SELECT *, id`,
 *         `src/*.ts and test/*.ts`, `v2.*, v3.*`, `Grew 30%*, cut 12%*`,
 *         `(3)*(4)*(5)` and `f(*a) and g(*)` export as typed;
 *       - `_…_` needs a boundary outside both delimiters, whatever they
 *         touch inside: the opener follows the start, whitespace, an
 *         opening bracket or quote, a dash or a held literal, and the
 *         closer precedes the end, whitespace, closing punctuation, a dash
 *         or a held literal, never `/` or `@`. The emphasised text obeys
 *         the same first- and last-character rule. So `$_1_`,
 *         `/_internal_/api`, `_.map`, `_jdoe_@ex.com` and
 *         `github.com/acme/_private_` keep their underscores;
 *       - `__…__` is reduced only at non-word boundaries and only when its
 *         inner text has whitespace or a non-word character: around a
 *         single identifier-like token (letters, combining marks, digits
 *         and `_`, as in `__init__` or `__slots__`) it is a dunder name
 *         and keeps its underscores, whatever follows it;
 *       - emphasis never crosses a bracket: the text a `*`, `**` or `_`
 *         pair emphasises must balance its brackets, so in `f(*1)*` the
 *         `*` inside the parentheses does not pair with the one after
 *         them; and a `*` or `**` between a digit and a signed digit is an
 *         operator, never a closer, so `**2**-3**` keeps `2**-3` whole;
 *       - a `**…**` or `__…__` span is reduced only up to
 *         {@link MAX_EMPHASIS} characters, which bounds the work per
 *         opener; a longer span keeps its delimiters.
 *     The trade-off is intended: these rules keep the delimiters of some
 *     emphasised prose that Markdown would format, such as `**.NET**`,
 *     `_42_/x`, `*+15%*…`, `**1)**` and a word-only `__x__`. Keeping
 *     characters is the safe side of the zero-fabrication invariant;
 *     dropping them is not;
 *   - URLs are held whole, so their `*`, `_` and balanced `(…)` pairs are
 *     never read as emphasis: a bare URL with any scheme (`https://`,
 *     `ftp://`, `file://`, `s3://` and the like), an `<https://…>` or
 *     `<mailto:…>` autolink, and a link destination. A bare URL never ends
 *     with `*` or trailing sentence punctuation, which stay outside it, as
 *     does a `)` it did not open;
 *   - a link `[label](url "title")` becomes `label (url)` (just `url`
 *     when the label is the URL) and its title is dropped. An image
 *     `![alt](url)` keeps only its alt text: its URL is dropped, and an
 *     image whose alt text is empty disappears. As in CommonMark, `![`
 *     always opens an image, so `Wow![chart](u)` becomes `Wowchart`, and
 *     `[x](y)` is a link wherever it stands, so `arr[0](1)` becomes
 *     `arr0 (1)`;
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
 *     content) and escapes, and reads a code span's text the same way,
 *     past whitespace and those delimiters, so `- **30%** cost`,
 *     `` - `-30%` cost `` and `- \-30% cost` keep their minus, and
 *     `- ~30% faster` and `` - `~30%` faster `` both keep their marker)
 *     and a thematic break are removed, and blockquote `>`, ordered-list
 *     `1.` and strikethrough `~~` are kept as typed, so no character that
 *     can carry a claim is dropped. A heading marker before a bullet
 *     marker keeps both (`## - Led` is exported as typed), because the
 *     guard reads the `-` as a sign;
 *   - Unicode passes through untouched: em dashes, arrows, curly quotes,
 *     accents, CJK and emoji are kept as typed, with no normalization
 *     (the #141 glyph-loss failure must not recur here);
 *   - no name or contact header: the content carries none, and nothing
 *     is invented;
 *   - no step's work grows with the square of the item's length (an
 *     emphasis span is bounded, and no pattern rescans the rest of the
 *     text from every position), so a pathological item (a run of 40,000
 *     NBSP, 40,000 `[`, tens of thousands of unclosed `**` or `[a](`)
 *     renders in milliseconds, not seconds.
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
 *      space, and the edges are trimmed of all whitespace.
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

/**
 * Letter, combining mark, digit or underscore: the "word" side of an
 * emphasis boundary. A combining mark belongs to the letter before it, so a
 * decomposed `e\u0301` is as much a letter as a precomposed `é`.
 */
const W = String.raw`[\p{L}\p{M}\p{N}_]`;
/** One identifier-like token: what a `__x__` dunder name wraps. */
const IDENTIFIER_TOKEN = /^[\p{L}\p{M}\p{N}_]+$/u;

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

/**
 * One character of a link or image destination: anything but whitespace,
 * `>` or a parenthesis, or a balanced `(…)` pair, as in
 * `https://en.wikipedia.org/wiki/C_(programming_language)`. Leaving a lone
 * `(` out also keeps the scan linear: a destination ends at the next
 * unbalanced `(`, so `[a](` repeated cannot rescan the rest of the text
 * from every link start.
 */
const DESTINATION = String.raw`(?:[^()\s>]|\([^()\s>]*\))`;
/**
 * An image and a link, as step 3 of {@link plainTextOf} reduces them. A
 * label holds no `[` or `]`, as in CommonMark, which keeps the scan linear
 * on a long run of `[` (a label that could hold `[` rescanned the rest of
 * the text from every one).
 */
const IMAGE = String.raw`!\[([^\][]*)\]\(\s*<?(${DESTINATION}*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`;
const LINK = String.raw`\[([^\][]+)\]\(\s*<?(${DESTINATION}+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`;
const OPENS_IMAGE = new RegExp(`^${IMAGE}`);
const OPENS_LINK = new RegExp(`^${LINK}`);
/**
 * Inline opening delimiters: emphasis `*` and `_`, strikethrough `~`, and a
 * backtick. Every code span is held before block markup is stripped, so a
 * backtick left in the text opens nothing; looking past it anyway errs
 * toward keeping a marker.
 */
const INLINE_OPENERS: ReadonlySet<string> = new Set(["*", "_", "`", "~"]);

/**
 * What the marker guard looks past: whitespace and the
 * {@link INLINE_OPENERS}. It looks past them in raw text and in a code
 * span's text alike, so a code span reads like the same characters typed
 * outside one. Reading a span by its first character instead let
 * `` - `~30%` faster `` lose the marker that `- ~30% faster` keeps. The
 * delimiters are not content starts themselves, so looking past them can
 * only keep a marker that reading them would have stripped.
 */
function isLookedPast(char: string): boolean {
  return /^\s$/u.test(char) || INLINE_OPENERS.has(char);
}

/** The first character a reader sees after a block marker. */
interface Visible {
  /** The character: a held escape resolves to the literal it holds, a held code span to the first character of its text that the guard does not look past. */
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
 * read the same way, by the first character of its text, as typed, that is
 * not whitespace or an inline opener (a span with none is skipped whole),
 * so `` - `30%` cost `` and `` - `~30%` cost `` keep their marker and
 * `` + `dbt` models `` loses it. A held escape resolves to the
 * literal it holds (`\-`, `\+`, `\#`, `\*`), and a backslash that escapes
 * nothing (`\3`: CommonMark escapes only ASCII punctuation, so it is kept
 * as typed) is visible itself; both count as escaped.
 */
function firstVisibleChar(rest: string, held: Held): Visible | undefined {
  const placeholder = new RegExp(`^${held.sentinel}(\\d+)${held.sentinel}`);
  for (let i = 0; i < rest.length; ) {
    const tail = rest.slice(i);
    const char = String.fromCodePoint(rest.codePointAt(i) ?? 0);
    if (isLookedPast(char)) {
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
      const visible = [...literal].find((c) => !isLookedPast(c));
      if (visible !== undefined) return { char: visible, escaped: false };
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
 * One character a bare URL holds: anything but whitespace, `<`, `>`, a
 * bracket or a parenthesis. A `*` is held, so the stars in `?q=*foo*` and
 * `/a*b*c` are never read as emphasis.
 */
const URL_CHAR = String.raw`[^\s<>()[\]]`;
/** A balanced `(…)` pair inside a bare URL, as in `https://ex.com/(_draft_)`. */
const URL_PARENS = String.raw`\(${URL_CHAR}*\)`;
/** A bare URL's last character: never `*`, a quote or trailing sentence punctuation, which stay outside it. */
const URL_LAST = String.raw`[^\s<>()[\]*.,;:!?'"]`;
/**
 * A bare URL with any scheme (`https://`, `ftp://`, `file://`, `s3://`):
 * the scheme starts where no scheme character precedes it and is at most
 * 32 characters long, so the scan stays linear on a long run of letters.
 */
const BARE_URL = new RegExp(
  String.raw`(?<![a-z\d+.-])[a-z][a-z\d+.-]{0,31}:\/\/(?:${URL_CHAR}|${URL_PARENS})*(?:${URL_LAST}|${URL_PARENS})`,
  "gi",
);
/** An `<…>` autolink: a URL or `mailto:` address with no whitespace, `<` or `>` in it. */
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi;

/** Punctuation or a symbol: what a delimiter used as an operator, a glob, a path or a footnote mark touches. */
const PUNCT = String.raw`[\p{P}\p{S}]`;
/**
 * Besides the start and a held literal, what may come right before an
 * opener glued to punctuation: whitespace, an opening bracket or quote, or
 * a dash. Not `/`, so `src/*.ts` opens nothing.
 */
const BEFORE_OPENER = String.raw`\s(\[{"'“‘«\-–—`;
/**
 * Besides the end and a held literal, what may come right after a closer
 * glued to punctuation: whitespace, closing punctuation or a dash. The `*`
 * and `**` rules also allow `/`, so a bold figure before a per-unit slash
 * still reduces; the `_` rule does not, so `/_internal_/api` keeps its
 * underscores.
 */
const AFTER_CLOSER = String.raw`\s)\]}"'”’».,;:!?\-–—`;
/** Emphasised text never starts with one of these: `(*)`, `*.ts` and `30%*, 12%*` are not emphasis. */
const NOT_FIRST = String.raw`[)\]}”’»,.;:!?/%]`;
/** Emphasised text never ends with one of these: `f(*a) and g(*)` is not emphasis. */
const NOT_LAST = String.raw`[(\[{“‘«/]`;
/**
 * A sign and a digit after a `*` or `**` that follows a digit: the
 * delimiter is the operator of a signed operand (`2**-3`, `2*-3`), never a
 * closer, so `**2**-3**` keeps `2**-3` whole as `**10**6 rps**` keeps
 * `10**6`.
 */
const SIGNED_DIGIT = String.raw`[-+\u2212]\p{N}`;
/** Opening and closing brackets, paired. */
const BRACKET_PAIRS: ReadonlyMap<string, string> = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

/**
 * True when every bracket in `text` closes one opened before it in `text`
 * and none is left open. Emphasis never crosses a bracket, so emphasised
 * text must balance its brackets: in `f(*1)*` and `(f(*1))*` the `*` inside
 * the parentheses does not pair with the one after them.
 */
function bracketsBalance(text: string): boolean {
  const open: string[] = [];
  for (const char of text) {
    const opener = BRACKET_PAIRS.get(char);
    if (opener !== undefined) {
      if (open.pop() !== opener) return false;
    } else if (char === "(" || char === "[" || char === "{") {
      open.push(char);
    }
  }
  return open.length === 0;
}

/** A replacement that drops a delimiter pair only when the emphasised text balances its brackets ({@link bracketsBalance}). */
function reduceBalanced(match: string, inner: string): string {
  return bracketsBalance(inner) ? inner : match;
}

/**
 * The longest `**…**` or `__…__` span reduced, in characters. The text
 * between these delimiters may hold anything, so without a bound every
 * unclosed opener scanned the rest of the item and 20,000 `**a ` took
 * about a second; a longer span keeps its delimiters, the safe side.
 */
const MAX_EMPHASIS = 500;

/** The emphasis rules of step 3 of {@link plainTextOf}, in the order they run. */
interface EmphasisRules {
  readonly strong: RegExp;
  readonly dunder: RegExp;
  readonly star: RegExp;
  readonly underscore: RegExp;
}

/**
 * Build the emphasis rules for one item. A held literal (a URL, escape or
 * code span) is a boundary, so the item's sentinel joins the boundary
 * classes and the rules are built per item.
 *
 * `*` and `**`: an opener glued to punctuation or a symbol after it must
 * come after a boundary ({@link BEFORE_OPENER}), and a closer glued to
 * punctuation or a symbol before it must come before one
 * ({@link AFTER_CLOSER} or `/`). An opener and a closer that touch letters
 * or digits inside pair freely, at a non-word boundary outside, so `(*see*)`,
 * `“**fast**”` and `**30%**,` still reduce while `COUNT(*)`, `v2.*, v3.*`
 * and `30%*, 12%*` do not.
 *
 * `_`: the opener must follow a boundary and the closer must precede one
 * (never `/` or `@`), whatever they touch inside, so `$_1_`, `_.map` and
 * `_jdoe_@ex.com` keep their underscores. The `__` rule is unchanged by
 * this guard: applying it there split `__init__/__main__`.
 *
 * Every rule also refuses emphasised text that starts with
 * {@link NOT_FIRST} or ends with {@link NOT_LAST}, and the `*`, `**` and
 * `_` replacements keep a pair whose text does not balance its brackets
 * ({@link reduceBalanced}). A `*` or `**` after a digit and before a signed
 * digit ({@link SIGNED_DIGIT}) is never a closer.
 */
function emphasisRules(sentinel: string): EmphasisRules {
  const afterOpener = String.raw`(?<=^|[${BEFORE_OPENER}${sentinel}])`;
  const beforeCloser = (extra: string): string => String.raw`(?=$|[${AFTER_CLOSER}${extra}${sentinel}])`;
  const opener = (delimiter: string): string =>
    String.raw`(?:${afterOpener}|(?!${delimiter}${PUNCT}))${delimiter}(?!${NOT_FIRST})`;
  const closer = (delimiter: string): string =>
    String.raw`(?<!${NOT_LAST})(?:(?<!${PUNCT})|(?=${delimiter}${beforeCloser("/")}))(?:(?<!\p{N})|(?!${delimiter}${SIGNED_DIGIT}))${delimiter}`;
  const span = String.raw`(?=\S)(.{1,${MAX_EMPHASIS}}?)(?<=\S)`;
  const STAR = String.raw`\*`;
  const DOUBLE_STAR = String.raw`\*\*`;
  return {
    strong: new RegExp(String.raw`(?<!${W})${opener(DOUBLE_STAR)}${span}${closer(DOUBLE_STAR)}(?!${W})`, "gu"),
    dunder: new RegExp(String.raw`(?<!${W})__${span}__(?!${W})`, "gu"),
    star: new RegExp(
      String.raw`(?<![\p{L}\p{M}\p{N}*])${opener(STAR)}([^\s*](?:[^*]*?[^\s*])?)${closer(STAR)}(?![\p{L}\p{M}\p{N}*])`,
      "gu",
    ),
    underscore: new RegExp(
      String.raw`${afterOpener}_(?!${NOT_FIRST})([^\s_](?:[^_]*?[^\s_])?)(?<!${NOT_LAST})_${beforeCloser("")}`,
      "gu",
    ),
  };
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
  // URLs are held too, whole, so emphasis stripping never eats a `_x_` or `*x*` inside one.
  out = out.replace(AUTOLINK, (_m, url: string) => hold(url));
  out = out.replace(BARE_URL, (url) => hold(url));
  // Strikethrough `~~x~~` is kept as typed: plain text has no strikethrough,
  // and dropping the tildes would present a deleted figure as a live one.
  const emphasis = emphasisRules(sentinel);
  // `**x**` is strong emphasis only at a non-word boundary: the opening `**`
  // not preceded and the closing `**` not followed by a letter, combining
  // mark, digit or `_`. Anywhere else `**` is kept as typed, so the exponent
  // operators in `10**6 to 10**9`, `x**2 + y**2` and `a**b**c` keep their
  // meaning; glued to punctuation it pairs only at a boundary, so the globs
  // in `src/**/*.ts` keep theirs.
  out = out.replace(emphasis.strong, reduceBalanced);
  // `__x__` is strong emphasis only when `x` has whitespace or a non-word
  // character. Around a single identifier-like token it is a dunder name
  // (`__init__`, `__slots__`, `__call__()`), whatever follows, and keeps its
  // underscores: dropping them could misstate a claim, keeping them cannot.
  out = out.replace(emphasis.dunder, (match: string, inner: string) => (IDENTIFIER_TOKEN.test(inner) ? match : inner));
  // Single-delimiter emphasis only at a word-like boundary, so `5*3*2`,
  // `2 * 3`, `COUNT(*)`, `snake_case_name`, `a_b` and `$_1_` keep their characters.
  out = out.replace(emphasis.star, reduceBalanced);
  out = out.replace(emphasis.underscore, reduceBalanced);

  // 4. Restore held literals, then collapse ASCII whitespace and trim the edges. `trim()` strips
  //    exactly what `\s` matches, in linear time; `/^\s+|\s+$/gu` retried `\s+$` from every
  //    position of a whitespace run, and a 40,000-character NBSP run took seconds.
  const restore = new RegExp(`${sentinel}(\\d+)${sentinel}`, "g");
  // A held URL may itself contain held escapes and code spans, so restore until stable.
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(restore, (_m, index: string) => literals[Number(index)] ?? "");
  }
  return out.replace(ASCII_SPACE_RUN, " ").trim();
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
