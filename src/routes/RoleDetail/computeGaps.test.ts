/**
 * Pure-helper tests for `computeGaps` (#130).
 *
 * Pinned invariants (parent #21 spec):
 *   - must_have:true with no matches → gap
 *   - must_have:true with all matches < threshold → gap
 *   - must_have:true with at least one match >= threshold → NOT a gap
 *   - must_have:false is NEVER in the output (regardless of
 *     match coverage)
 *   - threshold override works for the eval harness
 *   - input order preserved in output (sort is the caller's
 *     concern; `sortRequirementsForDisplay` is upstream)
 */

import { describe, expect, it } from "vitest";

import type { JobRequirementUnit, UnitMatch } from "../../types/capability.ts";

import { GAP_THRESHOLD, computeGaps } from "./computeGaps.ts";

const ALICE = "user-alice";

function makeReq(
  id: string,
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  return {
    id,
    owner_uid: ALICE,
    role_id: "role-1",
    raw_text: `raw ${id}`,
    normalized_requirement: `Req ${id}`,
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "medium",
    must_have: true, // tests default to must_have; override per case
    extracted_from: "qualifications",
    ...overrides,
  };
}

function makeMatch(
  id: string,
  reqId: string,
  finalScore: number,
): UnitMatch {
  return {
    id,
    owner_uid: ALICE,
    role_id: "role-1",
    experience_unit_id: `unit-${id}`,
    job_requirement_unit_id: reqId,
    semantic_score: finalScore,
    rule_score: finalScore,
    final_score: finalScore,
    rationale: "",
    surface_evidence: "",
    approved_for_use: false,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("computeGaps", () => {
  it("flags must_have Requirements with no matches at all", () => {
    const reqs = [makeReq("r-naked-mh")];
    expect(computeGaps(reqs, []).map((r) => r.id)).toEqual(["r-naked-mh"]);
  });

  it("flags must_have Requirements where ALL matches are below threshold", () => {
    const reqs = [makeReq("r-weak-mh")];
    const matches = [
      makeMatch("m1", "r-weak-mh", 0.2),
      makeMatch("m2", "r-weak-mh", 0.35),
      makeMatch("m3", "r-weak-mh", 0.39), // still < 0.4
    ];
    expect(computeGaps(reqs, matches).map((r) => r.id)).toEqual(["r-weak-mh"]);
  });

  it("does NOT flag must_have Requirements with at least one match at threshold", () => {
    const reqs = [makeReq("r-met-mh")];
    const matches = [
      makeMatch("m-low", "r-met-mh", 0.2),
      makeMatch("m-exact", "r-met-mh", GAP_THRESHOLD), // exactly 0.4
    ];
    expect(computeGaps(reqs, matches)).toEqual([]);
  });

  it("does NOT flag must_have Requirements with at least one match above threshold", () => {
    const reqs = [makeReq("r-strong-mh")];
    const matches = [makeMatch("m-strong", "r-strong-mh", 0.85)];
    expect(computeGaps(reqs, matches)).toEqual([]);
  });

  it("NEVER flags non-must_have Requirements (even with zero matches)", () => {
    const reqs = [
      makeReq("r-nice-no-matches", { must_have: false }),
      makeReq("r-nice-weak", { must_have: false }),
    ];
    const matches = [makeMatch("m-weak", "r-nice-weak", 0.05)];
    expect(computeGaps(reqs, matches)).toEqual([]);
  });

  it("respects an override threshold (eval harness use case)", () => {
    const reqs = [makeReq("r-mid")];
    const matches = [makeMatch("m-mid", "r-mid", 0.55)];
    // At default 0.4, this is NOT a gap.
    expect(computeGaps(reqs, matches)).toEqual([]);
    // At 0.7, it IS a gap.
    expect(computeGaps(reqs, matches, 0.7).map((r) => r.id)).toEqual([
      "r-mid",
    ]);
  });

  it("preserves input order in the output", () => {
    const reqs = [
      makeReq("r-z"),
      makeReq("r-a"),
      makeReq("r-m"),
    ];
    const result = computeGaps(reqs, []).map((r) => r.id);
    expect(result).toEqual(["r-z", "r-a", "r-m"]);
  });

  it("composite case: mixed must_have / non-must_have / met / unmet", () => {
    const reqs = [
      makeReq("r-1-met-mh", { must_have: true }),
      makeReq("r-2-unmet-mh", { must_have: true }),
      makeReq("r-3-nice-met", { must_have: false }),
      makeReq("r-4-nice-unmet", { must_have: false }),
      makeReq("r-5-naked-mh", { must_have: true }),
    ];
    const matches = [
      makeMatch("m-r1", "r-1-met-mh", 0.8),
      makeMatch("m-r2-low", "r-2-unmet-mh", 0.3),
      makeMatch("m-r3", "r-3-nice-met", 0.9),
      // r-4-nice-unmet has no matches.
      // r-5-naked-mh has no matches.
    ];
    const result = computeGaps(reqs, matches).map((r) => r.id);
    expect(result).toEqual(["r-2-unmet-mh", "r-5-naked-mh"]);
  });

  it("uses the BEST match per Requirement (max final_score), not the first/last", () => {
    // Pin against a future code change that reads only the
    // first or last match per Requirement.
    const reqs = [makeReq("r-mh")];
    const matches = [
      makeMatch("m-low", "r-mh", 0.1),
      makeMatch("m-high", "r-mh", 0.9), // 0.9 should pull this above threshold
      makeMatch("m-mid", "r-mh", 0.5),
    ];
    expect(computeGaps(reqs, matches)).toEqual([]);
  });

  // -- cursor #133 r1: rejected matches don't satisfy ----------------------

  it("REJECTED FILTER (cursor #133 r1): a rejected high-score match does NOT satisfy a must-have", () => {
    // The load-bearing pin. Without this filter, a user
    // who rejects the ONLY qualifying match for a must-
    // have Requirement would see the Requirement marked
    // satisfied — the opposite of the spec's "honest
    // gaps" promise.
    const reqs = [makeReq("r-mh")];
    const matches = [
      // Score 0.85 — would otherwise satisfy the 0.4 threshold.
      // Rejected by the user → must NOT count.
      {
        ...makeMatch("m-rejected-high", "r-mh", 0.85),
        user_rejected: true,
      },
    ];
    expect(computeGaps(reqs, matches).map((r) => r.id)).toEqual(["r-mh"]);
  });

  it("REJECTED FILTER: when ALL matches for a must-have are rejected, the Requirement IS a gap", () => {
    const reqs = [makeReq("r-mh")];
    const matches = [
      { ...makeMatch("m1", "r-mh", 0.9), user_rejected: true },
      { ...makeMatch("m2", "r-mh", 0.7), user_rejected: true },
      { ...makeMatch("m3", "r-mh", 0.5), user_rejected: true },
    ];
    expect(computeGaps(reqs, matches).map((r) => r.id)).toEqual(["r-mh"]);
  });

  it("REJECTED FILTER: a non-rejected match still satisfies even when there are also rejected matches", () => {
    // The user might reject some and keep others; the
    // Requirement is still satisfied as long as ONE
    // non-rejected match clears the threshold.
    const reqs = [makeReq("r-mh")];
    const matches = [
      { ...makeMatch("m-rejected", "r-mh", 0.95), user_rejected: true },
      makeMatch("m-good", "r-mh", 0.55), // not rejected, above threshold
    ];
    expect(computeGaps(reqs, matches)).toEqual([]);
  });

  it("REJECTED FILTER: an approved-but-low-scoring match doesn't override threshold (approval is not a gap-clearer)", () => {
    // Approval gates GENERATION (#120/#121) but doesn't
    // affect gap computation — score thresholds are the
    // gap signal. A low-score approved match still leaves
    // the Requirement under-grounded.
    const reqs = [makeReq("r-mh")];
    const matches = [
      {
        ...makeMatch("m-low-approved", "r-mh", 0.2),
        approved_for_use: true,
      },
    ];
    expect(computeGaps(reqs, matches).map((r) => r.id)).toEqual(["r-mh"]);
  });
});
