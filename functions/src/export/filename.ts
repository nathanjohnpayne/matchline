/**
 * Download filename and `Content-Disposition` for an export (#521).
 *
 * The file a recruiter receives is named `{Company} — {Title} —
 * Resume.{ext}`, with a real em dash (U+2014): the glyph loss #141
 * fixed in the editor must not reappear in a filename. Because an HTTP
 * header value cannot carry raw UTF-8 reliably, the header sends the
 * name twice (RFC 6266): `filename*` with the exact UTF-8 name per
 * RFC 5987, and a plain `filename` ASCII fallback for clients that
 * ignore `filename*`.
 *
 * A part that is missing or blank is left out rather than filled in:
 * Roles created today have no Company document behind their
 * `company_id`, and "Unknown company" must never be written into a
 * file someone else reads. No company gives `{Title} — Resume.{ext}`,
 * and neither part gives `Resume.{ext}`.
 *
 * Pure and deterministic.
 */

/** The separator between name parts: space, U+2014 EM DASH, space. */
export const FILENAME_SEPARATOR = " \u2014 ";

/** Longest a single part may be, in code points, before it is cut. */
export const MAX_FILENAME_PART_CODE_POINTS = 80;

// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069),
// direction marks (U+200E, U+200F, U+061C), zero-width space and word
// joiner (U+200B, U+2060) and the BOM (U+FEFF). A U+202E in a Company name
// would make "...Resume.txt" display reversed in Finder or Explorer, so
// the name a third party sees could hide its real extension. ZWNJ and ZWJ
// (U+200C, U+200D) are kept: Persian, Indic and emoji text needs them to
// render as typed, and they cannot reorder the name.
const INVISIBLE_FORMAT_CHARS = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
// Characters that are path separators or reserved on common file systems.
const RESERVED_CHARS = /[/\\:*?"<>|]/g;

/**
 * Make one name part safe to use in a filename on any common OS:
 * controls and bidi/zero-width format characters dropped, reserved
 * characters turned into spaces, whitespace
 * collapsed, leading dots stripped (no hidden or relative names), and
 * the part cut to {@link MAX_FILENAME_PART_CODE_POINTS} code points.
 * Everything else, including non-ASCII letters and dashes, is kept as
 * typed, without Unicode normalization.
 */
export function sanitizeFilenamePart(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_FORMAT_CHARS, "")
    .replace(RESERVED_CHARS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+/u, "")
    .trim();
  // Cut by code point so a surrogate pair (emoji, rare CJK) is never split.
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= MAX_FILENAME_PART_CODE_POINTS) return cleaned;
  return codePoints.slice(0, MAX_FILENAME_PART_CODE_POINTS).join("").trimEnd();
}

export interface ExportFilenameParts {
  readonly company?: string | null;
  readonly title?: string | null;
  /** File extension without the dot, e.g. `txt`. */
  readonly extension: string;
}

/** `{Company} — {Title} — Resume.{ext}`, leaving out blank parts. */
export function exportFilename({ company, title, extension }: ExportFilenameParts): string {
  const parts = [sanitizeFilenamePart(company), sanitizeFilenamePart(title)].filter((p) => p.length > 0);
  return [...parts, `Resume.${extension}`].join(FILENAME_SEPARATOR);
}

/**
 * The ASCII-only stand-in for the `filename` parameter. Dashes become
 * `-`; accented letters lose their accents (`Zürich` → `Zurich`); any
 * other non-ASCII character becomes `_`. Quotes and backslashes are
 * removed so the value can sit inside a quoted-string unescaped.
 *
 * NFKD runs after {@link sanitizeFilenamePart}, and it can produce what the
 * sanitizer removed: fullwidth `／＜＞：＊？｜` decompose to `/<>:*?|`, and
 * U+2024 ONE DOT LEADER to `.`, so a part that was safe as typed could
 * gain a path separator or a leading dot here. The reserved-character
 * replacement and the leading-dot strip are therefore applied again to the
 * ASCII result.
 */
export function asciiFallback(name: string): string {
  return name
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\]/g, "")
    .replace(RESERVED_CHARS, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .replace(/^[. ]+/, "")
    .trim();
}

/**
 * RFC 5987 `value-chars` encoding: `encodeURIComponent`, plus the
 * `'`, `(`, `)` and `*` it leaves alone, which RFC 5987 does not allow
 * unencoded.
 */
export function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`. The
 * whole header is ASCII, so it survives any HTTP stack and a signed
 * URL's `response-content-disposition` parameter unchanged.
 */
export function contentDisposition(name: string): string {
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${rfc5987(name)}`;
}
