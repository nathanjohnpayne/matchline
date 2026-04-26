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
 *   - Requirements are returned in INPUT ORDER. Caller's
 *     sort is preserved (the parsing pipeline #19 sorts by
 *     priority then must_have).
 */

import { describe, expect, it } from "vitest";

import type { JobRequirementUnit, UnitMatch } from "../../types/capability.ts";

import {
  TOP_K,
  groupMatchesByRequirement,
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

describe("groupMatchesByRequirement", () => {
  it("returns one row per Requirement preserving input order", () => {
    const reqs = [makeReq("r1"), makeReq("r2"), makeReq("r3")];
    const result = groupMatchesByRequirement(reqs, []);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.requirement.id)).toEqual(["r1", "r2", "r3"]);
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
