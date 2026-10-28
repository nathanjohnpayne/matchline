import { describe, expect, it } from "vitest";

import {
  cellWeightedDiff,
  commonCells,
  equalCellWeightMean,
  mean,
  minMax,
  mulberry32,
  nearestRankPercentile,
  pooledWithinCellSd,
  powerCheck,
  quantileSorted,
  regularizedIncompleteBeta,
  sampleSd,
  stratifiedBootstrapCi,
  stratifiedWelchTTest,
  studentTTwoSidedP,
  welchTTest,
} from "./stats.ts";

const cells = (entries: Record<string, number[]>): Map<string, number[]> => new Map(Object.entries(entries));

describe("descriptive statistics", () => {
  it("mean, sample SD and min–max", () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(sampleSd([5])).toBeNull();
    expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 5);
    expect(minMax([])).toBeNull();
    expect(minMax([3, -1, 7])).toEqual({ min: -1, max: 7 });
  });

  it("nearest-rank percentile, as the latency report computes it", () => {
    expect(nearestRankPercentile([], 0.5)).toBeNull();
    expect(nearestRankPercentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(nearestRankPercentile([40, 10, 30, 20, 50], 0.5)).toBe(30);
    expect(nearestRankPercentile([7], 0.95)).toBe(7);
  });

  it("type-7 quantile interpolates between order statistics", () => {
    expect(quantileSorted([0, 10], 0.25)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(() => quantileSorted([], 0.5)).toThrow();
  });

  it("equal cell weights ignore how many flows each cell holds", () => {
    expect(equalCellWeightMean(cells({ a: [1, 1, 1, 1, 1, 1], b: [0] }))).toBe(0.5);
    expect(equalCellWeightMean(cells({}))).toBeNull();
  });

  it("pooled within-cell SD weighs each cell by its degrees of freedom", () => {
    // Cell a: SD 1 with 3 values (2 df); cell b: SD 2 with 2 values (1 df).
    const s = pooledWithinCellSd(cells({ a: [1, 2, 3], b: [0, 2 * Math.SQRT2] }))!;
    expect(s).toBeCloseTo(Math.sqrt((2 * 1 + 1 * 4) / 3), 10);
    expect(pooledWithinCellSd(cells({ a: [1], b: [2] }))).toBeNull();
  });
});

describe("mulberry32", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe("cell-weighted difference and stratified bootstrap", () => {
  const inc = cells({ a: [0.5, 0.6, 0.7], b: [0.2, 0.3], c: [0.9] });
  const cand = cells({ a: [0.6, 0.7, 0.8, 0.9], b: [0.3, 0.3, 0.4], d: [0.1] });

  it("compares only cells both arms hold, each weighted equally", () => {
    expect(commonCells(inc, cand)).toEqual(["a", "b"]);
    const diff = cellWeightedDiff(inc, cand)!;
    expect(diff).toBeCloseTo(((0.75 - 0.6) + (1 / 3 - 0.25)) / 2, 12);
    expect(cellWeightedDiff(cells({ a: [1] }), cells({ b: [1] }))).toBeNull();
  });

  it("is deterministic for a seed and independent of input order", () => {
    const x = stratifiedBootstrapCi(inc, cand, { seed: 1, resamples: 2000 });
    const y = stratifiedBootstrapCi(inc, cand, { seed: 1, resamples: 2000 });
    const shuffled = stratifiedBootstrapCi(
      cells({ b: [0.3, 0.2], a: [0.7, 0.5, 0.6], c: [0.9] }),
      cells({ a: [0.9, 0.6, 0.8, 0.7], b: [0.4, 0.3, 0.3] }),
      { seed: 1, resamples: 2000 },
    );
    expect(y).toEqual(x);
    expect(shuffled).toEqual(x);
    expect(stratifiedBootstrapCi(inc, cand, { seed: 2, resamples: 2000 })).not.toEqual(x);
    const diff = cellWeightedDiff(inc, cand)!;
    expect(x!.lo).toBeLessThanOrEqual(diff);
    expect(x!.hi).toBeGreaterThanOrEqual(diff);
  });

  it("pins the interval when every common cell has at least two values in both arms", () => {
    // Values from before the singleton guard: n >= 2 in every common cell, so unchanged.
    expect(stratifiedBootstrapCi(inc, cand, { seed: 1, resamples: 2000 })).toEqual({
      lo: 0.033333333333333465,
      hi: 0.20010416666666614,
    });
  });

  it("is null when a common cell has fewer than two values in either arm, as the stratified Welch test is", () => {
    // A singleton is redrawn unchanged every resample: this used to give [0.1, 0.1].
    expect(stratifiedBootstrapCi(cells({ a: [0.6] }), cells({ a: [0.7] }))).toBeNull();
    expect(stratifiedWelchTTest(cells({ a: [0.6] }), cells({ a: [0.7] }))).toBeNull();
    expect(stratifiedBootstrapCi(cells({ a: [0.6, 0.7], b: [0.1, 0.2] }), cells({ a: [0.7, 0.8], b: [0.3] }))).toBeNull();
    expect(stratifiedBootstrapCi(cells({ a: [0.6], b: [0.1, 0.2] }), cells({ a: [0.7, 0.8], b: [0.3, 0.2] }))).toBeNull();
  });

  it("collapses to the shift when every cell is constant", () => {
    const ci = stratifiedBootstrapCi(cells({ a: [0.4, 0.4], b: [0.1, 0.1] }), cells({ a: [0.5, 0.5, 0.5], b: [0.2, 0.2] }), { resamples: 500 })!;
    expect(ci.lo).toBeCloseTo(0.1, 12);
    expect(ci.hi).toBeCloseTo(0.1, 12);
  });

  it("defaults to 10,000 resamples and a fixed seed", () => {
    expect(stratifiedBootstrapCi(inc, cand)).toEqual(stratifiedBootstrapCi(inc, cand, { seed: 20261028, resamples: 10_000 }));
    expect(stratifiedBootstrapCi(cells({ a: [1] }), cells({ b: [1] }))).toBeNull();
  });
});

describe("Student t and Welch", () => {
  it("matches closed forms and a numerical integral", () => {
    // df = 1 is Cauchy: P(|T| > 1) = 0.5. df = 2: p = 1 − t/√(2 + t²).
    expect(studentTTwoSidedP(1, 1)).toBeCloseTo(0.5, 10);
    expect(studentTTwoSidedP(1, 2)).toBeCloseTo(1 - 1 / Math.sqrt(3), 10);
    expect(studentTTwoSidedP(2, 10)).toBeCloseTo(0.073388, 6);
    expect(studentTTwoSidedP(0, 7)).toBeCloseTo(1, 12);
    expect(studentTTwoSidedP(Infinity, 7)).toBe(0);
    expect(regularizedIncompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12);
  });

  it("computes Welch's t, df and p", () => {
    const r = welchTTest([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])!;
    expect(r.t).toBeCloseTo(3 / Math.sqrt(2.5), 10);
    expect(r.df).toBeCloseTo(6.25 / (0.0625 + 1), 10);
    expect(r.p).toBeCloseTo(0.107531, 5);
  });

  it("is undefined below two values, and p = 1 for identical constants", () => {
    expect(welchTTest([1], [1, 2])).toBeNull();
    expect(welchTTest([3, 3], [3, 3, 3])!.p).toBe(1);
    expect(welchTTest([3, 3], [4, 4])).toBeNull();
    // A constant that does not divide evenly leaves rounding noise in the variance.
    const x = 1 / 11;
    expect(welchTTest([x, x, x], [2 / 3, 2 / 3, 2 / 3])).toBeNull();
  });
});

describe("stratified Welch", () => {
  it("tests the equal-cell-weight difference with Welch–Satterthwaite df over 2C components", () => {
    const inc = cells({ a: [1, 3], b: [0, 2] }); // means 2, 1; variances 2, 2
    const cand = cells({ a: [2, 4], b: [1, 5] }); // means 3, 3; variances 2, 8
    const r = stratifiedWelchTTest(inc, cand)!;
    // D = (1 + 2)/2; components (1/4)·v/n = 0.25, 0.25, 0.25, 1 → se² = 1.75.
    expect(r.diff).toBeCloseTo(cellWeightedDiff(inc, cand)!, 12);
    expect(r.diff).toBeCloseTo(1.5, 12);
    expect(r.t).toBeCloseTo(1.5 / Math.sqrt(1.75), 12);
    expect(r.df).toBeCloseTo(1.75 ** 2 / (3 * 0.25 ** 2 + 1 ** 2), 12);
    expect(r.p).toBeCloseTo(studentTTwoSidedP(r.t, r.df), 12);
  });

  // Review round 1 (P2): unequal per-cell n across arms. Incumbent: six
  // values near 1.0 in A, two near 0.0 in B; candidate: the reverse mix.
  // The pooled Welch test sees a ~49-point gap of the opposite sign; the
  // stratified test must follow the printed equal-cell-weight difference.
  it("follows the printed difference when the arms' cell mix differs", () => {
    const inc = cells({ a: [0.97, 0.98, 0.99, 1, 1, 1], b: [0, 0.02] });
    const cand = cells({ a: [0.985, 0.999], b: [0, 0.01, 0.02, 0, 0.01, 0.02] });
    const diff = cellWeightedDiff(inc, cand)!;
    expect(diff).toBeCloseTo(0.001, 12);
    const pooled = (c: Map<string, number[]>): number[] => [...c.values()].flat();
    const naive = welchTTest(pooled(inc), pooled(cand))!;
    expect(naive.t).toBeLessThan(0); // the pooled test points the other way…
    expect(naive.p).toBeLessThan(0.05); // …and calls it significant.
    const r = stratifiedWelchTTest(inc, cand)!;
    expect(r.diff).toBeCloseTo(diff, 12);
    expect(Math.sign(r.t)).toBe(Math.sign(diff));
    expect(r.p).toBeGreaterThan(0.5);
  });

  it("reports p = 1 for identical per-cell values whatever the cell mix", () => {
    const inc = cells({ a: [0.9, 1, 0.9, 1, 0.9, 1], b: [0, 0.2] });
    const cand = cells({ a: [0.9, 1], b: [0, 0.2, 0, 0.2, 0, 0.2] });
    const r = stratifiedWelchTTest(inc, cand)!;
    expect(r.t).toBeCloseTo(0, 12);
    expect(r.p).toBeCloseTo(1, 12);
  });

  it("is null without common cells or when a common cell has fewer than two values in an arm", () => {
    expect(stratifiedWelchTTest(cells({ a: [1, 2] }), cells({ b: [1, 2] }))).toBeNull();
    expect(stratifiedWelchTTest(cells({ a: [1, 2], b: [1] }), cells({ a: [1, 2], b: [3, 4] }))).toBeNull();
    // A cell only one arm holds is outside the estimand and does not block the test.
    expect(stratifiedWelchTTest(cells({ a: [1, 2], b: [1] }), cells({ a: [2, 3] }))).not.toBeNull();
  });

  it("reports p = 1 for identical constants and null for a constant gap", () => {
    expect(stratifiedWelchTTest(cells({ a: [3, 3] }), cells({ a: [3, 3, 3] }))!.p).toBe(1);
    expect(stratifiedWelchTTest(cells({ a: [3, 3] }), cells({ a: [4, 4] }))).toBeNull();
  });
});

describe("powerCheck", () => {
  it("uses 1.96·s/√(2n) at n = 6 and solves n for a 2.5-point half-width", () => {
    const p = powerCheck(0.1, 4, true);
    expect(p.halfWidthAtN6).toBeCloseTo((1.96 * 0.1) / Math.sqrt(12), 12);
    // The C-cell form equals the stated one at C = 4.
    expect(p.halfWidthAtN6ForCells).toBeCloseTo(p.halfWidthAtN6, 12);
    // (1.96 · 0.1 / 0.025)² / 2 = 30.73 → 31.
    expect(p.nForTarget).toBe(31);
    expect(p.nForTargetForCells).toBe(31);
    const two = powerCheck(0.1, 2, true);
    expect(two.nForTargetForCells).toBe(62);
    expect(two.halfWidthAtN6ForCells).toBeCloseTo(1.96 * 0.1 * Math.sqrt(2 / 12), 12);
  });

  it("leaves n empty for count metrics and handles s = 0", () => {
    expect(powerCheck(3, 4, false).nForTarget).toBeNull();
    expect(powerCheck(0, 4, true).nForTarget).toBe(1);
    expect(powerCheck(0.1, 0, true).halfWidthAtN6ForCells).toBeNull();
  });
});
