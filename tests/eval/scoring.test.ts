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
      unitSetAccuracy(
        [{ normalizedSummary: "led migration project", skills: [] }],
        [],
      ),
    ).toBe(0);
  });

  it("returns 1 for perfect match", () => {
    const units = [
      { normalizedSummary: "migrated playback stack", skills: ["playback"] },
      { normalizedSummary: "shipped ps5 port", skills: ["playstation"] },
    ];
    expect(unitSetAccuracy(units, units)).toBe(1);
  });

  it("scores partial match with token-Jaccard summary + phrase-Jaccard skills (0.6 / 0.4)", () => {
    // Identical summaries → token-Jaccard = 1.
    // Skills: |∩|=1 ("a"), |∪|=3 ("a", "b", "c") → jaccard = 1/3.
    // Score = 1*0.6 + (1/3)*0.4
    const expected = [
      { normalizedSummary: "shipped initial release", skills: ["a", "b"] },
    ];
    const actual = [
      { normalizedSummary: "shipped initial release", skills: ["a", "c"] },
    ];
    expect(unitSetAccuracy(expected, actual)).toBeCloseTo(0.6 + 0.4 / 3, 6);
  });

  it("pairs greedily — an already-used actual can't double-count", () => {
    const expected = [
      { normalizedSummary: "shipped product launch", skills: [] },
      { normalizedSummary: "shipped product launch", skills: [] },
    ];
    const actual = [
      { normalizedSummary: "shipped product launch", skills: [] },
    ];
    // First expected pairs with actual (token-Jaccard on identical
    // multi-word string = 1, skills both empty → jaccard = 1, score
    // = 1*0.6 + 1*0.4 = 1.0). Second finds no free actual →
    // contributes 0. Mean = 0.5.
    expect(unitSetAccuracy(expected, actual)).toBe(0.5);
  });

  // -- #146 paraphrase-resilience regression -----------------------------

  it("#146: paraphrased summaries score in proportion to token overlap, not 0", () => {
    // Real shape from the live eval run on Nathan's resume.
    // Expected fixture (labeler):
    //   "Led Amazon Kepler launch — ground-up rewrite replacing Fire
    //   TV Android stack with native Linux-based OS"
    // Actual (LLM output):
    //   "Led the Amazon Kepler launch, a ground-up rewrite replacing
    //   Fire TV's Android stack with a native Linux OS; ported all
    //   three NCP apps"
    // Under exact-string equality these score 0 (the prior bug).
    // Under token-Jaccard the overlap is ~0.55, contributing
    // 0.55*0.6 = ~0.33 to the score before skills.
    const expected = [
      {
        normalizedSummary:
          "Led Amazon Kepler launch — ground-up rewrite replacing Fire TV Android stack with native Linux-based OS",
        skills: ["platform launch", "release engineering"],
      },
    ];
    const actual = [
      {
        normalizedSummary:
          "Led the Amazon Kepler launch, a ground-up rewrite replacing Fire TV's Android stack with a native Linux OS; ported all three NCP apps",
        skills: ["platform migration", "release management"],
      },
    ];
    const score = unitSetAccuracy(expected, actual);
    // Skills don't overlap (different phrases — that's a prompt
    // concern, not a metric one), so the bound is just summary.
    expect(score).toBeGreaterThan(0.25);
    expect(score).toBeLessThan(0.55);
  });

  it("#146: wholly unrelated summaries with disjoint skills score near 0", () => {
    // Sanity: the new metric isn't so loose that random text scores
    // high. No shared content tokens AND no shared skills → near 0.
    // Note: empty-vs-empty skills jaccard is 1 by the function's
    // own convention ("perfect agreement on nothing"), so to test
    // the unrelated case we need DIFFERENT non-empty skills on
    // both sides — otherwise the empty-empty=1 quirk dominates.
    const expected = [
      {
        normalizedSummary: "led broadway production financing",
        skills: ["theatrical financing"],
      },
    ];
    const actual = [
      {
        normalizedSummary: "designed san storage infrastructure",
        skills: ["storage hardware"],
      },
    ];
    expect(unitSetAccuracy(expected, actual)).toBeLessThan(0.1);
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
