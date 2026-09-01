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

describe("buildBreakdownRows: axis applicability (Codex P2 on #435)", () => {
  const components: ScoreComponents = {
    semantic_similarity: 0.45,
    skill_overlap: 0.5,
    domain_overlap: 0.5,
    tool_overlap: 0.5,
    seniority_alignment: 1,
    scope_alignment: 1,
    recency: 1,
  };

  it("marks unevaluated axes so the tooltip can't present a neutral as a score", () => {
    // The out-of-domain case: the Requirement named nothing the
    // canonical vocabulary recognizes, so skill/domain/tool hold
    // the 0.5 no-constraint neutral. Rendering that as
    // "0.50 x 0.20 = 0.100" tells the user they achieved 50%
    // overlap on a comparison that never ran.
    const rows = buildBreakdownRows(components, {
      semantic_similarity: true,
      skill_overlap: false,
      domain_overlap: false,
      tool_overlap: false,
      seniority_alignment: false,
      scope_alignment: false,
      recency: true,
    })!;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("skill_overlap")!.evaluated).toBe(false);
    expect(byKey.get("domain_overlap")!.evaluated).toBe(false);
    expect(byKey.get("tool_overlap")!.evaluated).toBe(false);
    expect(byKey.get("seniority_alignment")!.evaluated).toBe(false);
    expect(byKey.get("scope_alignment")!.evaluated).toBe(false);
    expect(byKey.get("semantic_similarity")!.evaluated).toBe(true);
    expect(byKey.get("recency")!.evaluated).toBe(true);
  });

  it("keeps the raw value and weight on an unevaluated row", () => {
    // The row still carries its stored numbers — the renderer
    // decides not to show them. Dropping them here would make
    // the helper lossy for any future consumer.
    const rows = buildBreakdownRows(components, {
      semantic_similarity: true,
      skill_overlap: false,
      domain_overlap: true,
      tool_overlap: true,
      seniority_alignment: true,
      scope_alignment: true,
      recency: true,
    })!;
    const skill = rows.find((r) => r.key === "skill_overlap")!;
    expect(skill.value).toBe(0.5);
    expect(skill.weight).toBe(0.2);
    expect(skill.contribution).toBeCloseTo(0.1, 10);
  });

  it("treats legacy rows (no applicability persisted) as UNEVALUATED", () => {
    // Deliberately conservative. Pre-#430 rows contain the very
    // neutrals this flag suppresses — both-empty Jaccard stored
    // 0.5, unconstrained seniority and scope stored 1.0 — so a
    // permissive default would put ignorance back on screen as
    // measured overlap during the backfill window, or forever if
    // the backfill fails. Showing no per-axis numbers until
    // matching reruns is the honest state.
    const rows = buildBreakdownRows(components)!;
    expect(rows.every((r) => r.evaluated)).toBe(false);
  });
});
