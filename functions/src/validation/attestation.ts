/**
 * Server-owned validation attestations (#502).
 *
 * The verdict the export gate trusts used to live only on the asset,
 * inside `applications.generated_assets[]`: a list the client updates
 * and Firestore rules cannot iterate. Undo also legitimately writes a
 * previous `passed` back, so the rules could not stop a client from
 * writing `validation_status: "passed"` itself.
 *
 * `validateAsset` now also records each verdict here, in
 * `applications/{applicationId}/validations/{attestationId}`, a
 * subcollection the client may read and never write. The record is
 * keyed by the asset AND a fingerprint of the exact content that was
 * validated, so:
 *
 *   - the export gate trusts `passed` only from a record for the
 *     asset's CURRENT content, which no client write can produce;
 *   - any edit moves the content to a fingerprint with no record,
 *     which reads as unvalidated without anyone flipping a status;
 *   - undo needs no copied status to be trusted: restoring content
 *     that was validated finds that content's record again.
 *
 * The asset-level `validation_status` / `validation_flags` stay as
 * the editor's display state; they are no longer the attestation.
 *
 * Dependency-light so the app imports it across the package boundary,
 * as it does `./unitEvidenceVersion.ts`.
 */

import { sha256Hex } from "./sha256.js";

export const VALIDATIONS_SUBCOLLECTION = "validations";

export interface ValidationAttestation {
  readonly owner_uid: string;
  readonly application_id: string;
  readonly asset_id: string;
  /** `assetContentVersion` of the content this verdict is about. */
  readonly content_version: string;
  readonly status: "passed" | "failed";
  readonly validated_at: string;
  /** See `AssetRef.validated_unit_versions`. */
  readonly validated_unit_versions: Readonly<Record<string, string>>;
}

/**
 * JSON with object keys sorted at every level, so two copies of the
 * same content serialize identically however their keys were ordered
 * (the server reads the asset back from Firestore; the editor holds
 * the object it rendered). Undefined object members are dropped, as
 * `JSON.stringify` drops them; Firestore never stores them.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), (_key, v: unknown) =>
    // `JSON.stringify` writes NaN and ±Infinity as `null`, so content
    // differing only in those would share a fingerprint and therefore
    // an attestation (#506 review). Encode them distinctly; never
    // throw, because the editor fingerprints during render.
    typeof v === "number" && !Number.isFinite(v) ? { $nonFiniteNumber: String(v) } : v,
  );
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Bump when the encoding changes, so a record made under the old one
 * reads as "no record for this content" rather than colliding.
 */
const CONTENT_VERSION_PREFIX = "cv2-";

/** The sections whose items the editor can reorder in place. */
const REORDERABLE_SECTIONS = ["bullets", "skills", "education"] as const;

function itemId(item: unknown): string {
  return item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
    ? (item as { id: string }).id
    : "";
}

/**
 * The content as validation sees it: each section's items ordered by
 * id, not by position. The validator checks every item independently
 * and keys flags by item id, so moving an item within its section
 * cannot change the verdict, and `reorderBulletsInAsset` keeps
 * `passed` without re-validating. A position-sensitive fingerprint
 * would strand that verdict on every drag (Codex P2 on #506). Section
 * membership still counts: a skill is not a bullet.
 */
function validatedShape(content: unknown): unknown {
  if (content === null || typeof content !== "object" || Array.isArray(content)) return content;
  const out: Record<string, unknown> = { ...(content as Record<string, unknown>) };
  for (const section of REORDERABLE_SECTIONS) {
    const items = out[section];
    if (Array.isArray(items)) {
      out[section] = [...items].sort((a, b) => {
        const ia = itemId(a);
        const ib = itemId(b);
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      });
    }
  }
  return out;
}

/**
 * Fingerprint of an asset's `generated_content`, insensitive to item
 * order within a section (see `validatedShape`) and to object key
 * order (see `canonicalJson`).
 */
export function assetContentVersion(content: unknown): string {
  return CONTENT_VERSION_PREFIX + sha256Hex(canonicalJson(validatedShape(content)));
}

/**
 * True when `content` has exactly the shape the validator can check
 * in full: a summary item and bullet / skill (and optional education)
 * item lists, where every item carries a string `id`, a string `text`
 * and a list of string `source_unit_ids`. The validator skips an item
 * whose `text` is not a string, yet the editor still renders it, so
 * malformed content must never be attested (#506 review). Fields the
 * validator and the editor both ignore are not inspected.
 */
export function isAttestableContent(content: unknown): boolean {
  if (content === null || typeof content !== "object" || Array.isArray(content)) return false;
  const c = content as Record<string, unknown>;
  const isItem = (item: unknown): boolean => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const i = item as Record<string, unknown>;
    return (
      typeof i.id === "string" &&
      typeof i.text === "string" &&
      Array.isArray(i.source_unit_ids) &&
      i.source_unit_ids.every((id) => typeof id === "string")
    );
  };
  const isList = (value: unknown): boolean => Array.isArray(value) && value.every(isItem);
  return (
    isItem(c.summary) &&
    isList(c.bullets) &&
    isList(c.skills) &&
    (c.education === undefined || isList(c.education))
  );
}

/** Doc id of the attestation for `assetId` at `contentVersion`. */
export function validationAttestationId(assetId: string, contentVersion: string): string {
  return `${assetId}__${contentVersion}`;
}
