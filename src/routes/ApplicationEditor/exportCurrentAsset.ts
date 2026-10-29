/**
 * The Application Editor's export action (#523): export the asset the
 * editor shows, through the surface-agnostic `exportAndDownload`.
 *
 * Without both ids there is nothing to export, so the action rejects
 * instead of resolving: a resolved `onExport` reads to the Export menu as
 * "the download started", and the user would get no file and no message.
 * The rejection is an `ExportRefusal`, so the menu shows its sentence
 * inline as written rather than the generic copy.
 */

import { ExportRefusal } from "../../lib/exportRefusal.ts";
import { exportAndDownload, type ExportFormat } from "../../services/export.ts";

export const EXPORT_UNAVAILABLE_MESSAGE = "This resume can't be exported right now.";

export async function exportCurrentAsset(
  applicationId: string | undefined,
  assetId: string | undefined,
  format: ExportFormat,
  run: (applicationId: string, assetId: string, format: ExportFormat) => Promise<unknown> = exportAndDownload,
): Promise<void> {
  if (applicationId === undefined || applicationId === "" || assetId === undefined || assetId === "") {
    throw new ExportRefusal(EXPORT_UNAVAILABLE_MESSAGE);
  }
  await run(applicationId, assetId, format);
}
