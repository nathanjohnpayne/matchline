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
 * view exists to prevent. Codex P1 round 1 on PR #435.
 *
 * Such matches are NOT hidden — `specs/matchline.md`'s
 * non-goals are explicit that low-quality matches still
 * appear in the Gaps view. They render and rank normally on
 * the Matches tab; they just can't silently satisfy a hard
 * requirement.
 *
 * `structural_evidence === undefined` counts as satisfying.
 * Rows written before the field existed were scored under
 * the older rule, where an unrecognized Requirement side
 * hard-zeroed the structural axes instead of paying out a
 * neutral — so there is no unearned credit for the gate to
 * catch, and treating legacy rows as suspect would flip
 * every previously-covered Requirement to a gap until the
 * user reran matching.
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

export const GAP_THRESHOLD = 0.4;

export function computeGaps(
  requirements: readonly JobRequirementUnit[],
  matches: readonly UnitMatch[],
  threshold: number = GAP_THRESHOLD,
): readonly JobRequirementUnit[] {
  // Index matches by requirement id with their max
  // final_score AMONG NON-REJECTED matches. Rejected
  // matches don't count toward satisfying the Requirement
  // — same semantics as the matching pipeline's filter at
  // #82.
  const bestScoreByReq = new Map<string, number>();
  for (const m of matches) {
    if (m.user_rejected) continue;
    // A match with no structural evidence can't cover a
    // must-have no matter how it scored — see the docstring.
    // `undefined` is legacy data and passes.
    if (m.structural_evidence === false) continue;
    const prev = bestScoreByReq.get(m.job_requirement_unit_id);
    if (prev === undefined || m.final_score > prev) {
      bestScoreByReq.set(m.job_requirement_unit_id, m.final_score);
    }
  }

  return requirements.filter((req) => {
    if (!req.must_have) return false;
    const best = bestScoreByReq.get(req.id);
    return best === undefined || best < threshold;
  });
}
