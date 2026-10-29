/**
 * Where an export is written and how its download URL is made (#521).
 *
 * ## Object path
 *
 * `applications/{applicationId}/{assetId}.{ext}` in the project's
 * default bucket. One object per asset and format: re-exporting
 * overwrites it, so Storage never accumulates copies of old content.
 *
 * ## Never public
 *
 * `storage.rules` deny every client read and write under
 * `applications/`. The object is written with the admin SDK, with no
 * `predefinedAcl`, no `makePublic()` and no Firebase download token, so
 * the ONLY way to read it is the short-lived V4 signed URL this module
 * returns. The download filename is carried by the signed
 * `response-content-disposition`, not only by object metadata.
 *
 * ## Emulator branch
 *
 * The admin SDK writes to the Storage emulator whenever
 * `FIREBASE_STORAGE_EMULATOR_HOST` (or `STORAGE_EMULATOR_HOST`) is
 * set. The URL branch keys on exactly that condition, not on whether
 * signing credentials exist: on Cloud Run there is no private key yet
 * signing works (through IAM `signBlob` as the runtime service
 * account), and on a laptop ADC may hold a real key, so signing would
 * "succeed" with a production URL for an object that only exists in
 * the emulator. Under the emulator the URL is the emulator's
 * GCS-style object URL, which serves the bytes without a token. It is
 * produced only when the emulator env is set AND the process is not a
 * deployed runtime: a stray emulator host in a deployed function's env
 * (say, a `functions/.env.<project>` entry) must never turn the download
 * into an unsigned URL, so that combination throws instead (the callable
 * maps it to `internal`).
 */

import { getStorage } from "firebase-admin/storage";

import type { RenderedExport } from "./types.js";

/** How long a download URL stays valid. The client starts the download at once. */
export const EXPORT_URL_TTL_MS = 5 * 60_000;

/** The narrow slice of `@google-cloud/storage` `File` this module uses. */
export interface ExportFileLike {
  save(
    data: Buffer,
    options: {
      readonly resumable: boolean;
      readonly contentType: string;
      readonly metadata: { readonly contentDisposition: string; readonly cacheControl: string };
    },
  ): Promise<unknown>;
  getSignedUrl(config: {
    readonly version: "v4";
    readonly action: "read";
    readonly expires: number;
    readonly responseDisposition: string;
    readonly responseType: string;
  }): Promise<[string]>;
}

/** The narrow slice of `@google-cloud/storage` `Bucket` this module uses. */
export interface ExportBucketLike {
  readonly name: string;
  file(path: string): ExportFileLike;
}

/** The project's default bucket, via the admin SDK. */
export function defaultExportBucket(name?: string): ExportBucketLike {
  return getStorage().bucket(name) as unknown as ExportBucketLike;
}

/**
 * `applications/{applicationId}/{assetId}.{extension}`. Callers pass
 * ids already validated against the callable's allow-list
 * (`[A-Za-z0-9_-]{1,128}`), so no `/`, `.` or `..` segment reaches the path.
 */
export function exportObjectPath(applicationId: string, assetId: string, extension: string): string {
  return `applications/${applicationId}/${assetId}.${extension}`;
}

/**
 * Write the rendered file, replacing any earlier export at `path`.
 * Private: no ACL, no download token; `no-store` so no shared cache
 * keeps a copy.
 */
export async function writeExport(
  file: ExportFileLike,
  rendered: RenderedExport,
  disposition: string,
): Promise<void> {
  await file.save(Buffer.from(rendered.bytes), {
    resumable: false,
    contentType: rendered.contentType,
    metadata: { contentDisposition: disposition, cacheControl: "private, no-store" },
  });
}

/**
 * The Storage emulator's `host:port`, or `null` outside the emulator.
 * Mirrors the admin SDK, which derives `STORAGE_EMULATOR_HOST` from
 * `FIREBASE_STORAGE_EMULATOR_HOST`.
 */
export function storageEmulatorHost(env: Readonly<Record<string, string | undefined>>): string | null {
  const firebaseHost = env.FIREBASE_STORAGE_EMULATOR_HOST?.trim();
  if (firebaseHost) return firebaseHost;
  const gcsHost = env.STORAGE_EMULATOR_HOST?.trim();
  if (gcsHost) return gcsHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return null;
}

/**
 * Thrown when a Storage emulator host is set inside what looks like a
 * deployed Cloud Functions / Cloud Run runtime.
 */
export class StorageEmulatorInDeployedRuntime extends Error {
  constructor() {
    super(
      "A Storage emulator host is set in a deployed runtime; refusing to return an unsigned download URL.",
    );
    this.name = "StorageEmulatorInDeployedRuntime";
  }
}

/**
 * True when the process runs on deployed Cloud Functions / Cloud Run and
 * not under the Firebase emulator suite. The Functions emulator sets
 * `FUNCTIONS_EMULATOR=true` (and may also set the Cloud Run markers);
 * a deployed runtime sets `K_SERVICE`, `K_REVISION` or `FUNCTION_TARGET`
 * without it. A test or script process sets none of them.
 */
export function isDeployedRuntime(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.FUNCTIONS_EMULATOR === "true") return false;
  return [env.K_SERVICE, env.K_REVISION, env.FUNCTION_TARGET].some((v) => (v?.trim() ?? "") !== "");
}

export interface DownloadUrlInput {
  readonly file: ExportFileLike;
  readonly bucketName: string;
  readonly path: string;
  readonly disposition: string;
  readonly contentType: string;
  readonly nowMs: number;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface DownloadUrl {
  readonly url: string;
  readonly expiresAt: string;
  /** `signed` in production; `emulator` only when the emulator env is set outside a deployed runtime. */
  readonly kind: "signed" | "emulator";
}

/** A short-lived signed URL, or the emulator's object URL under the emulator. */
export async function downloadUrl(input: DownloadUrlInput): Promise<DownloadUrl> {
  const expires = input.nowMs + EXPORT_URL_TTL_MS;
  const expiresAt = new Date(expires).toISOString();
  const emulatorHost = storageEmulatorHost(input.env);
  if (emulatorHost !== null) {
    if (isDeployedRuntime(input.env)) throw new StorageEmulatorInDeployedRuntime();
    const objectPath = input.path.split("/").map(encodeURIComponent).join("/");
    return {
      url: `http://${emulatorHost}/${encodeURIComponent(input.bucketName)}/${objectPath}`,
      expiresAt,
      kind: "emulator",
    };
  }
  const [url] = await input.file.getSignedUrl({
    version: "v4",
    action: "read",
    expires,
    responseDisposition: input.disposition,
    responseType: input.contentType,
  });
  return { url, expiresAt, kind: "signed" };
}
