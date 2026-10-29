import { describe, expect, it } from "vitest";

import { runMatchingPipeline } from "../../../functions/src/matching/pipeline.ts";
import { score } from "../../../functions/src/matching/score.ts";

import { loadExpectedMatches, loadExpectedUnits, type ExpectedMatchesFile } from "../loadFixtures.ts";
import { compositeIdsFromMatches, mapRequirementIds, mapUnitIds } from "../mapping.ts";
import { topKOverlap } from "../scoring.ts";

import { decompose, evaluateMatches, median, runMatch, sumDecompositions, windowFor } from "./evaluate.ts";
import { recordRequirements, recordUnits } from "./inputs.ts";
import type { PairScorer } from "./scorers.ts";
import { flowFor, JD, RESUME, savedItems, textVector } from "./testSupport.ts";

const eu = loadExpectedUnits(RESUME).expected_units;
const em = loadExpectedMatches(RESUME, JD);
const asOf = new Date("2026-10-28T00:00:01.000Z");

function embedded(): { units: ReturnType<typeof recordUnits>; reqs: ReturnType<typeof recordRequirements> } {
  const flow = flowFor("a", "inv", 0, savedItems(0, { dropUnits: 1, dropReqs: 1 }));
  return {
    units: recordUnits(flow).map((u) => ({ ...u, embedding: textVector(u.normalized_summary) })),
    reqs: recordRequirements(flow).map((q) => ({ ...q, embedding: textVector(q.normalized_requirement) })),
  };
}

describe("runMatch + evaluateMatches", () => {
  it("equals the runForFixture path on record inputs with the current scorer", async () => {
    const { units, reqs } = embedded();
    const unitMap = mapUnitIds(eu, units);
    const reqMap = mapRequirementIds(em.expected_requirements, reqs);
    const ours = evaluateMatches(await runMatch(units, reqs, asOf, score), unitMap, reqMap, em);
    // Independent: the pipeline with its default scorer, then the eval's own steps.
    const ms = await runMatchingPipeline(
      { ownerUid: "eval-user", roleId: "eval-role" },
      { listUnits: async () => units, listRequirements: async () => reqs, persistBatch: async (_c, m) => m, asOf },
    );
    const expected = topKOverlap(em.expected_top_matches, compositeIdsFromMatches(ms, unitMap, reqMap), em.k);
    expect(ours.accuracy).toBe(expected);
    expect(ours.composites).toEqual(compositeIdsFromMatches(ms, unitMap, reqMap));
    expect(ms).toHaveLength(units.length * reqs.length);
  });

  it("passes asOf to the injected scorer", async () => {
    const { units, reqs } = embedded();
    const seen = new Set<number>();
    const spy: PairScorer = (u, q, o) => {
      if (o?.asOf !== undefined) seen.add(o.asOf.getTime());
      return score(u, q, o);
    };
    await runMatch(units, reqs, asOf, spy);
    expect([...seen]).toEqual([asOf.getTime()]);
  });
});

const crafted: ExpectedMatchesFile = {
  resume_fixture_id: "r",
  jd_fixture_id: "j",
  k: 4,
  expected_top_matches: ["u1:r1", "u2:r2", "u3:r3", "u4:r4", "u1:r1"],
  expected_requirements: [],
} as unknown as ExpectedMatchesFile;

describe("k semantics", () => {
  it("label k with topKOverlap's dedup cap, or recall@k over unique labelled pairs", () => {
    expect(windowFor(crafted)).toBe(4);
    expect(windowFor(crafted, 2)).toBe(2);
    const unitMap = new Map([["a", "u1"], ["b", "u2"], ["c", "u3"], ["d", "u4"]]);
    const reqMap = new Map([["x", "r1"], ["y", "r2"], ["z", "r3"], ["w", "r4"]]);
    const m = (u: string, r: string, s: number): never =>
      ({ experience_unit_id: u, job_requirement_unit_id: r, final_score: s }) as never;
    const matches = [m("a", "x", 0.9), m("a", "y", 0.8), m("b", "y", 0.7), m("c", "x", 0.6), m("c", "z", 0.5), m("d", "w", 0.4)];
    // Top 4: u1:r1, u1:r2, u2:r2, u3:r1 → 2 of 4 unique labelled pairs.
    expect(evaluateMatches(matches, unitMap, reqMap, crafted).accuracy).toBe(0.5);
    expect(evaluateMatches(matches, unitMap, reqMap, crafted, 2).accuracy).toBe(0.25);
    expect(evaluateMatches(matches, unitMap, reqMap, crafted, 6).accuracy).toBe(1);
  });
});

describe("decompose", () => {
  it("splits every labelled pair into found, A, B or C", () => {
    // u1 and u2 mapped, u3 and u4 not; r1, r2, r4 mapped, r3 not.
    const unitMap = new Map([["a", "u1"], ["b", "u2"], ["c", "unmapped_c"]]);
    const reqMap = new Map([["x", "r1"], ["y", "r2"], ["w", "r4"], ["q", "unmapped_q"]]);
    const file = { ...crafted, k: 5, expected_top_matches: ["u1:r1", "u2:r2", "u3:r3", "u4:r1", "u2:r4", "u1:r3"] } as ExpectedMatchesFile;
    const composites = ["u1:r1", "unmapped_c:r2", "u2:r1", "u1:r2", "u2:unmapped_q", "u2:r2", "u2:r4"];
    const d = decompose(composites, unitMap, reqMap, file);
    expect(d.expected).toBe(6);
    expect(d.found).toBe(1); // u1:r1 (window 5)
    expect(d.A).toBe(2); // u3:r3 (and r3 unmapped), u4:r1
    expect(d.A_and_B).toBe(1);
    expect(d.B).toBe(1); // u1:r3
    expect(d.C).toBe(2); // u2:r2 at 6, u2:r4 at 7
    expect(d.cRanks).toEqual([6, 7]);
    expect(d.found + d.A + d.B + d.C).toBe(d.expected);
    expect(d.fp).toBe(4);
    expect(d.fpUnmappedSide).toBe(2);
    expect(d.fpBothMapped).toBe(2);
    const wide = decompose(composites, unitMap, reqMap, file, 7);
    expect(wide.found).toBe(3);
    expect(wide.C).toBe(0);
  });

  it("sums and takes medians", () => {
    const one = decompose(["u1:r1"], new Map([["a", "u1"]]), new Map([["x", "r1"]]), { ...crafted, k: 1, expected_top_matches: ["u1:r1"] } as ExpectedMatchesFile);
    const s = sumDecompositions([one, one]);
    expect(s.expected).toBe(2);
    expect(s.found).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
