/**
 * HTTPS callable that exports a validated résumé as a downloadable
 * file (#521, parent #33). One call: `{ applicationId, assetId,
 * format }` → owner check → the export gate, re-checked on the server
 * → render → one private Storage object → a short-lived signed URL.
 *
 * ## The gate is re-checked here, not trusted from the client
 *
 * The editor disables Export unless the gate is open, but a disabled
 * button is not a security boundary. Before rendering a byte, this
 * handler runs the same check (`../validation/exportGate.ts`):
 *
 *   1. the content is attestable;
 *   2. the server-owned attestation (#502) for the asset's CURRENT
 *      content version (`assetContentVersion`) exists, names this
 *      owner, Application and asset, and says `passed` — a pass
 *      recorded for earlier content lives under another id, so a stale
 *      pass never exports;
 *   3. every cited Unit still exists, is approved, and is at the
 *      evidence version the validator recorded.
 *
 * Anything else is `failed-precondition` and NOTHING is written. The
 * asset-level `validation_status` is not consulted: it is
 * client-writable display state, and the attestation is the authority.
 *
 * ## Zero fabrication
 *
 * The Application is read once. The renderer receives the very
 * `generated_content` object whose fingerprint the attestation
 * matched; nothing is re-read between the check and the render, so a
 * concurrent edit cannot slip unvalidated text into the file. The
 * renderer changes presentation only (`../export/types.ts`).
 *
 * ## Side effects
 *
 * Exactly one Storage object, `applications/{applicationId}/
 * {assetId}.{ext}`, overwritten on re-export. No Firestore write. The
 * object is private (`storage.rules` deny all client access; no ACL,
 * no download token), readable only through the returned URL, and the
 * bucket's lifecycle rule deletes it a day after it is written. See
 * `../export/storage.ts` for the signed-URL and emulator branches and
 * retention.
 *
 * Auth-required; the owner allowlist runs first. A missing or
 * not-owned Application or asset is the same `permission-denied`, so
 * the response cannot be used to enumerate ids.
 */

import { HttpsError, onCall, type CallableRequest } from "firebase-functions/v2/https";

import { contentDisposition, exportFilename } from "../export/filename.js";
import { rendererFor, UnsupportedExportFormat } from "../export/registry.js";
import {
  assertExportEnvironment,
  defaultExportBucket,
  downloadUrl,
  exportObjectPath,
  writeExport,
  type ExportBucketLike,
} from "../export/storage.js";
import type { AssetRenderer, ExportFormat } from "../export/types.js";
import { getAdminDb } from "../firestore/admin.js";
import type { AssetRef, GeneratedAssetContent } from "../types/crm.js";
import {
  assetContentVersion,
  isAttestableContent,
  validationAttestationId,
  VALIDATIONS_SUBCOLLECTION,
  type ValidationAttestation,
} from "../validation/attestation.js";
import {
  checkExportGate,
  citedUnitIdsOf,
  type ExportGateRefusal,
  type GateUnit,
} from "../validation/exportGate.js";
import { CALLABLE_TIMEOUT_SECONDS } from "./timeouts.js";
import { requireOwner } from "./ownerGate.js";

export interface ExportAssetData {
  readonly applicationId?: string;
  readonly assetId?: string;
  readonly format?: string;
}

export interface ExportAssetResponse {
  /** Signed V4 read URL (production) or the emulator object URL. */
  readonly url: string;
  /** `{Company} — {Title} — Resume.{ext}`, blank parts left out. */
  readonly filename: string;
  readonly format: ExportFormat;
  readonly contentType: string;
  /** When `url` stops working (ISO). */
  readonly expiresAt: string;
}

/** The fields of `applications/{id}` this handler reads. */
export interface ExportApplicationDoc {
  readonly owner_uid: string;
  readonly role_id?: string;
  readonly generated_assets?: readonly AssetRef[];
}

/** The fields of `roles/{id}` the filename uses. */
export interface ExportRoleDoc {
  readonly owner_uid: string;
  readonly title?: string;
  readonly company_id?: string;
}

/** The fields of `companies/{id}` the filename uses. */
export interface ExportCompanyDoc {
  readonly owner_uid: string;
  readonly name?: string;
}

/** Test seams. Production uses the admin SDK for all of them. */
export interface ExportAssetDeps {
  readonly loadApplication?: (applicationId: string) => Promise<ExportApplicationDoc | null>;
  readonly loadAttestation?: (applicationId: string, attestationId: string) => Promise<ValidationAttestation | null>;
  /** The owner's Units with these ids, approved or not. */
  readonly loadUnits?: (unitIds: readonly string[], ownerUid: string) => Promise<readonly GateUnit[]>;
  readonly loadRole?: (roleId: string) => Promise<ExportRoleDoc | null>;
  readonly loadCompany?: (companyId: string) => Promise<ExportCompanyDoc | null>;
  readonly bucket?: () => ExportBucketLike;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const NOT_FOUND_MESSAGE = "Application or asset not found, or not owned by caller.";

/** One plain sentence per refusal; `details.reason` carries the code. */
const REFUSAL_MESSAGES: Readonly<Record<ExportGateRefusal, string>> = {
  "malformed-content": "This resume's content is malformed and can't be exported; regenerate it.",
  "no-attestation":
    "This resume's current content isn't covered by a passing validation run. Re-run validation before exporting.",
  "attestation-mismatch":
    "This resume's current content isn't covered by a passing validation run. Re-run validation before exporting.",
  "not-passed":
    "This resume's last validation run didn't pass. Resolve its flags and re-run validation before exporting.",
  "evidence-missing":
    "This resume cites Units that no longer exist. Edit or remove the bullets that cite them, then re-validate.",
  "evidence-unapproved":
    "This resume cites Units that are no longer approved. Re-approve them, or edit or remove the bullets that cite them.",
  "evidence-outdated":
    "Validation has been updated since this resume was last checked. Re-run validation before exporting.",
  "evidence-changed":
    "Units this resume cites have changed since the last validation run read them. Re-run validation before exporting.",
};

function refuse(reason: ExportGateRefusal): HttpsError {
  return new HttpsError("failed-precondition", REFUSAL_MESSAGES[reason], { reason });
}

/**
 * Inner handler, exported so unit tests call it with a fabricated
 * `CallableRequest` and stubbed deps (same pattern as
 * `generateResumeHandler`).
 */
export async function exportAssetHandler(
  request: CallableRequest<ExportAssetData>,
  deps: ExportAssetDeps = {},
): Promise<ExportAssetResponse> {
  // Owner allowlist first — before argument parsing and before any
  // Firestore or Storage client exists (#439; see ./ownerGate.ts).
  const ownerUid = requireOwner(request, "exportAsset");

  const data = (request.data ?? {}) as ExportAssetData;
  const applicationId = validateId("applicationId", data.applicationId);
  const assetId = validateId("assetId", data.assetId);

  // Format before any read: an unsupported format costs nothing.
  let renderer: AssetRenderer;
  try {
    renderer = rendererFor(data.format);
  } catch (err) {
    if (err instanceof UnsupportedExportFormat) {
      throw new HttpsError("invalid-argument", err.message);
    }
    throw err;
  }

  const loadApplication = deps.loadApplication ?? defaultLoadApplication;
  const loadAttestation = deps.loadAttestation ?? defaultLoadAttestation;
  const loadUnits = deps.loadUnits ?? defaultLoadUnits;
  const loadRole = deps.loadRole ?? defaultLoadRole;
  const loadCompany = deps.loadCompany ?? defaultLoadCompany;

  // One read of the Application; everything below works from it.
  const app = await loadApplication(applicationId);
  if (app === null || app.owner_uid !== ownerUid) {
    throw new HttpsError("permission-denied", NOT_FOUND_MESSAGE);
  }
  const asset = (app.generated_assets ?? []).find((a) => a.id === assetId);
  if (asset === undefined) {
    throw new HttpsError("permission-denied", NOT_FOUND_MESSAGE);
  }
  if (asset.kind !== "resume") {
    throw new HttpsError("failed-precondition", "Only resumes can be exported.", { reason: "not-a-resume" });
  }
  const content: unknown = asset.generated_content;
  if (content === undefined || content === null) {
    throw new HttpsError("failed-precondition", "This resume has no generated content to export yet.", {
      reason: "no-content",
    });
  }
  if (!isAttestableContent(content)) throw refuse("malformed-content");

  // The attestation for exactly this content (#502).
  const contentVersion = assetContentVersion(content);
  const attestation = await loadAttestation(applicationId, validationAttestationId(assetId, contentVersion));
  // Only cited Units matter; load them unfiltered by approval so the
  // gate can tell "missing" from "unapproved".
  const cited = [...citedUnitIdsOf(content as GeneratedAssetContent)];
  const units = attestation === null ? [] : await loadUnits(cited, ownerUid);
  const gate = checkExportGate({
    scope: { assetId, applicationId, ownerUid },
    content,
    attestation,
    unitsById: new Map(units.map((u) => [u.id, u])),
  });
  if (!gate.ok) throw refuse(gate.reason);

  // Filename parts. A missing or foreign Role or Company drops the
  // part; it never fails the export and is never filled in.
  const role = typeof app.role_id === "string" && app.role_id.length > 0 ? await loadRole(app.role_id) : null;
  const ownRole = role !== null && role.owner_uid === ownerUid ? role : null;
  const company =
    ownRole !== null && typeof ownRole.company_id === "string" && ownRole.company_id.length > 0
      ? await loadCompany(ownRole.company_id)
      : null;
  const ownCompany = company !== null && company.owner_uid === ownerUid ? company : null;

  const rendered = await renderer.render(gate.content);
  const filename = exportFilename({
    company: ownCompany?.name,
    title: ownRole?.title,
    extension: rendered.extension,
  });
  const disposition = contentDisposition(filename);
  const path = exportObjectPath(applicationId, assetId, rendered.extension);

  const env = deps.env ?? process.env;
  try {
    // A Storage emulator host inside a deployed runtime is refused before
    // the bucket is touched, so a refused export leaves no object behind.
    assertExportEnvironment(env);
    const bucket = (deps.bucket ?? defaultExportBucket)();
    const file = bucket.file(path);
    await writeExport(file, rendered, disposition);
    const link = await downloadUrl({
      file,
      bucketName: bucket.name,
      path,
      disposition,
      contentType: rendered.contentType,
      nowMs: (deps.now ?? Date.now)(),
      env,
    });
    return {
      url: link.url,
      filename,
      format: renderer.format,
      contentType: rendered.contentType,
      expiresAt: link.expiresAt,
    };
  } catch (err) {
    // Storage write or signing failed (bucket not provisioned, missing
    // signBlob permission), or the environment was refused. Log the cause
    // for the operator; the client gets a retryable message without
    // infrastructure detail.
    console.error("exportAsset: storage write or URL signing failed", { applicationId, assetId, path, err });
    throw new HttpsError("internal", "The export file couldn't be prepared. Try again in a moment.");
  }
}

export const exportAssetCallable = onCall(
  // Reads, a render and one upload plus a signBlob round trip; see ./timeouts.ts.
  { timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.exportAsset },
  (request: CallableRequest<ExportAssetData>) => exportAssetHandler(request),
);

/**
 * Non-empty, trimmed, and free of `/` (a Firestore path delimiter and,
 * here, a Storage path delimiter). Same shape as `validateAsset`.
 */
function validateId(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError(
      "invalid-argument",
      `exportAsset expects { applicationId: string, assetId: string, format: string } with non-empty ${name}.`,
    );
  }
  const trimmed = value.trim();
  // Allow-list, not deny-list: the id reaches a Firestore document path, the
  // attestation id and the Storage object name. Firestore auto-ids and the
  // generated asset ids (UUIDs) fit this shape; ".", "..", "\\", "%2F", "#",
  // "?" and control characters do not.
  if (!SAFE_ID.test(trimmed)) {
    throw new HttpsError(
      "invalid-argument",
      `exportAsset.${name} must be 1-128 characters of letters, digits, "_" or "-".`,
    );
  }
  return trimmed;
}

/** The id shape exportAsset accepts before any read. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// -- Default Firestore implementations --------------------------------------

const APPLICATIONS_COLLECTION = "applications";
const UNITS_COLLECTION = "experienceUnits";
const ROLES_COLLECTION = "roles";
const COMPANIES_COLLECTION = "companies";
/** Firestore's cap on values in one `in` filter. */
const FIRESTORE_IN_LIMIT = 30;

async function defaultLoadApplication(applicationId: string): Promise<ExportApplicationDoc | null> {
  const snap = await getAdminDb().collection(APPLICATIONS_COLLECTION).doc(applicationId).get();
  return snap.exists ? (snap.data() as ExportApplicationDoc) : null;
}

async function defaultLoadAttestation(
  applicationId: string,
  attestationId: string,
): Promise<ValidationAttestation | null> {
  const snap = await getAdminDb()
    .collection(APPLICATIONS_COLLECTION)
    .doc(applicationId)
    .collection(VALIDATIONS_SUBCOLLECTION)
    .doc(attestationId)
    .get();
  return snap.exists ? (snap.data() as ValidationAttestation) : null;
}

async function defaultLoadUnits(unitIds: readonly string[], ownerUid: string): Promise<readonly GateUnit[]> {
  if (unitIds.length === 0) return [];
  const db = getAdminDb();
  const out: GateUnit[] = [];
  for (let i = 0; i < unitIds.length; i += FIRESTORE_IN_LIMIT) {
    const chunk = unitIds.slice(i, i + FIRESTORE_IN_LIMIT);
    // Owner-scoped, NOT approval-filtered (unlike validate.ts): the
    // gate itself refuses unapproved Units, and must be able to say so.
    const snap = await db
      .collection(UNITS_COLLECTION)
      .where("owner_uid", "==", ownerUid)
      .where("id", "in", chunk)
      .get();
    out.push(...(snap.docs.map((d) => d.data()) as GateUnit[]));
  }
  return out;
}

async function defaultLoadRole(roleId: string): Promise<ExportRoleDoc | null> {
  const snap = await getAdminDb().collection(ROLES_COLLECTION).doc(roleId).get();
  return snap.exists ? (snap.data() as ExportRoleDoc) : null;
}

async function defaultLoadCompany(companyId: string): Promise<ExportCompanyDoc | null> {
  const snap = await getAdminDb().collection(COMPANIES_COLLECTION).doc(companyId).get();
  return snap.exists ? (snap.data() as ExportCompanyDoc) : null;
}
