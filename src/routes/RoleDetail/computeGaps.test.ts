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
  overrides: Partial<UnitMatch> = {},
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
    ...overrides,
  };
}

describe("computeGaps", () => {
  it("flags must_have Requirements with no matches at all", () => {
    const reqs = [makeReq("r-naked-mh")];
    expect(computeGaps(reqs, []).map((g) => g.requirement.id)).toEqual(["r-naked-mh"]);
  });

  it("flags must_have Requirements where ALL matches are below threshold", () => {
    const reqs = [makeReq("r-weak-mh")];
    const matches = [
      makeMatch("m1", "r-weak-mh", 0.2),
      makeMatch("m2", "r-weak-mh", 0.35),
      makeMatch("m3", "r-weak-mh", 0.39), // still < 0.4
    ];
    expect(computeGaps(reqs, matches).map((g) => g.requirement.id)).toEqual(["r-weak-mh"]);
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
    expect(computeGaps(reqs, matches, undefined, 0.7).map((g) => g.requirement.id)).toEqual([
      "r-mid",
    ]);
  });

  it("preserves input order in the output", () => {
    const reqs = [
      makeReq("r-z"),
      makeReq("r-a"),
      makeReq("r-m"),
    ];
    const result = computeGaps(reqs, []).map((g) => g.requirement.id);
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
    const result = computeGaps(reqs, matches).map((g) => g.requirement.id);
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
    expect(computeGaps(reqs, matches).map((g) => g.requirement.id)).toEqual(["r-mh"]);
  });

  it("REJECTED FILTER: when ALL matches for a must-have are rejected, the Requirement IS a gap", () => {
    const reqs = [makeReq("r-mh")];
    const matches = [
      { ...makeMatch("m1", "r-mh", 0.9), user_rejected: true },
      { ...makeMatch("m2", "r-mh", 0.7), user_rejected: true },
      { ...makeMatch("m3", "r-mh", 0.5), user_rejected: true },
    ];
    expect(computeGaps(reqs, matches).map((g) => g.requirement.id)).toEqual(["r-mh"]);
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
    expect(computeGaps(reqs, matches).map((g) => g.requirement.id)).toEqual(["r-mh"]);
  });
});

describe("computeGaps — structural-evidence gate (#430)", () => {
  const mustHave: JobRequirementUnit = {
    id: "r-credential",
    owner_uid: ALICE,
    role_id: "role-1",
    raw_text: "BS in Computer Science required",
    normalized_requirement: "BS in Computer Science",
    category: "credential",
    keywords: [],
    tools: [],
    domains: [],
    priority: "low",
    must_have: true,
    extracted_from: "qualifications",
  };

  it("does not treat a high-scoring evidence-free match as covering a must-have", () => {
    // A credential-shaped Requirement constrains nothing the
    // engine can evaluate, so every structural axis pays its
    // no-constraint default and a recent Unit sails past 0.4 on
    // semantics alone. Without the gate, "BS in Computer Science
    // required" reads as covered by whichever Unit embedded
    // closest.
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.52, { structural_evidence: false })],
    );
    expect(gaps.map((g) => g.requirement.id)).toEqual(["r-credential"]);
  });

  it("treats a scoring match WITH evidence as covering", () => {
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.52, { structural_evidence: true })],
    );
    expect(gaps).toEqual([]);
  });

  it("treats legacy matches (field absent) as covering", () => {
    // Pre-existing behaviour preserved deliberately: a Role the
    // user has already matched must not sprout gaps on deploy.
    // Those rows gain the gate the next time matching runs.
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.52)],
    );
    expect(gaps).toEqual([]);
  });

  it("still requires the score threshold when evidence IS present", () => {
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.39, { structural_evidence: true })],
    );
    expect(gaps.map((g) => g.requirement.id)).toEqual(["r-credential"]);
  });

  it("ignores an evidence-free match when a lower-scoring one has evidence", () => {
    // The evidence-free match must never enter the per-Requirement
    // max in the first place.
    const gaps = computeGaps(
      [mustHave],
      [
        makeMatch("m-high", "r-credential", 0.9, { structural_evidence: false }),
        makeMatch("m-low", "r-credential", 0.3, { structural_evidence: true }),
      ],
    );
    expect(gaps.map((g) => g.requirement.id)).toEqual(["r-credential"]);
  });
});

describe("computeGaps: derived verdicts (#441)", () => {
  const mustHave = makeReq("r-credential");

  it("lets a derived `evidenced` verdict cover a legacy match", () => {
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.52)],
      new Map([["m1", "evidenced" as const]]),
    );
    expect(gaps).toEqual([]);
  });

  it("retires the permissive pass when the verdict says unevidenced", () => {
    // The point of the whole issue: before #441 this row
    // satisfied the must-have purely because the field was
    // absent. The derivation is what turns that stopgap into an
    // answer.
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.52)],
      new Map([["m1", "unevidenced" as const]]),
    );
    expect(gaps).toEqual([
      { requirement: mustHave, status: "unmet" },
    ]);
  });

  it("reports an unverifiable match as its own kind of gap", () => {
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.52)],
      new Map([["m1", "unverifiable" as const]]),
    );
    expect(gaps).toEqual([
      { requirement: mustHave, status: "unverifiable" },
    ]);
  });

  it("does not let an unverifiable match below threshold cast doubt", () => {
    // It was never going to cover the Requirement, so being
    // unable to verify it tells the user nothing. Reporting
    // "unverified" here would bury the real signal — that there
    // is simply no qualifying match — under a hedge.
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.1)],
      new Map([["m1", "unverifiable" as const]]),
    );
    expect(gaps).toEqual([{ requirement: mustHave, status: "unmet" }]);
  });

  it("prefers a real cover over an unverifiable one", () => {
    const gaps = computeGaps(
      [mustHave],
      [
        makeMatch("m-doubt", "r-credential", 0.9),
        makeMatch("m-good", "r-credential", 0.5),
      ],
      new Map([
        ["m-doubt", "unverifiable" as const],
        ["m-good", "evidenced" as const],
      ]),
    );
    expect(gaps).toEqual([]);
  });

  it("ignores a rejected match even when its verdict is evidenced", () => {
    const gaps = computeGaps(
      [mustHave],
      [
        makeMatch("m1", "r-credential", 0.9, { user_rejected: true }),
      ],
      new Map([["m1", "evidenced" as const]]),
    );
    expect(gaps).toEqual([{ requirement: mustHave, status: "unmet" }]);
  });

  it("falls back to the permissive rule for a match absent from the map", () => {
    // The required degradation. A verdict map built before a new
    // match arrived must not tighten into inventing a gap for
    // the row it does not know about.
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m-new", "r-credential", 0.52)],
      new Map([["m-old", "unevidenced" as const]]),
    );
    expect(gaps).toEqual([]);
  });

  it("still honours a stored `false` when no map is supplied", () => {
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.52, { structural_evidence: false })],
      undefined,
    );
    expect(gaps).toEqual([{ requirement: mustHave, status: "unmet" }]);
  });

  it("lets the map override a stored value, since it already folds it in", () => {
    // The callable returns a verdict for EVERY match, stored
    // ones included, so the client has one source for the
    // question rather than two it must reconcile.
    const gaps = computeGaps(
      [mustHave],
      [makeMatch("m1", "r-credential", 0.52, { structural_evidence: false })],
      new Map([["m1", "evidenced" as const]]),
    );
    expect(gaps).toEqual([]);
  });
});
