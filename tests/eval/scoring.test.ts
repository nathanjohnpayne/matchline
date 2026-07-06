import { describe, expect, it } from "vitest";

import { jaccard, topKOverlap, unitSetAccuracy } from "./scoring.js";

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  it("returns 1/3 for one-of-three overlap", () => {
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

  it("#146 + #148: paraphrased + verbose-actual summaries score in proportion to overlap, not 0", () => {
    // Real shape from the live eval run on Nathan's resume.
    // Expected fixture (labeler) — concise:
    //   "Led Amazon Kepler launch — ground-up rewrite replacing Fire
    //   TV Android stack with native Linux-based OS"
    // Actual (LLM output) — verbose, contains expected + extra detail:
    //   "Led the Amazon Kepler launch, a ground-up rewrite replacing
    //   Fire TV's Android stack with a native Linux OS; ported all
    //   three NCP apps"
    //
    // Pre-#146 (exact-string equality) scored 0.
    // Pre-#148 (token-Jaccard) scored ~0.34: the actual's extra
    //   tokens ("ported", "all", "three", "ncp", "apps") inflate
    //   the union and depress Jaccard.
    // #148 (overlap-coefficient): expected tokens fully covered
    //   by actual's superset → overlap ~0.85. Skills still don't
    //   overlap (different canonical phrases), so total score
    //   ≈ 0.6×0.85 + 0.4×0 = 0.51-0.55.
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
    // Bound the new overlap-coefficient regime: should be
    // markedly above the 0.34 prior token-Jaccard ceiling but
    // below 0.6 (= 100% summary + 0 skills, the upper bound
    // when skills don't overlap).
    expect(score).toBeGreaterThan(0.45);
    expect(score).toBeLessThan(0.6);
  });

  it("#146 (Codex P2 on #147): identical short-token summaries get full credit when both tokenize empty", () => {
    // Pathological case: "AI ML" tokenizes to empty under the
    // >2-char filter. `tokenJaccard(empty, empty) = 0` would
    // punish a perfect textual match. Fall-back to exact-equality
    // on the trimmed lowercase string preserves the credit. With
    // identical short-token skill, score should be 1.0 (perfect
    // pair).
    const expected = [
      { normalizedSummary: "AI ML", skills: ["AI"] },
    ];
    const actual = [
      { normalizedSummary: "AI ML", skills: ["AI"] },
    ];
    expect(unitSetAccuracy(expected, actual)).toBe(1);
  });

  it("#146 (Codex P2 on #147): different short-token summaries that both tokenize empty score 0 on summary", () => {
    // Different content, both tokenize empty — exact-equality
    // fall-back returns 0, and with identical skills the score is
    // just the skills component (0.4).
    const expected = [
      { normalizedSummary: "AI ML", skills: ["AI"] },
    ];
    const actual = [
      { normalizedSummary: "TV OS", skills: ["AI"] },
    ];
    // summary 0 (different content via fall-back), skills 1
    // (identical), score = 0*0.6 + 1*0.4 = 0.4.
    expect(unitSetAccuracy(expected, actual)).toBeCloseTo(0.4, 6);
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

  it("dedupes duplicate expected IDs instead of inflating the score", () => {
    // Without dedup, "a" would count as 2 hits over a denominator of 3.
    expect(topKOverlap(["a", "a", "b"], ["a", "c"], 2)).toBeCloseTo(1 / 2, 6);
  });
});
