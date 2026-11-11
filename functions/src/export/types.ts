/**
 * Shared export renderer contract (#517, parent #33).
 *
 * One module per format lives in `functions/src/export/` and implements
 * {@link AssetRenderer}: it takes the asset's `GeneratedAssetContent` and
 * returns the file bytes, the content type and the file extension. The
 * export callable (#521) dispatches by {@link ExportFormat} through a
 * registry, so the DOCX (#525) and PDF (#527) slices only add a renderer.
 *
 * Zero-fabrication contract: a renderer changes presentation only
 * (markup reduction, whitespace, layout). It never adds, drops, reorders
 * or rewrites an item, so the exported file says exactly what the
 * validated content says.
 *
 * Dependency-light (type-only imports) so the app can import these
 * types across the package boundary, as it does `../validation/attestation.ts`.
 */

import type { AssetFormat, GeneratedAssetContent } from "../types/crm.js";

/** The downloadable formats. `json` is the internal storage shape, never an export. */
export type ExportFormat = Exclude<AssetFormat, "json">;

/** Final menu and registry order: PDF, DOCX, Text (#523). */
export const EXPORT_FORMAT_ORDER: readonly ExportFormat[] = ["pdf", "docx", "txt"];

/** What a renderer produces: the file, ready to upload as-is. */
export interface RenderedExport {
  /** File bytes. Text formats are UTF-8 with no byte-order mark. */
  readonly bytes: Uint8Array;
  /** MIME type for the stored object, e.g. `text/plain; charset=utf-8`. */
  readonly contentType: string;
  /** File extension without the dot, e.g. `txt`. */
  readonly extension: string;
}

export interface AssetRenderer {
  readonly format: ExportFormat;
  readonly contentType: string;
  readonly extension: string;
  /**
   * Pure: no network, Firestore or Storage access. Deterministic: the same
   * content always yields byte-identical output. Async so renderers that
   * need it (PDF) fit the same contract; plain text resolves immediately.
   * Rejects with {@link InvalidExportContent} when `content` is not
   * well-formed asset content.
   */
  render(content: GeneratedAssetContent): Promise<RenderedExport>;
}

/** Thrown (or rejected) when the content handed to a renderer is malformed. */
export class InvalidExportContent extends Error {
  constructor(message = "Export content is malformed: expected summary, bullets, skills and optional education items with string text.") {
    super(message);
    this.name = "InvalidExportContent";
  }
}
