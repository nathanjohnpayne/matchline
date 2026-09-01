/**
 * Pure helper: compute the unmet must-have Requirements
 * for a Role (#21 / sub-issue #130).
 *
 * "Unmet must-have" = a Requirement where:
 *   - `must_have: true`, AND
 *   - no `UnitMatch` for the Requirement is ALL THREE of
 *     - non-rejected (`user_rejected: false`), AND
 *     - has `final_score >= GAP_THRESHOLD` (default 0.4
 *       per parent #21 spec), AND
 *     - carries structural evidence
 *       (`structural_evidence !== false`)
 *
 * **A score alone is not evidence.** The scoring components
 * fall back to no-constraint defaults when a Requirement
 * doesn't constrain an axis — 0.5 on skill / tool / domain,
 * 1.0 on seniority and scope. That's deliberate (an
 * unconstrained axis must not read as a candidate
 * deficiency), but a Requirement that constrains NOTHING
 * evaluable stacks those defaults into ~0.425 of unearned
 * `rule_score`, and a recent Unit then clears 0.4 on
 * semantics alone. The credential-shaped Requirement
 * `jd.v1.md` emits with empty `keywords` / `tools` /
 * `domains` is the canonical case: "BS in Computer Science
 * required" would show as covered by whichever Unit happened
 * to embed closest, which is precisely the dishonesty this
 * view exists to prevent.
 *
 * Such matches are NOT hidden — `specs/matchline.md`'s
 * non-goals are explicit that low-quality matches still
 * appear in the Gaps view. They render and rank normally on
 * the Matches tab; they just can't silently satisfy a hard
 * requirement.
 *
 * **Legacy rows and the third state (#441).** Matches written
 * before `structural_evidence` existed were scored under a rule
 * that paid the same neutrals (both-empty Jaccard stored 0.5;
 * unconstrained seniority and scope stored 1.0), so a legacy row
 * can carry the identical unearned credit. #435 let them count
 * as satisfying anyway, so that deploying the gate could not
 * make an already-matched Role sprout gaps overnight — a
 * deliberate stopgap, not a claim that such rows are sound.
 *
 * `deriveMatchEvidence` (#441) is what retires the stopgap. It
 * resolves each legacy row from its ID-linked Unit/Requirement
 * pair, read-only, and hands the verdicts in through `evidence`.
 * Three outcomes, not two:
 *
 *   - `evidenced`     → can cover a must-have.
 *   - `unevidenced`   → cannot, exactly like a stored `false`.
 *   - `unverifiable`  → we could not check. Reported as a gap of
 *     its own kind rather than silently passing or silently
 *     failing, because "there is no match for this" and "there
 *     is a match we could not verify" are different things to
 *     tell someone about to write an application.
 *
 * **Absent `evidence`, the permissive rule stands.** The map is
 * optional and a match missing from it falls back to the old
 * reading. That is the required degradation: a derivation that
 * fails must never tighten into inventing gaps, so a failed or
 * still-in-flight call leaves the view exactly as it was in
 * #435. The caller surfaces the failure; it does not change the
 * verdicts.
 *
 * **Rejected matches do NOT count as satisfying.**
 * cursor CHANGES_REQUESTED round 1 on PR #133 caught the
 * gap: a user-rejected high-score match was still
 * satisfying `computeGaps`'s threshold check, so a
 * Requirement looked "covered" even after the user
 * explicitly rejected the only match that covered it.
 * The matching pipeline's carry-forward shape (cursor
 * #133 r2; `replaceMatchesForRole` preserves
 * `user_rejected` across rerun) makes the rejection
 * durable; this filter ensures the gaps view honors it.
 *
 * Why a 0.4 threshold:
 *   - The matching pipeline (#100) calibrated the score
 *     scale so that 0.4 sits at the boundary between
 *     "tangentially related" and "actually answers this
 *     Requirement." Below that, the rationale strings get
 *     hand-wavy.
 *   - The threshold is overridable so the Phase 3 eval
 *     harness (#25) can tune against real fixtures.
 *
 * Non-must-have Requirements are NEVER in the gaps output —
 * the user already accepted that those don't have to be
 * grounded. The point of the Gaps view is honesty: "here
 * are the things you'd need to address before this
 * Application is defensible."
 *
 * Output ordering: input order is preserved.
 */

import type {
  JobRequirementUnit,
  UnitMatch,
} from "../../types/capability.ts";
// Type-only, and therefore erased before bundling: nothing from
// the deployed functions package reaches the client. Declaring a
// second copy of this union in the app is the drift #443 exists
// to stop, so the callable's response shape has exactly one
// author. `types/evidence.ts` is a leaf with no imports —
// importing the *logic* module instead would drag `node:fs` in
// through the ontology loader, which the app has no types for.
import type { EvidenceVerdict } from "../../../functions/src/types/evidence.ts";

export const GAP_THRESHOLD = 0.4;

/**
 * Why a Requirement appears in the Gaps list.
 *
 * `unmet` is the original meaning: nothing qualifies. `unverifiable`
 * is #441's addition: something might qualify, but the evidence
 * derivation could not reach a verdict on it — an orphaned
 * Requirement id, a deleted Unit, or a Unit the matching pipeline
 * currently declines to score. The user's next action differs
 * between the two, so the view must not merge them.
 */
export type GapStatus = "unmet" | "unverifiable";

export interface Gap {
  readonly requirement: JobRequirementUnit;
  readonly status: GapStatus;
}

/**
 * Resolve one match to the verdict this function should act on.
 *
 * The derived map wins when it has an entry, because it already
 * folds in the stored field. Otherwise fall back to the persisted
 * boolean, and finally to the #435 permissive reading for a
 * legacy row we have no verdict for.
 */
function verdictFor(
  match: UnitMatch,
  evidence: ReadonlyMap<string, EvidenceVerdict> | undefined,
): EvidenceVerdict {
  const derived = evidence?.get(match.id);
  if (derived !== undefined) return derived;
  if (match.structural_evidence === false) return "unevidenced";
  // `true` is evidence; `undefined` is the legacy permissive pass.
  return "evidenced";
}

export function computeGaps(
  requirements: readonly JobRequirementUnit[],
  matches: readonly UnitMatch[],
  evidence?: ReadonlyMap<string, EvidenceVerdict>,
  threshold: number = GAP_THRESHOLD,
): readonly Gap[] {
  // Best final_score among non-rejected matches that can cover
  // the Requirement, and separately whether any non-rejected
  // match clears the threshold but could not be verified.
  // Rejected matches count for neither — same semantics as the
  // matching pipeline's filter at #82.
  const bestCovering = new Map<string, number>();
  const doubted = new Set<string>();
  for (const m of matches) {
    if (m.user_rejected) continue;
    const verdict = verdictFor(m, evidence);
    if (verdict === "unevidenced") continue;
    if (verdict === "unverifiable") {
      // Only a match that would otherwise have covered the
      // Requirement casts doubt. One scoring 0.1 was never going
      // to satisfy it, so being unable to verify it changes
      // nothing the user needs to know.
      if (m.final_score >= threshold) doubted.add(m.job_requirement_unit_id);
      continue;
    }
    const prev = bestCovering.get(m.job_requirement_unit_id);
    if (prev === undefined || m.final_score > prev) {
      bestCovering.set(m.job_requirement_unit_id, m.final_score);
    }
  }

  const gaps: Gap[] = [];
  for (const req of requirements) {
    if (!req.must_have) continue;
    const best = bestCovering.get(req.id);
    if (best !== undefined && best >= threshold) continue;
    gaps.push({
      requirement: req,
      status: doubted.has(req.id) ? "unverifiable" : "unmet",
    });
  }
  return gaps;
}
