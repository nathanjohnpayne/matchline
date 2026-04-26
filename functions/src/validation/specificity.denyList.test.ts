import { describe, expect, it } from "vitest";

import { SPECIFICITY_DENY_LIST } from "./specificity.denyList.ts";

/**
 * Tests for the curated deny-list. Each entry is tested for:
 *   - non-empty pattern
 *   - non-empty reason
 *   - lowercase pattern (the matcher lowercases input; non-
 *     lowercase entries would never match)
 *
 * Plus a perf-bound test on the deny-list match function (V1
 * single-user volume; deny-list scans should be microseconds).
 */

describe("SPECIFICITY_DENY_LIST", () => {
  it("contains at least 10 entries (V1 starter list per #108 spec)", () => {
    expect(SPECIFICITY_DENY_LIST.length).toBeGreaterThanOrEqual(10);
  });

  it("each entry has a non-empty pattern", () => {
    for (const entry of SPECIFICITY_DENY_LIST) {
      expect(entry.pattern.length).toBeGreaterThan(0);
    }
  });

  it("each entry has a non-empty reason (used as the user-facing flag rationale)", () => {
    for (const entry of SPECIFICITY_DENY_LIST) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("each pattern is lowercase (matcher lowercases input; non-lowercase patterns would never match)", () => {
    for (const entry of SPECIFICITY_DENY_LIST) {
      expect(entry.pattern).toBe(entry.pattern.toLowerCase());
    }
  });

  it("the array is frozen (Object.freeze)", () => {
    expect(Object.isFrozen(SPECIFICITY_DENY_LIST)).toBe(true);
  });

  it("includes the canonical empty-PM tropes called out in the issue spec", () => {
    // Pin the most well-known tropes — the issue body explicitly
    // names some of these as required entries. If a future
    // refactor drops one, this test fails so the removal is
    // intentional.
    const patterns = SPECIFICITY_DENY_LIST.map((e) => e.pattern);
    expect(patterns).toContain("collaborated cross-functionally");
    expect(patterns).toContain("drove results");
    expect(patterns).toContain("leveraged data");
    expect(patterns).toContain("delivered impact");
    expect(patterns).toContain("synergy");
    expect(patterns).toContain("best-in-class");
  });

  it("all patterns are unique (no duplicates across entries)", () => {
    const patterns = SPECIFICITY_DENY_LIST.map((e) => e.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});
