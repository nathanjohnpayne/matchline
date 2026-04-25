import { describe, expect, it } from "vitest";

import {
  cosineSimilarity,
  EmptyVectorError,
  MismatchedDimensionsError,
  semanticSimilarity,
} from "./cosine.js";

/**
 * Tests for the matching engine's cosine math. Pure functions —
 * no embedding-API or Firestore touches.
 */

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors (parallel)", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])).toBeCloseTo(
      1,
      9,
    );
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 9);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 9);
    expect(cosineSimilarity([1, 0, 0], [0, 0, 1])).toBeCloseTo(0, 9);
  });

  it("returns -1 for antiparallel vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 9);
    expect(
      cosineSimilarity([0.7, 0.7], [-0.7, -0.7]),
    ).toBeCloseTo(-1, 9);
  });

  it("scales independent of magnitude", () => {
    // cos is direction-only; magnitude cancels.
    expect(cosineSimilarity([1, 0], [10, 0])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([2, 2, 2], [1, 1, 1])).toBeCloseTo(1, 9);
  });

  it("throws MismatchedDimensionsError on differing lengths", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(
      MismatchedDimensionsError,
    );
    expect(() => cosineSimilarity([1], [1, 1])).toThrow(
      /a=1.*b=2/,
    );
  });

  it("throws EmptyVectorError on empty input", () => {
    expect(() => cosineSimilarity([], [1, 0])).toThrow(EmptyVectorError);
    expect(() => cosineSimilarity([1, 0], [])).toThrow(EmptyVectorError);
    expect(() => cosineSimilarity([], [])).toThrow(EmptyVectorError);
  });

  it("returns 0 when a vector has effectively-zero magnitude (no NaN leak)", () => {
    // A degenerate `[0, 0, 0]` would divide by zero and produce
    // NaN. The matching pipeline calls this on every (unit,
    // requirement) pair; a NaN escape would poison every score.
    // Returning 0 means "no semantic signal" — the correct UX
    // for a corrupt embedding.
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1, 1], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it("handles realistic OpenAI-style 1536-dim vectors", () => {
    // Sanity benchmark: similarity over a 1536-dim pair should
    // compute in well under a millisecond. Pin the correctness
    // (returns 1.0 for identical vectors of any size) — the
    // performance dimension is auditable by reading the linear
    // loop, not enforced as a CI gate.
    const v = new Array(1536).fill(0).map(() => Math.random());
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 9);
  });
});

describe("semanticSimilarity (cosine clamped to [0, 1])", () => {
  it("equals cosineSimilarity for non-negative inputs", () => {
    expect(semanticSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 9);
    expect(semanticSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 9);
  });

  it("clamps negative cosine to 0 (regression: OpenAI never emits these but a future provider could)", () => {
    // The matching engine's score composer assumes every
    // component is in [0, 1]. A negative semantic score would
    // make the weighted-sum drop below zero, breaking the
    // documented score-formula range.
    expect(semanticSimilarity([1, 0], [-1, 0])).toBe(0);
    expect(semanticSimilarity([0.7, 0.7], [-0.7, -0.7])).toBe(0);
  });

  it("propagates the EmptyVector / Mismatch errors from cosineSimilarity", () => {
    expect(() => semanticSimilarity([], [1])).toThrow(EmptyVectorError);
    expect(() => semanticSimilarity([1], [1, 1])).toThrow(
      MismatchedDimensionsError,
    );
  });

  it("zero-magnitude → 0 (same defensive behavior as cosineSimilarity)", () => {
    expect(semanticSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });
});
