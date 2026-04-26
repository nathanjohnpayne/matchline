/**
 * Pure helper: compute the unmet must-have Requirements
 * for a Role (#21 / sub-issue #130).
 *
 * "Unmet must-have" = a Requirement where:
 *   - `must_have: true`, AND
 *   - no `UnitMatch` for the Requirement is BOTH
 *     - non-rejected (`user_rejected: false`), AND
 *     - has `final_score >= GAP_THRESHOLD` (default 0.4
 *       per parent #21 spec)
 *
 * **Rejected matches do NOT count as satisfying.**
 * cursor CHANGES_REQUESTED round 1 on PR #133 caught the
 * gap: a user-rejected high-score match was still
 * satisfying `computeGaps`'s threshold check, so a
 * Requirement looked "covered" even after the user
 * explicitly rejected the only match that covered it.
 * Same shape as the matching pipeline's filter at #82
 * (`tests/rejected-exclusion.integration.test.ts`) — a
 * rejected match is dead to downstream readers.
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
