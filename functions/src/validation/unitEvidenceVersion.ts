/**
 * The version of a Unit **as validation evidence**: a SHA-256 of
 * exactly the text the traceability check shows the model for it
 * (`formatUnit` in `./unitPromptText.ts`). The validator records it per
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
 * ## Why the prompt text, not a field list
 *
 * Hashing a hand-built encoding of "the fields the validator reads"
 * kept drifting from what the prompt actually prints: an explicit
 * `null` metric value and an omitted one, and `NaN` and `null`, each
 * hashed alike while the prompt rendered them differently (Codex P2s
 * on #506). Hashing the rendered text makes the version change if and
 * only if the validator's input changes, and any future change to the
 * prompt's Unit format moves the version with it. Approval is not
 * part of the text: the gate checks `user_approved` directly, and the
 * validator loads approved Units only.
 *
 * Dependency-free on purpose: the app imports this file across the
 * package boundary (as it does `../types/capability.ts`), so the
 * server and the editor compute the same value from one definition.
 */

import { formatUnit, type UnitPromptFields } from "./unitPromptText.js";
import { sha256Hex } from "./sha256.js";

/** The subset of `ExperienceUnit` the validator reads. */
export type UnitEvidenceFields = UnitPromptFields;

/**
 * Bump when the field list or encoding changes, so a verdict recorded
 * under the old definition reads as changed rather than colliding.
 */
const VERSION_PREFIX = "ev2:";

export function unitEvidenceVersion(unit: UnitEvidenceFields): string {
  // The exact text the traceability prompt shows the model for this
  // Unit (`./unitPromptText.ts`), so the version changes if and only if
  // what the validator reads changes: an explicit `null` metric value,
  // `NaN` and an omitted value all render differently there, and so
  // hash differently here (Codex P2s on #506). SHA-256 makes a crafted
  // collision infeasible (`./sha256.ts`).
  return VERSION_PREFIX + sha256Hex(formatUnit(unit));
}
