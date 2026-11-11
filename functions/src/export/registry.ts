/**
 * Export format registry (#521, parent #33).
 *
 * The `exportAsset` callable resolves its renderer here and nowhere
 * else, so adding a format is one entry in `RENDERERS`: the DOCX (#525)
 * and PDF (#527) slices register their renderers and touch nothing in
 * the callable. Plain text (#517) is the only format registered today.
 *
 * An unknown, unregistered or non-string format is rejected with the
 * typed {@link UnsupportedExportFormat}, which the callable maps to
 * `invalid-argument` before it reads any data.
 */

import { textRenderer } from "./text.js";
import { EXPORT_FORMAT_ORDER, type AssetRenderer, type ExportFormat } from "./types.js";

const RENDERERS: Readonly<Partial<Record<ExportFormat, AssetRenderer>>> = {
  txt: textRenderer,
};

/** How much of a caller's format string the error message echoes. */
const SHOWN_FORMAT_MAX = 32;

/**
 * Thrown when a requested format has no registered renderer. The message
 * reaches the caller as the `invalid-argument` text, so it echoes at most
 * {@link SHOWN_FORMAT_MAX} characters of a string format, JSON-escaped
 * (quotes, backslashes and control characters cannot shape the message),
 * and only the type of anything else.
 */
export class UnsupportedExportFormat extends Error {
  readonly format: unknown;
  constructor(format: unknown) {
    const shown = typeof format === "string" ? JSON.stringify(format.slice(0, SHOWN_FORMAT_MAX)) : typeof format;
    super(`Unsupported export format ${shown}. Supported: ${registeredExportFormats().join(", ")}.`);
    this.name = "UnsupportedExportFormat";
    this.format = format;
  }
}

function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMAT_ORDER as readonly string[]).includes(value);
}

/**
 * The renderer for `format`. Exact match only: `"TXT"` and `" txt"`
 * are rejected rather than guessed at, and `json` (the internal
 * storage shape) is never an export.
 */
export function rendererFor(format: unknown): AssetRenderer {
  if (typeof format !== "string" || !Object.hasOwn(RENDERERS, format) || !isExportFormat(format)) {
    throw new UnsupportedExportFormat(format);
  }
  const renderer = RENDERERS[format];
  if (renderer === undefined) throw new UnsupportedExportFormat(format);
  return renderer;
}

/** The registered formats, in the menu order `EXPORT_FORMAT_ORDER`. */
export function registeredExportFormats(): readonly ExportFormat[] {
  return EXPORT_FORMAT_ORDER.filter((f) => RENDERERS[f] !== undefined);
}
