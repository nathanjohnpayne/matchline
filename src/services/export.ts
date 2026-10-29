/**
 * Client wrapper around the `exportAsset` callable
 * (`functions/src/callables/exportAsset.ts`, #521) and the browser
 * download that follows it (#523).
 *
 * The server re-checks the export gate against the server-owned
 * attestation for the asset's current content, renders the file, writes
 * it to `applications/{applicationId}/{assetId}.{ext}` in Storage and
 * returns a short-lived signed URL. This module only asks for that URL
 * and starts the download; it never builds file bytes itself, so the
 * exported file is always the server's rendering of attested content.
 *
 * Surface-agnostic: it takes ids and a format, nothing from a route, so
 * the Application Editor today and the Application Package (#628) later
 * call the same {@link exportAndDownload}.
 */

import { httpsCallable } from "firebase/functions";

import { getFunctionsClient } from "../firebase.ts";
import { beginAppBusy } from "../lib/appBusy.ts";
import type { ExportFormat } from "../../functions/src/export/types.ts";
import { callableOptions } from "./callable-timeouts.ts";

export type { ExportFormat } from "../../functions/src/export/types.ts";

/** Mirror of the callable's response (`ExportAssetResponse` server-side). */
export interface ExportAssetResponse {
  /** Short-lived signed URL (production) or the Storage emulator URL. */
  readonly url: string;
  /** "{Company} — {Title} — Resume.{ext}", set server-side in Content-Disposition too. */
  readonly filename: string;
  readonly format: ExportFormat;
  readonly contentType: string;
  /** ISO timestamp after which the signed URL stops working. */
  readonly expiresAt: string;
}

/**
 * Invoke the server-side `exportAsset` callable. Rejects with the
 * callable error unchanged, so the caller can render it inline with
 * `friendlyCallableError` (a gate refusal arrives as
 * `failed-precondition` with a server-written sentence).
 */
export async function invokeExportAsset(
  applicationId: string,
  assetId: string,
  format: ExportFormat,
): Promise<ExportAssetResponse> {
  const fn = httpsCallable<
    { applicationId: string; assetId: string; format: ExportFormat },
    ExportAssetResponse
  >(getFunctionsClient(), "exportAsset", callableOptions("exportAsset"));
  const result = await fn({ applicationId, assetId, format });
  return result.data;
}

/** Loopback hosts the Storage emulator URL may use (never produced in production). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Only an `https:` URL, or `http:` on a loopback host (the Storage
 * emulator), may be navigated to. Guards against a tampered response
 * handing the page a `javascript:` or `data:` URL.
 */
export function isSafeDownloadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Start the browser download of `url`. A same-tab navigation through an
 * anchor with `download`: the response is `Content-Disposition:
 * attachment`, so the page stays where it is, and unlike `target=_blank`
 * no popup blocker applies even though the click comes after an `await`.
 * The `download` attribute is ignored cross-origin, which is why the
 * server-side disposition is what actually names the file.
 */
export function startDownload(url: string, filename: string, doc: Document = document): void {
  if (!isSafeDownloadUrl(url)) {
    throw new Error("The export returned an unexpected download link.");
  }
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  doc.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

export interface ExportAndDownloadDeps {
  readonly invoke?: typeof invokeExportAsset;
  readonly download?: (url: string, filename: string) => void;
}

/**
 * The one entry point export surfaces use: call `exportAsset`, then start
 * the download from the returned URL. Holds a per-invocation busy lease
 * across both steps (code-modification-rules § Busy leases), so the
 * update-reload prompt never appears mid-export. Rejects with the
 * callable error, or the download-link error, for the caller to show
 * inline.
 */
export async function exportAndDownload(
  applicationId: string,
  assetId: string,
  format: ExportFormat,
  deps: ExportAndDownloadDeps = {},
): Promise<ExportAssetResponse> {
  const invoke = deps.invoke ?? invokeExportAsset;
  const download = deps.download ?? ((url: string, filename: string) => startDownload(url, filename));
  const releaseBusy = beginAppBusy("export.asset");
  try {
    const response = await invoke(applicationId, assetId, format);
    download(response.url, response.filename);
    return response;
  } finally {
    releaseBusy();
  }
}
