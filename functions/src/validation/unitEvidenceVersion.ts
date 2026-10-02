/**
 * The version of a Unit **as validation evidence**: a fingerprint over
 * exactly the fields the traceability check shows the model
 * (`formatUnit` in `./traceability.ts`). The validator records it per
 * loaded Unit in `validated_unit_versions`, and the editor's export
 * gate recomputes it from the live Unit, so a verdict stops counting
 * the moment any evidence it was computed from differs.
 *
 * ## Why not `updated_at`
 *
 * The first version recorded each Unit's `updated_at`. That is only a
 * version if every write advances it, and one does not: the exported
 * `upsertExperienceUnit` in `src/services/experienceUnits.ts` writes
 * the caller's object verbatim, timestamp included, and
 * `firestore.rules` does not require the timestamp to change. Changed
 * evidence could therefore arrive under the validated timestamp and
 * leave export enabled for text the validator never read. Codex P1 on
 * PR #501; `src/routes/RoleDetail/evidenceKey.ts` hit the same
 * contract gap on PR #446. Hashing the content removes the dependence
 * on that contract instead of relying on it holding everywhere.
 *
 * ## The rule for changing this
 *
 * A field belongs here if and only if the validator reads it to reach
 * a verdict. Omitting one it reads lets an edit to that field keep a
 * stale verdict; adding one it ignores only forces a harmless re-run.
 * Approval is deliberately absent: the gate checks `user_approved`
 * directly, and the validator loads approved Units only.
 *
 * Dependency-free on purpose: the app imports this file across the
 * package boundary (as it does `../types/capability.ts`), so the
 * server and the editor compute the same value from one definition.
 */

import { sha256Hex } from "./sha256.js";

/** The subset of `ExperienceUnit` the validator reads. */
export interface UnitEvidenceFields {
  readonly id: string;
  readonly raw_text: string;
  readonly normalized_summary: string;
  readonly metrics?: readonly {
    readonly claim: string;
    readonly value?: number;
    readonly unit?: string;
    readonly direction?: string;
  }[];
  readonly seniority_signals?: readonly string[];
  readonly scope_signals?: readonly string[];
}

/**
 * Bump when the field list or encoding changes, so a verdict recorded
 * under the old definition reads as changed rather than colliding.
 */
const VERSION_PREFIX = "ev2:";

export function unitEvidenceVersion(unit: UnitEvidenceFields): string {
  // JSON, not delimiters: the encoding is lossless, so two different
  // field sets can only collide through the hash itself, and SHA-256
  // makes a crafted collision infeasible (`./sha256.ts`).
  const canonical = JSON.stringify([
    unit.id,
    unit.raw_text,
    unit.normalized_summary,
    (unit.metrics ?? []).map((m) => [
      m.claim,
      m.value ?? null,
      m.unit ?? null,
      m.direction ?? null,
    ]),
    unit.seniority_signals ?? [],
    unit.scope_signals ?? [],
  ]);
  return VERSION_PREFIX + sha256Hex(canonical);
}
