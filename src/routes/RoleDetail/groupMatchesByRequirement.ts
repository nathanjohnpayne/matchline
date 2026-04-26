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
 *   - Requirements are returned in the order they appear in
 *     the input. Caller is responsible for upstream sorting
 *     (currently: by priority then must_have flag, set in
 *     the parsing pipeline #19).
 *   - Within each Requirement's `matches` array, top-K by
 *     `final_score` desc. Ties broken by `created_at` asc
 *     (older matches stable-rank earlier — arbitrary but
 *     deterministic).
 */

import type { JobRequirementUnit, UnitMatch } from "../../types/capability.ts";

export const TOP_K = 5;

export interface RequirementWithMatches {
  readonly requirement: JobRequirementUnit;
  readonly matches: readonly UnitMatch[];
}

export function groupMatchesByRequirement(
  requirements: readonly JobRequirementUnit[],
  matches: readonly UnitMatch[],
  topK: number = TOP_K,
): readonly RequirementWithMatches[] {
  // Index matches by requirement id once, then walk
  // requirements in their input order. Single pass over
  // matches; O(R + M) total.
  const byReq = new Map<string, UnitMatch[]>();
  for (const m of matches) {
    const list = byReq.get(m.job_requirement_unit_id);
    if (list === undefined) {
      byReq.set(m.job_requirement_unit_id, [m]);
    } else {
      list.push(m);
    }
  }

  return requirements.map((requirement) => {
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
    return { requirement, matches: sorted.slice(0, topK) };
  });
}
