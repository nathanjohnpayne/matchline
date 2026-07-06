/**
 * Pure helper: group UnitMatches by Requirement for the
 * Matches tab (#21 / sub-issue #129).
 *
 * Input: a Role's Requirements + the (already-loaded) Matches
 * for that Role. Output: one row per Requirement with its
 * top-K matches sorted by `final_score` descending.
 *
 * Why this lives outside the component:
 *
 *   - Pure function — no React, no Firestore. Testable via
 *     plain vitest, exercised independently of the view.
 *   - The matching pipeline (#99) persists Matches sorted by
 *     `final_score` desc already; we sort again here as
 *     defense in depth (a future server-side change that
 *     un-sorts shouldn't silently break the UI ordering).
 *   - The TOP_K constant lives here (not magic-numbered into
 *     the component) so a future change is one line.
 *
 * Order contract:
 *   - Requirements are returned in DETERMINISTIC ORDER:
 *       (1) `must_have: true` rows before `must_have: false`
 *       (2) priority "high" → "medium" → "low" within each
 *           must_have band
 *       (3) tie-break by `id` asc (lexicographic, stable)
 *     The Firestore subscription doesn't `orderBy` (would
 *     need a composite index for what's a small client-side
 *     sort), so the helper enforces the contract here.
 *     cursor CHANGES_REQUESTED round 1 on PR #132 caught a
 *     prior version that hand-waved this to "caller's
 *     responsibility."
 *   - Within each Requirement's `matches` array, top-K by
 *     `final_score` desc. Ties broken by `created_at` asc
 *     (older matches stable-rank earlier — arbitrary but
 *     deterministic).
 */

import type {
  JobRequirementUnit,
  RequirementPriority,
  UnitMatch,
} from "../../types/capability.ts";

export const TOP_K = 5;

export interface RequirementWithMatches {
  readonly requirement: JobRequirementUnit;
  readonly matches: readonly UnitMatch[];
}

/**
 * Numeric weight for `RequirementPriority` so the sort
 * comparator stays one-line. Higher = more important.
 * Exported for tests to reference rather than hard-code.
 */
export const PRIORITY_WEIGHT: Record<RequirementPriority, number> = {
  high: 2,
  medium: 1,
  low: 0,
};

/**
 * Deterministic Requirement ordering. Pure function so the
 * helper's tests can pin the rule independently. See the
 * `Order contract` block in this module's docstring for
 * the full rule.
 */
export function sortRequirementsForDisplay(
  requirements: readonly JobRequirementUnit[],
): JobRequirementUnit[] {
  return [...requirements].sort((a, b) => {
    // 1. must_have first.
    if (a.must_have !== b.must_have) {
      return a.must_have ? -1 : 1;
    }
    // 2. priority weight desc.
    const wA = PRIORITY_WEIGHT[a.priority];
    const wB = PRIORITY_WEIGHT[b.priority];
    if (wA !== wB) return wB - wA;
    // 3. tie-break by id asc.
    return a.id.localeCompare(b.id);
  });
}

export function groupMatchesByRequirement(
  requirements: readonly JobRequirementUnit[],
  matches: readonly UnitMatch[],
  topK: number = TOP_K,
): readonly RequirementWithMatches[] {
  // Sort Requirements deterministically up front. The
  // Firestore subscription returns whatever doc order
  // Firestore picks (typically by document id, but not
  // guaranteed); the matching pipeline (#99) doesn't
  // re-order Requirements when it persists Matches. Pinning
  // the order here keeps the UI rendering stable across
  // re-mounts and across Firestore's internal storage
  // changes. cursor CHANGES_REQUESTED round 1 on PR #132.
  const sortedReqs = sortRequirementsForDisplay(requirements);

  // Normalize topK before use. It's caller-overridable and
  // fed straight into `Array.prototype.slice` below; a
  // negative value would slice from the end of the array
  // instead of yielding an empty/full list, and a
  // non-integer or NaN value would produce similarly
  // surprising results.
  const safeTopK = Number.isFinite(topK) ? Math.max(0, Math.trunc(topK)) : TOP_K;

  // Index matches by requirement id once, then walk
  // requirements in their sorted order. Single pass over
  // matches; O(R + M) total + O(R log R) for the requirement
  // sort.
  const byReq = new Map<string, UnitMatch[]>();
  for (const m of matches) {
    const list = byReq.get(m.job_requirement_unit_id);
    if (list === undefined) {
      byReq.set(m.job_requirement_unit_id, [m]);
    } else {
      list.push(m);
    }
  }

  return sortedReqs.map((requirement) => {
    const reqMatches = byReq.get(requirement.id) ?? [];
    // Sort + slice. Sort is stable in V8 — equal final_score
    // entries fall back to insertion order from the input
    // matches array. We additionally tie-break by created_at
    // for cross-engine determinism (the matching pipeline
    // already pre-sorts; this is belt-and-suspenders).
    const sorted = [...reqMatches].sort((a, b) => {
      if (b.final_score !== a.final_score) {
        return b.final_score - a.final_score;
      }
      // Older first — arbitrary but deterministic.
      return a.created_at.localeCompare(b.created_at);
    });
    return { requirement, matches: sorted.slice(0, safeTopK) };
  });
}
