import { describe, expect, it } from "vitest";

import { jaccard, topKOverlap, unitSetAccuracy } from "./scoring.js";

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  it("returns 0.5 for half overlap", () => {
    // |intersection| = 1 (a); |union| = 3 (a, b, c). 1/3, not 0.5 — math check.
    expect(jaccard(["a", "b"], ["a", "c"])).toBeCloseTo(1 / 3, 6);
  });

  it("defines empty vs empty as 1", () => {
    expect(jaccard([], [])).toBe(1);
  });

  it("returns 0 when one side is empty and the other isn't", () => {
    expect(jaccard([], ["a"])).toBe(0);
    expect(jaccard(["a"], [])).toBe(0);
  });

  it("dedupes repeated values", () => {
    expect(jaccard(["a", "a", "b"], ["a", "b", "b"])).toBe(1);
  });
});

describe("unitSetAccuracy", () => {
  it("returns 1 when both sides empty", () => {
    expect(unitSetAccuracy([], [])).toBe(1);
  });

  it("returns 0 when expected has entries and actual is empty", () => {
    expect(
      unitSetAccuracy([{ normalizedSummary: "x", skills: [] }], []),
    ).toBe(0);
  });

  it("returns 1 for perfect match", () => {
    const units = [
      { normalizedSummary: "migrated playback stack", skills: ["playback"] },
      { normalizedSummary: "shipped ps5 port", skills: ["playstation"] },
    ];
    expect(unitSetAccuracy(units, units)).toBe(1);
  });

  it("scores partial match with summary + jaccard weighting (0.6 / 0.4)", () => {
    // Matching summary gets 0.6, half-matching skills get 0.4 * ~0.33 = 0.13.
    const expected = [{ normalizedSummary: "x", skills: ["a", "b"] }];
    const actual = [{ normalizedSummary: "x", skills: ["a", "c"] }];
    // summary=1, jaccard=1/3; score = 0.6 + 0.4*(1/3)
    expect(unitSetAccuracy(expected, actual)).toBeCloseTo(0.6 + 0.4 / 3, 6);
  });

  it("pairs greedily — an already-used actual can't double-count", () => {
    const expected = [
      { normalizedSummary: "x", skills: [] },
      { normalizedSummary: "x", skills: [] },
    ];
    const actual = [{ normalizedSummary: "x", skills: [] }];
    // First expected pairs with actual (score 1). Second finds no
    // free actual → contributes 0. Mean = 0.5.
    expect(unitSetAccuracy(expected, actual)).toBe(0.5);
  });
});

describe("topKOverlap", () => {
  it("returns 1 when all expected are in top-K", () => {
    expect(topKOverlap(["a", "b"], ["a", "b", "c"], 3)).toBe(1);
  });

  it("returns 0 when expected fall outside top-K", () => {
    expect(topKOverlap(["a"], ["b", "c", "a"], 2)).toBe(0);
  });

  it("returns fraction for partial overlap", () => {
    expect(topKOverlap(["a", "b", "c"], ["a", "x", "b"], 3)).toBeCloseTo(
      2 / 3,
      6,
    );
  });

  it("returns 1 when no expected", () => {
    expect(topKOverlap([], ["a"], 5)).toBe(1);
  });

  it("returns 0 when k <= 0", () => {
    expect(topKOverlap(["a"], ["a"], 0)).toBe(0);
    expect(topKOverlap(["a"], ["a"], -1)).toBe(0);
  });
});
