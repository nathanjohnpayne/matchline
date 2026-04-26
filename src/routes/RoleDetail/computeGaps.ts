/**
 * Pure helper: compute the unmet must-have Requirements
 * for a Role (#21 / sub-issue #130).
 *
 * "Unmet must-have" = a Requirement where:
 *   - `must_have: true`, AND
 *   - no `UnitMatch` for the Requirement has `final_score
 *     >= GAP_THRESHOLD` (default 0.4 per parent #21 spec)
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
 * Output ordering: input order is preserved (the helper
 * `sortRequirementsForDisplay` in
 * `groupMatchesByRequirement.ts` is the canonical sort,
 * and the container passes Requirements in already-sorted
 * order to the Matches tab; gaps render in the same
 * priority order).
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
  // final_score. We only need the BEST match per
  // Requirement to know whether it qualifies — no need to
  // walk all matches per check.
  const bestScoreByReq = new Map<string, number>();
  for (const m of matches) {
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
