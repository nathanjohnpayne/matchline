import { describe, expect, it } from "vitest";

import { generateRationale, type RationaleInput } from "./rationale.js";
import type { ScoreComponents } from "./score.js";

/**
 * Tests for the deterministic rationale generator (#100).
 *
 * Coverage strategy: one test per template (7 components → 7
 * primary tests), plus tie-breaker semantics, plus zero-fab
 * surface_evidence pin, plus truncation for long summaries.
 */

function makeComponents(
  overrides: Partial<ScoreComponents> = {},
): ScoreComponents {
  return {
    semantic_similarity: 0,
    skill_overlap: 0,
    domain_overlap: 0,
    tool_overlap: 0,
    seniority_alignment: 0,
    scope_alignment: 0,
    recency: 0,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<RationaleInput> = {},
): RationaleInput {
  return {
    components: makeComponents(),
    unit: {
      normalized_summary: "Led streaming-video PM at Disney+",
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
    },
    requirement: {
      normalized_requirement: "Senior PM with streaming experience",
      category: "skill",
      keywords: [],
      tools: [],
      domains: [],
    },
    ...overrides,
  };
}

// -- Per-template tests -----------------------------------------------------

describe("generateRationale: skill_overlap template", () => {
  it("emits 'shared <skills>' prose with canonical-name surface_evidence", () => {
    const input = makeInput({
      components: makeComponents({ skill_overlap: 1 }),
      unit: {
        normalized_summary: "Drove product strategy",
        skills: ["product strategy", "okrs"],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "Strategy + OKRs",
        category: "skill",
        keywords: ["product strategy", "okrs"],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("skill_overlap");
    expect(result.rationale).toContain("skill overlap");
    expect(result.rationale).toContain("okrs");
    expect(result.rationale).toContain("product strategy");
    expect(result.surface_evidence).toContain("okrs");
    expect(result.surface_evidence).toContain("product strategy");
  });
});

describe("generateRationale: tool_overlap template", () => {
  it("emits 'shared <tools>' prose when tool_overlap dominates", () => {
    const input = makeInput({
      components: makeComponents({ tool_overlap: 1 }),
      unit: {
        normalized_summary: "Used Jira and Figma",
        skills: [],
        tools: ["jira", "figma"],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "Jira/Figma",
        category: "tool",
        keywords: [],
        tools: ["jira", "figma"],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("tool_overlap");
    expect(result.rationale).toContain("tool overlap");
    expect(result.rationale).toContain("jira");
    expect(result.rationale).toContain("figma");
  });
});

describe("generateRationale: domain_overlap template", () => {
  it("emits domain prose when domain_overlap dominates", () => {
    const input = makeInput({
      components: makeComponents({ domain_overlap: 1 }),
      unit: {
        normalized_summary: "Streaming work",
        skills: [],
        tools: [],
        domains: ["streaming video"],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "Streaming role",
        category: "domain",
        keywords: [],
        tools: [],
        domains: ["streaming video"],
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("domain_overlap");
    expect(result.rationale).toContain("domain overlap");
    expect(result.rationale).toContain("streaming video");
    expect(result.surface_evidence).toContain("streaming video");
  });
});

describe("generateRationale: semantic_similarity template", () => {
  it("emits 'unit ↔ requirement' prose with the unit's normalized_summary as evidence", () => {
    // Pure-semantic match: no shared skills/tools/domains, but
    // high embedding similarity. The rationale points at
    // semantic; surface_evidence is the unit's normalized_summary.
    const input = makeInput({
      components: makeComponents({ semantic_similarity: 1 }),
      unit: {
        normalized_summary:
          "Owned Disney+ playback memory optimization shipping to 5M DAU",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement:
          "Senior PM with streaming optimization experience",
        category: "skill",
        keywords: [],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("semantic_similarity");
    expect(result.rationale).toContain("semantic similarity");
    expect(result.rationale).toContain("↔");
    expect(result.surface_evidence).toBe(
      "Owned Disney+ playback memory optimization shipping to 5M DAU",
    );
  });

  it("truncates long summaries to 200 chars in the displayed prose, but keeps full text in surface_evidence", () => {
    // Pin the truncation contract: rationale gets a truncated
    // display string; surface_evidence keeps the full text so
    // the Matches tab (#21) can show the full claim on hover.
    const longSummary = "x".repeat(500);
    const input = makeInput({
      components: makeComponents({ semantic_similarity: 1 }),
      unit: {
        normalized_summary: longSummary,
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
    });
    const result = generateRationale(input);
    expect(result.surface_evidence).toBe(longSummary);
    expect(result.surface_evidence.length).toBe(500);
    // Rationale is bounded; ellipsis indicates truncation.
    expect(result.rationale.length).toBeLessThan(500);
    expect(result.rationale).toContain("…");
  });
});

describe("generateRationale: seniority_alignment template", () => {
  it("emits 'Unit signals X against required level Y' prose", () => {
    const input = makeInput({
      components: makeComponents({ seniority_alignment: 1 }),
      unit: {
        normalized_summary: "Led project",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: ["led", "owned"],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "Senior PM",
        category: "experience_level",
        keywords: [],
        tools: [],
        domains: [],
        seniority_level: "senior",
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("seniority_alignment");
    expect(result.rationale).toContain("seniority alignment");
    expect(result.rationale).toContain("led");
    expect(result.rationale).toContain("senior");
    expect(result.surface_evidence).toContain("led");
  });
});

describe("generateRationale: scope_alignment template", () => {
  it("emits scope prose with the unit's scope_signals as evidence", () => {
    const input = makeInput({
      components: makeComponents({ scope_alignment: 1 }),
      unit: {
        normalized_summary: "Hit 5M DAU",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: ["5M DAU", "$10M budget"],
      },
      requirement: {
        normalized_requirement: "Multi-million-user product",
        category: "scope",
        keywords: ["5M DAU"],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("scope_alignment");
    expect(result.rationale).toContain("scope alignment");
    expect(result.rationale).toContain("5M DAU");
    expect(result.surface_evidence).toContain("5M DAU");
  });
});

describe("generateRationale: recency template", () => {
  it("emits 'recent' prose with date_range as evidence", () => {
    const input = makeInput({
      components: makeComponents({ recency: 1 }),
      unit: {
        normalized_summary: "Recent work",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
        date_range: { start: "2025-01-01", end: "2025-06-01" },
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("recency");
    expect(result.rationale.toLowerCase()).toContain("recent");
    expect(result.rationale).toContain("2025-01-01");
    expect(result.rationale).toContain("2025-06-01");
    expect(result.surface_evidence).toBe("2025-01-01 to 2025-06-01");
  });

  it("indicates ongoing roles when date_range.end is missing", () => {
    const input = makeInput({
      components: makeComponents({ recency: 1 }),
      unit: {
        normalized_summary: "Ongoing role",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
        date_range: { start: "2024-01-01" },
      },
    });
    const result = generateRationale(input);
    expect(result.surface_evidence).toContain("ongoing");
  });
});

// -- Driving-component selection + tie-breaker ------------------------------

describe("generateRationale: driving_component selection (largest weighted contribution)", () => {
  it("picks the component with the highest weight × value product", () => {
    // semantic_similarity = 0.5 (weight 0.30 → 0.15)
    // skill_overlap = 0.9     (weight 0.20 → 0.18) ← winner
    const input = makeInput({
      components: makeComponents({
        semantic_similarity: 0.5,
        skill_overlap: 0.9,
      }),
      unit: {
        normalized_summary: "x",
        skills: ["product strategy"],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "y",
        category: "skill",
        keywords: ["product strategy"],
        tools: [],
        domains: [],
      },
    });
    expect(generateRationale(input).driving_component).toBe("skill_overlap");
  });

  it("picks semantic when semantic_similarity dominates by weighted contribution", () => {
    // skill_overlap = 0.5 × 0.20 = 0.10
    // semantic_similarity = 0.5 × 0.30 = 0.15 ← winner
    const input = makeInput({
      components: makeComponents({
        semantic_similarity: 0.5,
        skill_overlap: 0.5,
      }),
      unit: {
        normalized_summary: "x",
        skills: ["product strategy"],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "y",
        category: "skill",
        keywords: ["product strategy"],
        tools: [],
        domains: [],
      },
    });
    expect(generateRationale(input).driving_component).toBe(
      "semantic_similarity",
    );
  });

  it("tie-breaker: when contributions are exactly equal, semantic > skill > domain > tool > seniority > scope > recency", () => {
    // All zero except tool_overlap and seniority_alignment, both
    // at full value. Both weights are 0.10 — exact tie at 0.10.
    // Tie-breaker order says tool_overlap (earlier in the list)
    // wins over seniority_alignment.
    const input = makeInput({
      components: makeComponents({
        tool_overlap: 1,
        seniority_alignment: 1,
      }),
      unit: {
        normalized_summary: "x",
        skills: [],
        tools: ["jira"],
        domains: [],
        seniority_signals: ["senior"],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "y",
        category: "tool",
        keywords: [],
        tools: ["jira"],
        domains: [],
        seniority_level: "senior",
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("tool_overlap");
  });

  it("tie-breaker pin: when semantic and domain contributions are exactly equal, semantic wins (earlier in order)", () => {
    // Construct an exact-tie between semantic and domain.
    // Floating-point safe choice (both sides hit 0.15 exactly):
    //   semantic = 0.5 × 0.30 = 0.15
    //   domain   = 1.0 × 0.15 = 0.15
    // Tied. Tie-breaker order says semantic_similarity (earlier)
    // wins. Codex/CodeRabbit on PR #105 caught the prior version
    // of this test that didn't actually create a tie (the
    // skill case used 1.5 × 0.20 which is 0.30000000000000004
    // due to floating-point, not an exact tie); this rewrite
    // uses values whose products are bit-exact.
    const input = makeInput({
      components: makeComponents({
        semantic_similarity: 0.5,
        domain_overlap: 1.0,
      }),
      unit: {
        normalized_summary: "x",
        skills: [],
        tools: [],
        domains: ["streaming video"],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "y",
        category: "domain",
        keywords: [],
        tools: [],
        domains: ["streaming video"],
      },
    });
    expect(generateRationale(input).driving_component).toBe(
      "semantic_similarity",
    );
  });

  it("tie-breaker pin: identical scope and recency contributions pick scope (earlier in order)", () => {
    // scope_alignment (weight 0.10) vs. recency (weight 0.05).
    // Pick values that make their contributions equal:
    //   scope = 0.5 × 0.10 = 0.05
    //   recency = 1 × 0.05 = 0.05
    // Tied. Tie-breaker says scope_alignment (earlier in order)
    // wins.
    const input = makeInput({
      components: makeComponents({
        scope_alignment: 0.5,
        recency: 1,
      }),
      unit: {
        normalized_summary: "x",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: ["5M users"],
        date_range: { start: "2025-01-01", end: "2025-06-01" },
      },
      requirement: {
        normalized_requirement: "y",
        category: "scope",
        keywords: ["5M users"],
        tools: [],
        domains: [],
      },
    });
    expect(generateRationale(input).driving_component).toBe("scope_alignment");
  });
});

// -- Zero-fabrication invariant pin -----------------------------------------

describe("generateRationale: zero-fabrication invariant", () => {
  it("surface_evidence on a skill-driven match always traces to the canonical skill name (never invents)", () => {
    // The canonical-skill name "okrs" is in the unit's input.
    // surface_evidence emits the canonical form (which IS user-
    // controlled because it round-trips from the user's
    // synonym in the ontology). This is the load-bearing zero-
    // fabrication pin for the rationale generator: every
    // element of surface_evidence must trace to user-controlled
    // input data.
    const input = makeInput({
      components: makeComponents({ skill_overlap: 1 }),
      unit: {
        normalized_summary: "Set OKRs",
        skills: ["OKR setting"], // synonym for "okrs"
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "Drive OKRs",
        category: "skill",
        keywords: ["okrs"],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.surface_evidence).toBe("okrs");
    // The canonical name "okrs" comes from the ontology seed,
    // which the user controls (Nathan curates the seed file
    // referenced by `normalize.ts`). NEVER from an LLM call.
  });

  it("rationale string never contains text not derivable from the input (deterministic-pin)", () => {
    // Run the same input twice → byte-identical output. If the
    // function had non-determinism (LLM, randomness, clock),
    // this would flake.
    const input = makeInput({
      components: makeComponents({ semantic_similarity: 1 }),
    });
    const a = generateRationale(input);
    const b = generateRationale(input);
    expect(a.rationale).toBe(b.rationale);
    expect(a.surface_evidence).toBe(b.surface_evidence);
    expect(a.driving_component).toBe(b.driving_component);
  });
});

// -- Edge cases -------------------------------------------------------------

// -- Round-1 fix pins (Codex/CodeRabbit on PR #105) -------------------------

describe("generateRationale: empty-data fallback honesty (round 1)", () => {
  it("seniority with no unit signals: surface_evidence is empty (NOT 'none recorded')", () => {
    // Codex P2 / CodeRabbit on PR #105 caught a prior version
    // that wrote "none recorded" into surface_evidence — a
    // fabricated string violating the zero-fab claim. Fix:
    // surface_evidence is the empty string when there's no real
    // signal; rationale prose can describe absence without
    // fabricating onto surface_evidence.
    const input = makeInput({
      components: makeComponents({ seniority_alignment: 1 }),
      unit: {
        normalized_summary: "x",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "y",
        category: "experience_level",
        keywords: [],
        tools: [],
        domains: [],
        seniority_level: "senior",
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("seniority_alignment");
    expect(result.surface_evidence).toBe("");
    // Rationale acknowledges absence without fabricating.
    expect(result.rationale).toContain("no explicit signals");
  });

  it("recency with no date_range: surface_evidence is empty (NOT 'no date recorded')", () => {
    const input = makeInput({
      components: makeComponents({ recency: 1 }),
      unit: {
        normalized_summary: "x",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
        // date_range intentionally omitted
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("recency");
    expect(result.surface_evidence).toBe("");
    expect(result.rationale).toContain("no date range");
  });

  it("skill template with no canonical overlap: rationale does NOT claim 'shared <skills>'", () => {
    // Codex P2 on PR #105 caught the prior version that emitted
    // "Matched on skill overlap." with empty surface_evidence —
    // misleading because it claimed an overlap with no
    // supporting evidence.
    const input = makeInput({
      components: makeComponents({ skill_overlap: 1 }),
      unit: {
        normalized_summary: "x",
        skills: ["totally-novel-skill-xyz"],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "y",
        category: "skill",
        keywords: ["another-novel-skill"],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    // The new rationale acknowledges no canonical overlap was
    // found — doesn't claim "shared X" without an X.
    expect(result.rationale).not.toMatch(/shared/);
    expect(result.rationale).toContain("no canonical overlap");
    // surface_evidence still traces to user-controlled input.
    expect(result.surface_evidence).toBe("totally-novel-skill-xyz");
  });
});

describe("generateRationale: scope-overlap precision (CodeRabbit Major round 1)", () => {
  it("only surfaces scope signals that actually match the requirement (not all unit signals)", () => {
    // Prior version emitted EVERY unit.scope_signals entry —
    // including ones that didn't match the requirement —
    // over-claiming the match. CodeRabbit Major on PR #105.
    // Now scope_overlap computes the canonical overlap and
    // surfaces only the matching signals.
    const input = makeInput({
      components: makeComponents({ scope_alignment: 1 }),
      unit: {
        normalized_summary: "x",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        // Unit has 3 scope signals; only ONE matches the requirement.
        scope_signals: ["5M users", "$10M budget", "team of 20"],
      },
      requirement: {
        normalized_requirement: "y",
        category: "scope",
        keywords: ["5M users"],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("scope_alignment");
    // Only "5M users" surfaces — NOT "$10M budget" or "team of 20".
    expect(result.surface_evidence).toBe("5M users");
    expect(result.rationale).toContain("5M users");
    expect(result.rationale).not.toContain("$10M budget");
    expect(result.rationale).not.toContain("team of 20");
  });

  it("scope template with no canonical overlap: rationale doesn't claim alignment", () => {
    // Component drove the score (in practice this shouldn't
    // happen — score.ts would return 0 with no overlap — but
    // we cover the defensive branch).
    const input = makeInput({
      components: makeComponents({ scope_alignment: 1 }),
      unit: {
        normalized_summary: "x",
        skills: [],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: ["alpha"],
      },
      requirement: {
        normalized_requirement: "y",
        category: "scope",
        keywords: ["beta"],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.surface_evidence).toBe("");
    expect(result.rationale).toContain("no canonical overlap");
  });
});

describe("generateRationale: edge cases", () => {
  it("all-zero components: still picks semantic_similarity (tie-breaker default)", () => {
    // No component scored above zero — pathological input. The
    // tie-breaker order's first entry wins. The rationale isn't
    // meaningful but the function must return a result; the
    // pipeline filters on final_score for matches that reach
    // the user, not on whether the rationale is informative.
    const input = makeInput({ components: makeComponents() });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("semantic_similarity");
    expect(result.rationale).toContain("semantic similarity");
  });

  it("skill_overlap with no canonical-resolvable terms: defensive fallback to raw skill list", () => {
    // The skill_overlap component scored > 0 (somehow — maybe
    // the score function returned a partial), but no
    // canonical-form lookup matches. Don't fabricate a list
    // that wasn't there; surface the raw unit.skills as evidence.
    const input = makeInput({
      components: makeComponents({ skill_overlap: 1 }),
      unit: {
        normalized_summary: "x",
        skills: ["totally-novel-skill-xyz"],
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
      },
      requirement: {
        normalized_requirement: "y",
        category: "skill",
        keywords: ["another-novel-skill"],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("skill_overlap");
    expect(result.surface_evidence).toBe("totally-novel-skill-xyz");
  });
});
