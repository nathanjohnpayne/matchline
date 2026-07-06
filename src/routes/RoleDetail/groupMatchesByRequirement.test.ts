/**
 * Pure-helper tests for `groupMatchesByRequirement` (#129).
 *
 * Pinned invariants:
 *   - Top-K cap (5 by default, override-able).
 *   - Sort by `final_score` desc.
 *   - Tie-break by `created_at` asc (deterministic).
 *   - Empty match list → empty array per Requirement (NOT
 *     dropped — the Matches tab still renders the Requirement
 *     row with a "no matches" placeholder).
 *   - Requirements are returned in DETERMINISTIC DISPLAY
 *     ORDER, not input order: must_have (true first), then
 *     priority high → low, then `id` asc as a tie-break. See
 *     `sortRequirementsForDisplay` / the "Order contract"
 *     docblock in groupMatchesByRequirement.ts.
 */

import { describe, expect, it } from "vitest";

import type { JobRequirementUnit, UnitMatch } from "../../types/capability.ts";

import {
  TOP_K,
  groupMatchesByRequirement,
  sortRequirementsForDisplay,
} from "./groupMatchesByRequirement.ts";

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
    must_have: false,
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
    rationale: `match ${id}`,
    surface_evidence: `evidence ${id}`,
    approved_for_use: false,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("sortRequirementsForDisplay (cursor #132 r1)", () => {
  // Pinned ordering rule: must_have desc, priority
  // (high>medium>low) desc within each must_have band, then
  // id asc as tie-break.

  it("must_have:true rows come before must_have:false", () => {
    const reqs = [
      makeReq("r-not-mh", { must_have: false, priority: "high" }),
      makeReq("r-mh", { must_have: true, priority: "low" }),
    ];
    expect(sortRequirementsForDisplay(reqs).map((r) => r.id)).toEqual([
      "r-mh",
      "r-not-mh",
    ]);
  });

  it("within a must_have band, priority high > medium > low", () => {
    const reqs = [
      makeReq("r-low", { must_have: true, priority: "low" }),
      makeReq("r-high", { must_have: true, priority: "high" }),
      makeReq("r-medium", { must_have: true, priority: "medium" }),
    ];
    expect(sortRequirementsForDisplay(reqs).map((r) => r.id)).toEqual([
      "r-high",
      "r-medium",
      "r-low",
    ]);
  });

  it("ties on (must_have, priority) break by id asc", () => {
    const reqs = [
      makeReq("r-zebra", { must_have: true, priority: "high" }),
      makeReq("r-apple", { must_have: true, priority: "high" }),
      makeReq("r-mango", { must_have: true, priority: "high" }),
    ];
    expect(sortRequirementsForDisplay(reqs).map((r) => r.id)).toEqual([
      "r-apple",
      "r-mango",
      "r-zebra",
    ]);
  });

  it("composite case: must_have-high > must_have-low > nice-high > nice-low", () => {
    const reqs = [
      makeReq("r-nice-high", { must_have: false, priority: "high" }),
      makeReq("r-mh-low", { must_have: true, priority: "low" }),
      makeReq("r-nice-low", { must_have: false, priority: "low" }),
      makeReq("r-mh-high", { must_have: true, priority: "high" }),
    ];
    expect(sortRequirementsForDisplay(reqs).map((r) => r.id)).toEqual([
      "r-mh-high",
      "r-mh-low",
      "r-nice-high",
      "r-nice-low",
    ]);
  });

  it("does not mutate the input array", () => {
    const reqs = [
      makeReq("r-second", { must_have: false, priority: "high" }),
      makeReq("r-first", { must_have: true, priority: "high" }),
    ];
    const inputIds = reqs.map((r) => r.id);
    sortRequirementsForDisplay(reqs);
    expect(reqs.map((r) => r.id)).toEqual(inputIds);
  });
});

describe("groupMatchesByRequirement", () => {
  it("returns one row per Requirement, deterministically ordered (cursor #132 r1)", () => {
    // Input order is intentionally NOT the desired display
    // order — the helper must enforce the priority sort.
    const reqs = [
      makeReq("r-c", { must_have: false, priority: "low" }),
      makeReq("r-a", { must_have: true, priority: "high" }),
      makeReq("r-b", { must_have: true, priority: "medium" }),
    ];
    const result = groupMatchesByRequirement(reqs, []);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.requirement.id)).toEqual([
      "r-a", // must_have + high
      "r-b", // must_have + medium
      "r-c", // not-must_have + low
    ]);
    // Empty matches per Requirement — NOT dropped.
    expect(result.every((r) => r.matches.length === 0)).toBe(true);
  });

  it("sorts matches within each Requirement by final_score desc", () => {
    const reqs = [makeReq("r1")];
    const matches = [
      makeMatch("m-low", "r1", 0.3),
      makeMatch("m-high", "r1", 0.9),
      makeMatch("m-mid", "r1", 0.6),
    ];
    const [row] = groupMatchesByRequirement(reqs, matches);
    expect(row!.matches.map((m) => m.id)).toEqual([
      "m-high",
      "m-mid",
      "m-low",
    ]);
  });

  it("caps each Requirement's matches at TOP_K (default 5)", () => {
    const reqs = [makeReq("r1")];
    // 8 matches, all on r1.
    const matches = Array.from({ length: 8 }, (_, i) =>
      makeMatch(`m${i}`, "r1", 1 - i * 0.1),
    );
    const [row] = groupMatchesByRequirement(reqs, matches);
    expect(row!.matches).toHaveLength(TOP_K);
    expect(TOP_K).toBe(5);
  });

  it("respects an override topK cap", () => {
    const reqs = [makeReq("r1")];
    const matches = Array.from({ length: 10 }, (_, i) =>
      makeMatch(`m${i}`, "r1", 1 - i * 0.05),
    );
    const [row] = groupMatchesByRequirement(reqs, matches, 3);
    expect(row!.matches).toHaveLength(3);
    expect(row!.matches.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("clamps a negative topK to an empty slice instead of slicing from the end", () => {
    const reqs = [makeReq("r1")];
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch(`m${i}`, "r1", 1 - i * 0.1),
    );
    const [row] = groupMatchesByRequirement(reqs, matches, -1);
    expect(row!.matches).toEqual([]);
  });

  it("falls back to TOP_K for a non-finite topK (NaN)", () => {
    const reqs = [makeReq("r1")];
    const matches = Array.from({ length: 8 }, (_, i) =>
      makeMatch(`m${i}`, "r1", 1 - i * 0.1),
    );
    const [row] = groupMatchesByRequirement(reqs, matches, NaN);
    expect(row!.matches).toHaveLength(TOP_K);
  });

  it("truncates a non-integer topK", () => {
    const reqs = [makeReq("r1")];
    const matches = Array.from({ length: 5 }, (_, i) =>
      makeMatch(`m${i}`, "r1", 1 - i * 0.1),
    );
    const [row] = groupMatchesByRequirement(reqs, matches, 2.9);
    expect(row!.matches).toHaveLength(2);
  });

  it("ties on final_score break by created_at asc (older first, deterministic)", () => {
    const reqs = [makeReq("r1")];
    const matches = [
      makeMatch("m-newer", "r1", 0.5, {
        created_at: "2026-02-15T00:00:00.000Z",
      }),
      makeMatch("m-older", "r1", 0.5, {
        created_at: "2026-01-15T00:00:00.000Z",
      }),
      makeMatch("m-newest", "r1", 0.5, {
        created_at: "2026-03-15T00:00:00.000Z",
      }),
    ];
    const [row] = groupMatchesByRequirement(reqs, matches);
    expect(row!.matches.map((m) => m.id)).toEqual([
      "m-older",
      "m-newer",
      "m-newest",
    ]);
  });

  it("groups correctly when matches reference multiple Requirements", () => {
    const reqs = [makeReq("r1"), makeReq("r2")];
    const matches = [
      makeMatch("m-r1-a", "r1", 0.8),
      makeMatch("m-r2-a", "r2", 0.6),
      makeMatch("m-r1-b", "r1", 0.5),
      makeMatch("m-r2-b", "r2", 0.7),
    ];
    const result = groupMatchesByRequirement(reqs, matches);
    expect(result[0]!.matches.map((m) => m.id)).toEqual([
      "m-r1-a",
      "m-r1-b",
    ]);
    expect(result[1]!.matches.map((m) => m.id)).toEqual([
      "m-r2-b",
      "m-r2-a",
    ]);
  });

  it("ignores matches whose job_requirement_unit_id doesn't match any input Requirement", () => {
    const reqs = [makeReq("r1")];
    const matches = [
      makeMatch("m-orphan", "r-stale", 0.99),
      makeMatch("m-real", "r1", 0.5),
    ];
    const [row] = groupMatchesByRequirement(reqs, matches);
    expect(row!.matches).toHaveLength(1);
    expect(row!.matches[0]!.id).toBe("m-real");
  });
});
