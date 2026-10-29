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
import { ExportRefusal } from "../lib/exportRefusal.ts";
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
 * emulator), may be loaded. Guards against a tampered response handing
 * the page a `javascript:` or `data:` URL.
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

/** Shown inline when the callable's URL fails {@link isSafeDownloadUrl}. */
export const UNSAFE_DOWNLOAD_LINK_MESSAGE =
  "The export returned an unexpected download link, so nothing was downloaded.";

/**
 * How long the hidden download frame stays in the document. Long enough
 * for the signed URL's response headers to arrive on a slow connection
 * (the browser then owns the download, and removing the frame does not
 * cancel it); short enough that repeated exports do not pile up frames.
 */
export const DOWNLOAD_FRAME_LIFETIME_MS = 60_000;

export interface StartDownloadOptions {
  readonly doc?: Document;
  /** Test seam for the removal timer. */
  readonly schedule?: (run: () => void, ms: number) => unknown;
}

/**
 * Start the browser download of `url` by loading it in a hidden iframe,
 * which is removed after {@link DOWNLOAD_FRAME_LIFETIME_MS}.
 *
 * Why a frame and not a same-tab navigation. The response is
 * `Content-Disposition: attachment`, so a successful navigation leaves
 * the page where it is. A failed one does not: a 403, a signed URL that
 * expired before the click, or the emulator's 404 answers with an error
 * page (Cloud Storage's is XML), and a top-level navigation (an anchor
 * click or a `window.location` assignment) replaces the editor with it.
 * Loaded in a frame, that error page lands in the frame and the editor
 * stays.
 *
 * The trade-off: the frame's response is cross-origin, so the page
 * cannot read it, and a failed download is silent (no file arrives and
 * no inline error shows). Keeping the editor wins over reporting a rare
 * expiry; the user can export again, which signs a fresh URL. Nothing
 * else is lost: an anchor's `download` attribute is ignored cross-origin,
 * so the server's `Content-Disposition` named the file before and still
 * does, and no popup blocker applies even though this runs after an
 * `await`.
 */
export function startDownload(url: string, options: StartDownloadOptions = {}): void {
  if (!isSafeDownloadUrl(url)) {
    throw new ExportRefusal(UNSAFE_DOWNLOAD_LINK_MESSAGE);
  }
  const doc = options.doc ?? document;
  const schedule = options.schedule ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const frame = doc.createElement("iframe");
  frame.style.display = "none";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.referrerPolicy = "no-referrer";
  frame.dataset.exportDownload = "true";
  frame.src = url;
  doc.body.appendChild(frame);
  schedule(() => frame.remove(), DOWNLOAD_FRAME_LIFETIME_MS);
}

export interface ExportAndDownloadDeps {
  readonly invoke?: typeof invokeExportAsset;
  /** Defaults to {@link startDownload}, which names nothing itself: the server's disposition does. */
  readonly download?: (url: string, filename: string) => void;
}

/**
 * The one entry point export surfaces use: call `exportAsset`, then start
 * the download from the returned URL. Holds a per-invocation busy lease
 * across both steps (code-modification-rules § Busy leases), so the
 * update-reload prompt never appears mid-export. Rejects with the
 * callable error, or the download-link `ExportRefusal`, for the caller
 * to show inline.
 */
export async function exportAndDownload(
  applicationId: string,
  assetId: string,
  format: ExportFormat,
  deps: ExportAndDownloadDeps = {},
): Promise<ExportAssetResponse> {
  const invoke = deps.invoke ?? invokeExportAsset;
  const download = deps.download ?? ((url: string) => startDownload(url));
  const releaseBusy = beginAppBusy("export.asset");
  try {
    const response = await invoke(applicationId, assetId, format);
    download(response.url, response.filename);
    return response;
  } finally {
    releaseBusy();
  }
}
