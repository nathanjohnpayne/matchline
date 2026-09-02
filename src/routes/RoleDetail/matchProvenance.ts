/**
 * Whether a persisted `UnitMatch`'s prose may be shown to the
 * user as a claim (#444).
 *
 * ## What this replaced
 *
 * `MatchCard` used to ask whether `component_applicability` was
 * present. That was correct — the field and the rationale's
 * axis-gating shipped together in #435, so presence was an exact
 * proxy for "generated under the gated rule" — and it was a
 * **coincidence being used as a contract**. Nothing declared the
 * relationship, so nothing could break it loudly: a partial
 * write, a field split, or a migration populating the map
 * separately would have started trusting ungated prose with no
 * test able to notice. `nathanpayne-codex` flagged it during the
 * Phase 4b review of #438.
 *
 * ## Why the predicate is a compound
 *
 * A version field alone cannot replace the inference, because
 * rows written by #435 have a trustworthy rationale and no
 * version:
 *
 * | tier      | components | applicability | version | trustworthy |
 * |-----------|-----------|---------------|---------|-------------|
 * | pre-#131  | absent    | absent        | absent  | no          |
 * | pre-#435  | present   | absent        | absent  | no          |
 * | #435-era  | present   | present       | absent  | **yes**     |
 * | post-#444 | present   | present       | 1       | yes         |
 *
 * So the bridge is unavoidable. What changes is that it is now
 * explicit, dated, and has a stated end condition rather than
 * being an implicit rule that would have lived forever.
 *
 * ## Removing the bridge
 *
 * Drop the `component_applicability` clause once no row can be
 * #435-era — i.e. once every Role has been re-matched since this
 * shipped. One rerun of the matching pipeline heals a Role, and
 * `runMatchingPipeline` stamps `schema_version` on every write.
 * There is no migration; the corpus heals as Roles are used.
 * Until then, deleting the clause silently hides sound
 * rationales, which is why `matchProvenance.test.ts` pins the
 * #435-era tier explicitly.
 */

import type { UnitMatch } from "../../types/capability.ts";

/**
 * The lowest `schema_version` whose `rationale` was generated
 * under #435's axis-gating.
 *
 * Reader-side mirror of `MATCH_SCHEMA_VERSION` in
 * `functions/src/matching/pipeline.ts`. The two cannot share a
 * module — this one is imported at runtime by the browser bundle,
 * and the functions package is not — so
 * `tests/match-schema-version.test.ts` pins them against each
 * other, the same arrangement the callable timeout tables use.
 */
export const RATIONALE_GATED_SCHEMA_VERSION = 1;

export function isRationaleTrustworthy(
  match: Pick<UnitMatch, "schema_version" | "component_applicability">,
): boolean {
  if (
    match.schema_version !== undefined &&
    match.schema_version >= RATIONALE_GATED_SCHEMA_VERSION
  ) {
    return true;
  }
  // The #435-era bridge. See the docblock for when it goes.
  return match.component_applicability !== undefined;
}
