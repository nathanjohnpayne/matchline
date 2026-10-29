/**
 * The export gate's attestation and evidence checks, shared by the
 * editor (`src/routes/ApplicationEditor/exportGate.ts`) and the
 * `exportAsset` callable (#521, parent #33).
 *
 * The editor disables Export unless these hold; the callable re-checks
 * the same condition on the server before it renders a byte, so a
 * client that ignores (or edits) the disabled control still cannot
 * export. One definition, so the two can never disagree about what
 * "validated" means:
 *
 *   1. The content is attestable (`isAttestableContent`).
 *   2. The server-owned attestation (#502) for the asset's CURRENT
 *      content version (`assetContentVersion`) exists, names this
 *      asset (and, server side, this Application and owner) and says
 *      `passed`. A pass recorded for earlier content lives under a
 *      different doc id and a different `content_version`, so a stale
 *      pass never covers edited content.
 *   3. The attestation records the Unit versions it read
 *      (`validated_unit_versions` is an object), and every Unit any item
 *      cites still exists, is approved, and is at the
 *      `unitEvidenceVersion` the validator recorded for it.
 *
 * Dependency-light so the app imports it across the package boundary,
 * as it does `./attestation.ts`.
 */

import type { GeneratedAssetContent } from "../types/crm.js";
import {
  assetContentVersion,
  isAttestableContent,
  type ValidationAttestation,
} from "./attestation.js";
import { unitEvidenceVersion, type UnitEvidenceFields } from "./unitEvidenceVersion.js";

/** Why the gate refuses, most specific first within each group. */
export type ExportGateRefusal =
  | "malformed-content"
  | "no-attestation"
  | "attestation-mismatch"
  | "not-passed"
  | "evidence-unrecorded"
  | "evidence-missing"
  | "evidence-unapproved"
  | "evidence-outdated"
  | "evidence-changed";

/**
 * The recorded-version forms older than `UNIT_EVIDENCE_VERSION_PREFIX`:
 * `ev1:` and `ev2:`, and the pre-prefix form, which recorded the Unit's
 * `updated_at` (an ISO timestamp). Listed rather than "anything not
 * `ev3:`", so a newer prefix written by functions deployed ahead of
 * the app bundle is not mistaken for an older one (#485 review).
 */
const OLDER_EVIDENCE_VERSION = /^(?:ev1:|ev2:|\d{4}-\d{2}-\d{2}T)/;

/**
 * True when `recorded` is an evidence version in a known older form:
 * the verdict was reached on text the validator no longer reads.
 * False for the current prefix and for any form this code does not
 * know, such as a newer prefix.
 */
export function isOlderEvidenceVersion(recorded: string): boolean {
  return OLDER_EVIDENCE_VERSION.test(recorded);
}

/** Every Unit id cited by any item of `content`, in first-seen order. */
export function citedUnitIdsOf(content: GeneratedAssetContent): ReadonlySet<string> {
  const ids = new Set<string>();
  const items = [content.summary, ...content.bullets, ...content.skills, ...(content.education ?? [])];
  for (const item of items) {
    for (const id of item.source_unit_ids) ids.add(id);
  }
  return ids;
}

/** A Unit as the gate reads it: its evidence fields and its approval. */
export type GateUnit = UnitEvidenceFields & { readonly user_approved?: boolean };

export interface CitedEvidenceCounts {
  /** Cited, but no such Unit exists for the owner. */
  readonly missing: number;
  /** Exists, but `user_approved !== true`. */
  readonly unapproved: number;
  /** Recorded under an older evidence format (`isOlderEvidenceVersion`). */
  readonly outdated: number;
  /** Current version differs from the recorded one, or none was recorded. */
  readonly edited: number;
}

/**
 * Count the cited Units whose grounding is no longer what the
 * validator read. Each cited Unit lands in at most one bucket, by
 * precedence missing > unapproved > outdated > edited.
 */
export function citedEvidenceCounts(
  content: GeneratedAssetContent,
  versions: Readonly<Record<string, string>>,
  unitsById: ReadonlyMap<string, GateUnit>,
): CitedEvidenceCounts {
  let missing = 0;
  let unapproved = 0;
  let outdated = 0;
  let edited = 0;
  for (const id of citedUnitIdsOf(content)) {
    const unit = unitsById.get(id);
    if (unit === undefined) {
      missing += 1;
    } else if (unit.user_approved !== true) {
      unapproved += 1;
    } else {
      const recorded = versions[id];
      if (typeof recorded === "string" && isOlderEvidenceVersion(recorded)) {
        // Recorded under an earlier evidence format (#485): the Unit
        // may be untouched, but the verdict was not reached on the text
        // the validator reads now.
        outdated += 1;
      } else if (recorded !== unitEvidenceVersion(unit)) {
        // A cited Unit the validator did not load (absent key) was not
        // evidence for this verdict either. A prefix newer than the
        // current one lands here too: it cannot be checked, so it is
        // not claimed to be outdated.
        edited += 1;
      }
    }
  }
  return { missing, unapproved, outdated, edited };
}

/** The ids an attestation must name. Omitted ids are not compared. */
export interface AttestationScope {
  readonly assetId: string;
  readonly applicationId?: string;
  readonly ownerUid?: string;
}

/**
 * Whether `attestation` is a passing verdict for exactly `content`.
 * Returns `null` when it is, otherwise why not. Does not check that
 * the content is attestable; `checkExportGate` does that first.
 */
export function attestationRefusal(
  scope: AttestationScope,
  content: GeneratedAssetContent,
  attestation: ValidationAttestation | null,
): ExportGateRefusal | null {
  if (attestation === null) return "no-attestation";
  if (
    attestation.asset_id !== scope.assetId ||
    (scope.applicationId !== undefined && attestation.application_id !== scope.applicationId) ||
    (scope.ownerUid !== undefined && attestation.owner_uid !== scope.ownerUid) ||
    attestation.content_version !== assetContentVersion(content)
  ) {
    return "attestation-mismatch";
  }
  if (attestation.status !== "passed") return "not-passed";
  return null;
}

/** Map counts to the most severe evidence refusal, or `null`. */
export function evidenceRefusal(counts: CitedEvidenceCounts): ExportGateRefusal | null {
  if (counts.missing > 0) return "evidence-missing";
  if (counts.unapproved > 0) return "evidence-unapproved";
  if (counts.outdated > 0) return "evidence-outdated";
  if (counts.edited > 0) return "evidence-changed";
  return null;
}

/**
 * A plain object, as `validated_unit_versions` must be: not null, not an
 * array. The editor's gate uses it too, so a malformed attestation blocks
 * Export there instead of throwing while the editor renders.
 */
export function isVersionMap(value: unknown): value is Readonly<Record<string, string>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ExportGateInput {
  readonly scope: AttestationScope;
  /** The asset's `generated_content`, as loaded; `unknown` until checked. */
  readonly content: unknown;
  /** The attestation stored for `assetContentVersion(content)`, or `null`. */
  readonly attestation: ValidationAttestation | null;
  /** The owner's Units, keyed by id; only cited ones are consulted. */
  readonly unitsById: ReadonlyMap<string, GateUnit>;
}

export type ExportGateResult =
  | { readonly ok: true; readonly content: GeneratedAssetContent }
  | { readonly ok: false; readonly reason: ExportGateRefusal };

/**
 * The whole gate, in order: attestable content, then the attestation,
 * then the cited evidence. On success returns the same `content`
 * object it checked, narrowed, so the caller renders exactly the
 * fingerprinted content and nothing re-read after the check.
 */
export function checkExportGate(input: ExportGateInput): ExportGateResult {
  if (!isAttestableContent(input.content)) return { ok: false, reason: "malformed-content" };
  const content = input.content as GeneratedAssetContent;
  const attested = attestationRefusal(input.scope, content, input.attestation);
  if (attested !== null) return { ok: false, reason: attested };
  // `attestation` is non-null here: attestationRefusal returned null.
  const versions: unknown = (input.attestation as ValidationAttestation).validated_unit_versions;
  // A stored attestation is data, not a type: one without a version map
  // (or with a non-object one) records no evidence to compare against, so
  // it refuses rather than throwing a TypeError on `versions[id]`.
  if (!isVersionMap(versions)) return { ok: false, reason: "evidence-unrecorded" };
  const evidence = evidenceRefusal(citedEvidenceCounts(content, versions, input.unitsById));
  if (evidence !== null) return { ok: false, reason: evidence };
  return { ok: true, content };
}
