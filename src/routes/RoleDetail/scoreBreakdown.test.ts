/**
 * Pure-helper tests for the score breakdown logic (#131).
 *
 * Pinned invariants:
 *   - Client-side `COMPONENT_WEIGHTS` sum to exactly 1.0
 *     (drift from the server-side `WEIGHTS` would silently
 *     mis-render the tooltip's "contribution" math).
 *   - `buildBreakdownRows` returns null for legacy matches
 *     missing the persisted `components` field.
 *   - Row order matches `COMPONENT_DISPLAY_ORDER`.
 *   - `contribution = value × weight` for every row.
 *   - All 7 components present in the output.
 */

import { describe, expect, it } from "vitest";

import type { ScoreComponents } from "../../types/capability.ts";

import {
  COMPONENT_DISPLAY_ORDER,
  COMPONENT_LABELS,
  COMPONENT_WEIGHTS,
  buildBreakdownRows,
} from "./scoreBreakdown.ts";

const FULL: ScoreComponents = {
  semantic_similarity: 0.8,
  skill_overlap: 0.6,
  domain_overlap: 0.4,
  tool_overlap: 0.2,
  seniority_alignment: 0.5,
  scope_alignment: 0.3,
  recency: 0.7,
};

describe("COMPONENT_WEIGHTS", () => {
  it("sums to exactly 1.0 (matches server-side `WEIGHTS` in matching/score.ts)", () => {
    const sum = Object.values(COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0);
    // Floating-point tolerance — the literal sum is 1.0 but
    // 0.3+0.2+0.15+0.1+0.1+0.1+0.05 in IEEE-754 isn't always
    // exactly 1.
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-9);
  });

  it("has exactly the 7 keys of ScoreComponents", () => {
    const keys = Object.keys(COMPONENT_WEIGHTS).sort();
    expect(keys).toEqual([
      "domain_overlap",
      "recency",
      "scope_alignment",
      "semantic_similarity",
      "seniority_alignment",
      "skill_overlap",
      "tool_overlap",
    ]);
  });

  it("matches the PRD weights (drift pin)", () => {
    expect(COMPONENT_WEIGHTS.semantic_similarity).toBe(0.3);
    expect(COMPONENT_WEIGHTS.skill_overlap).toBe(0.2);
    expect(COMPONENT_WEIGHTS.domain_overlap).toBe(0.15);
    expect(COMPONENT_WEIGHTS.tool_overlap).toBe(0.1);
    expect(COMPONENT_WEIGHTS.seniority_alignment).toBe(0.1);
    expect(COMPONENT_WEIGHTS.scope_alignment).toBe(0.1);
    expect(COMPONENT_WEIGHTS.recency).toBe(0.05);
  });
});

describe("buildBreakdownRows", () => {
  it("returns null when components are undefined (legacy pre-#131 match)", () => {
    expect(buildBreakdownRows(undefined)).toBeNull();
  });

  it("returns 7 rows in COMPONENT_DISPLAY_ORDER", () => {
    const rows = buildBreakdownRows(FULL);
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => r.key)).toEqual(COMPONENT_DISPLAY_ORDER);
  });

  it("each row has correct value, weight, and contribution = value × weight", () => {
    const rows = buildBreakdownRows(FULL)!;
    for (const row of rows) {
      const expectedValue = FULL[row.key];
      const expectedWeight = COMPONENT_WEIGHTS[row.key];
      expect(row.value).toBe(expectedValue);
      expect(row.weight).toBe(expectedWeight);
      expect(row.contribution).toBeCloseTo(expectedValue * expectedWeight, 9);
      expect(row.label).toBe(COMPONENT_LABELS[row.key]);
    }
  });

  it("display order matches the PRD narrative order (highest weight first)", () => {
    expect(COMPONENT_DISPLAY_ORDER).toEqual([
      "semantic_similarity", // 0.30
      "skill_overlap", // 0.20
      "domain_overlap", // 0.15
      "tool_overlap", // 0.10
      "seniority_alignment", // 0.10
      "scope_alignment", // 0.10
      "recency", // 0.05
    ]);
  });
});
