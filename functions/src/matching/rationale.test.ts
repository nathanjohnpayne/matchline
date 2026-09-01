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
    // display string at exactly 200 chars (199 chars + ellipsis);
    // surface_evidence keeps the full text so the Matches tab
    // (#21) can show the full claim on hover. CodeRabbit Minor
    // on round 2 of PR #105 caught the prior version that only
    // asserted "< 500" — would have shipped green if a refactor
    // moved the boundary to 300.
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
    // Pin the EXACT truncation: 199 x's + ellipsis = 200 chars
    // for the unit-summary slot. The rationale also embeds the
    // requirement summary (which is short here, ~5 chars), so
    // we substring-search for the exact truncated block rather
    // than asserting overall string length.
    const expectedTruncatedUnit = "x".repeat(199) + "…";
    expect(result.rationale).toContain(expectedTruncatedUnit);
    // Sanity: ellipsis present, no 200-x run that would mean
    // no truncation happened.
    expect(result.rationale).not.toContain("x".repeat(200));
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
    // Restored to its original expectation. An intermediate
    // revision of #435 made seniority inapplicable whenever the
    // Unit had no ladder-MAPPED signal, which swept in the
    // empty-signals case and pushed this to semantic similarity.
    // That was wrong, and editing this test to match was
    // compensating for the bug rather than catching it: a Unit
    // with `seniority_signals: []` gets a hard 0 from
    // `seniorityAlignment`, which is a real negative measurement
    // ("no evidence of meeting the bar"), not the 0.5 ignorance
    // neutral. Only the signals-present-but-unmapped case is
    // unmeasurable. Codex P2 on #435.
    expect(result.driving_component).toBe("seniority_alignment");
    expect(result.surface_evidence).toBe("");
    // Rationale acknowledges absence without fabricating.
    expect(result.rationale).toContain("no explicit signals");
    // And the seniority template's own no-signals branch keeps
    // its zero-fab contract for any future caller that reaches
    // it directly — pinned via a mapped-signal Unit whose
    // signals list is what surfaces.
    const mapped = generateRationale(
      makeInput({
        components: makeComponents({ seniority_alignment: 1 }),
        unit: {
          normalized_summary: "x",
          skills: [],
          tools: [],
          domains: [],
          seniority_signals: ["led"],
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
      }),
    );
    expect(mapped.driving_component).toBe("seniority_alignment");
    expect(mapped.surface_evidence).toBe("led");
    expect(mapped.rationale).not.toMatch(/none recorded/);
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
    // Narrowed on #435 (Codex P2), same shape as the seniority
    // case above. A Unit with no `date_range` has nothing the
    // recency curve can measure, so `recency` no longer drives
    // the rationale and this falls through to semantic
    // similarity. The `recency: 1` fixture was another
    // impossible pairing: the real `recency()` returns the 0.5
    // neutral, not 1, for a Unit with no dates.
    //
    // The contract this test was written for is unchanged and
    // still asserted: no fabricated placeholder reaches
    // `surface_evidence`.
    expect(result.driving_component).toBe("semantic_similarity");
    expect(result.surface_evidence).toBe("x");
    expect(result.rationale).not.toMatch(/no date recorded/);

    // The recency template's own contract, on the reachable
    // path: a Unit with a real date can still drive it.
    const dated = generateRationale(
      makeInput({
        components: makeComponents({ recency: 1 }),
        unit: {
          normalized_summary: "x",
          skills: [],
          tools: [],
          domains: [],
          seniority_signals: [],
          scope_signals: [],
          date_range: { start: "2021-01-01", end: "2026-01-01" },
        },
      }),
    );
    expect(dated.driving_component).toBe("recency");
    expect(dated.rationale).not.toMatch(/no date recorded/);
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
        // A keyword that DOES canonicalize, so the skill axis is
        // evaluable and may drive the rationale. The Unit's own
        // term is the un-normalizable side, which is what makes
        // `canonicalOverlap` come back empty and exercises the
        // defensive branch. Before #435 the Requirement keyword
        // here was also un-normalizable; that now makes the axis
        // inapplicable entirely and it can no longer drive — see
        // the applicability tests below.
        category: "skill",
        keywords: ["sql"],
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
        // A keyword that DOES canonicalize, so the skill axis is
        // evaluable and may drive the rationale. The Unit's own
        // term is the un-normalizable side, which is what makes
        // `canonicalOverlap` come back empty and exercises the
        // defensive branch. Before #435 the Requirement keyword
        // here was also un-normalizable; that now makes the axis
        // inapplicable entirely and it can no longer drive — see
        // the applicability tests below.
        category: "skill",
        keywords: ["sql"],
        tools: [],
        domains: [],
      },
    });
    const result = generateRationale(input);
    expect(result.driving_component).toBe("skill_overlap");
    expect(result.surface_evidence).toBe("totally-novel-skill-xyz");
  });
});

describe("generateRationale: axis applicability (CodeRabbit Major on #435)", () => {
  // #430 made `jaccard()` return the 0.5 neutral when the
  // Requirement side is empty or unrecognized, so an axis the
  // employer never constrained still contributes 0.10 — enough
  // to win the tie-break and drive the rationale. The templates
  // then narrate a comparison that never happened and hand the
  // Unit's own skills/tools/domains to `surface_evidence` as
  // support for it. That is the zero-fabrication boundary this
  // module's docstring claims to hold.
  const unit = {
    normalized_summary: "Led Disney+ launch across living-room platforms",
    skills: ["product strategy", "platform product management"],
    tools: ["jira", "github"],
    domains: ["streaming video"],
    seniority_signals: ["led"],
    scope_signals: [],
  };

  it("does not let an unconstrained skill axis drive the rationale", () => {
    const result = generateRationale(
      makeInput({
        // Neutral skill_overlap outweighs a weak semantic score
        // on raw contribution: 0.20 x 0.5 = 0.10 vs 0.30 x 0.2 =
        // 0.06. Without the applicability filter this picks
        // skill_overlap.
        components: makeComponents({
          semantic_similarity: 0.2,
          skill_overlap: 0.5,
        }),
        unit,
        requirement: {
          normalized_requirement: "BS in Computer Science",
          category: "credential",
          keywords: [],
          tools: [],
          domains: [],
        },
      }),
    );
    expect(result.driving_component).toBe("semantic_similarity");
    expect(result.rationale).not.toMatch(/skill/i);
    // And critically: the Unit's skills are not offered as
    // evidence for a requirement that named none.
    expect(result.surface_evidence).not.toContain("product strategy");
  });

  it("does not let an unrecognized Requirement vocabulary drive it either", () => {
    // Populated arrays are not a constraint if nothing survives
    // canonicalization — the engine had nothing to compare.
    const result = generateRationale(
      makeInput({
        components: makeComponents({
          semantic_similarity: 0.2,
          skill_overlap: 0.5,
          tool_overlap: 0.5,
          domain_overlap: 0.5,
        }),
        unit,
        requirement: {
          normalized_requirement: "y",
          category: "skill",
          keywords: ["xyzzy-not-a-real-skill"],
          tools: ["plugh-not-a-real-tool"],
          domains: ["frobnitz-not-a-real-domain"],
        },
      }),
    );
    expect(result.driving_component).toBe("semantic_similarity");
  });

  it("does not let an unconstrained seniority or scope axis drive it", () => {
    // Both return 1.0 when the Requirement doesn't constrain
    // them — 0.10 of contribution each, same leak as the Jaccard
    // neutral.
    const result = generateRationale(
      makeInput({
        components: makeComponents({
          semantic_similarity: 0.2,
          seniority_alignment: 1,
          scope_alignment: 1,
        }),
        unit,
        requirement: {
          normalized_requirement: "y",
          category: "skill",
          keywords: [],
          tools: [],
          domains: [],
        },
      }),
    );
    expect(result.driving_component).toBe("semantic_similarity");
  });

  it("still lets a genuinely constrained axis drive", () => {
    // The filter must not swallow real signal.
    const result = generateRationale(
      makeInput({
        components: makeComponents({
          semantic_similarity: 0.2,
          skill_overlap: 1,
        }),
        unit,
        requirement: {
          normalized_requirement: "y",
          category: "skill",
          keywords: ["product strategy"],
          tools: [],
          domains: [],
        },
      }),
    );
    expect(result.driving_component).toBe("skill_overlap");
    expect(result.surface_evidence).toContain("product strategy");
  });
});

describe("generateRationale: unmapped seniority (Codex P2 round 5 on #435)", () => {
  // Fourth instance of one pattern on this PR: a neutral
  // introduced so the engine doesn't punish a Unit for something
  // it couldn't evaluate, then read downstream as a measurement.
  // The coverage gate learned to exclude the unmapped-seniority
  // 0.5 in round 4; the rationale hadn't.
  const base = {
    normalized_summary: "Ran the living-room launch programme",
    skills: [],
    tools: [],
    domains: [],
    scope_signals: [],
  };

  it("does not let an unmapped seniority signal narrate the match", () => {
    const result = generateRationale(
      makeInput({
        // Weak semantic (0.30 x 0.1 = 0.03) against the seniority
        // neutral (0.10 x 0.5 = 0.05): without the filter the
        // neutral wins and emits "Matched on seniority alignment"
        // for a comparison that never ran.
        components: makeComponents({
          semantic_similarity: 0.1,
          seniority_alignment: 0.5,
          recency: 0,
        }),
        unit: { ...base, seniority_signals: ["mentored"] },
        requirement: {
          normalized_requirement: "Staff-level product ownership",
          category: "skill",
          keywords: [],
          tools: [],
          domains: [],
          seniority_level: "staff",
        },
      }),
    );
    expect(result.driving_component).toBe("semantic_similarity");
    expect(result.rationale).not.toMatch(/seniority/i);
  });

  it("still lets a LADDER-MAPPED signal narrate it at the same 0.5", () => {
    // Same component value, same weights — only the mapping
    // differs, which is the whole point.
    const result = generateRationale(
      makeInput({
        components: makeComponents({
          semantic_similarity: 0.1,
          seniority_alignment: 0.5,
          recency: 0,
        }),
        unit: { ...base, seniority_signals: ["led"] },
        requirement: {
          normalized_requirement: "Staff-level product ownership",
          category: "skill",
          keywords: [],
          tools: [],
          domains: [],
          seniority_level: "staff",
        },
      }),
    );
    expect(result.driving_component).toBe("seniority_alignment");
    expect(result.surface_evidence).toBe("led");
  });
});

describe("generateRationale: unknown recency (Codex P2 on #435)", () => {
  // Fifth instance of the pattern, and the one that made the
  // spec's invariant worth writing down: `recency()` returns 0.5
  // when a Unit has no usable date, and `requirementAxes` always
  // marks recency applicable because it's a Unit-side axis with
  // nothing for a Requirement to constrain. With a weak semantic
  // score the neutral wins and the match is explained by the
  // absence of information.
  const unit = {
    normalized_summary: "Ran the living-room launch programme",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
  };
  const requirement = {
    normalized_requirement: "Ship consumer products",
    category: "skill" as const,
    keywords: [],
    tools: [],
    domains: [],
  };

  it("does not let a missing date_range narrate the match", () => {
    const result = generateRationale(
      makeInput({
        // 0.05 x 0.5 = 0.025 beats 0.30 x 0.05 = 0.015.
        components: makeComponents({
          semantic_similarity: 0.05,
          recency: 0.5,
        }),
        unit,
        requirement,
      }),
    );
    expect(result.driving_component).toBe("semantic_similarity");
    expect(result.rationale).not.toMatch(/recency/i);
  });

  it("does not let an unparseable date narrate it either", () => {
    const result = generateRationale(
      makeInput({
        components: makeComponents({
          semantic_similarity: 0.05,
          recency: 0.5,
        }),
        unit: { ...unit, date_range: { start: "not-a-date" } },
        requirement,
      }),
    );
    expect(result.driving_component).toBe("semantic_similarity");
  });

  it("still lets a measurable date narrate it at the same 0.5", () => {
    // Again the value is identical; only measurability differs.
    const result = generateRationale(
      makeInput({
        components: makeComponents({
          semantic_similarity: 0.05,
          recency: 0.5,
        }),
        unit: { ...unit, date_range: { start: "2016-01-01", end: "2021-01-01" } },
        requirement,
      }),
    );
    expect(result.driving_component).toBe("recency");
  });
});

describe("recencyTemplate: partial date ranges (CodeRabbit on #435)", () => {
  // `hasMeasurableRecency` gates on `end` when `end` is present,
  // so the template can be reached with a measurable end and an
  // unusable start. The prior guard keyed on `start` alone,
  // which made those two cases wrong in opposite directions.
  const base = {
    normalized_summary: "x",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
  };
  const requirement = {
    normalized_requirement: "y",
    category: "skill" as const,
    keywords: [],
    tools: [],
    domains: [],
  };

  it("renders an end-only range as end-date evidence, not 'no date'", () => {
    const r = generateRationale(
      makeInput({
        components: makeComponents({ recency: 1 }),
        unit: { ...base, date_range: { start: "", end: "2021-01-01" } },
        requirement,
      }),
    );
    expect(r.driving_component).toBe("recency");
    expect(r.surface_evidence).toBe("through 2021-01-01");
    expect(r.rationale).not.toMatch(/no usable date/);
  });

  it("does not surface an unparseable start alongside a valid end", () => {
    const r = generateRationale(
      makeInput({
        components: makeComponents({ recency: 1 }),
        unit: {
          ...base,
          date_range: { start: "not-a-date", end: "2021-01-01" },
        },
        requirement,
      }),
    );
    expect(r.driving_component).toBe("recency");
    expect(r.surface_evidence).not.toContain("not-a-date");
    expect(r.surface_evidence).toBe("through 2021-01-01");
  });

  it("still renders a full range as start-to-end", () => {
    const r = generateRationale(
      makeInput({
        components: makeComponents({ recency: 1 }),
        unit: {
          ...base,
          date_range: { start: "2016-01-01", end: "2021-01-01" },
        },
        requirement,
      }),
    );
    expect(r.surface_evidence).toBe("2016-01-01 to 2021-01-01");
  });

  it("still marks a start-only range as ongoing", () => {
    const r = generateRationale(
      makeInput({
        components: makeComponents({ recency: 1 }),
        unit: { ...base, date_range: { start: "2021-01-01" } },
        requirement,
      }),
    );
    expect(r.surface_evidence).toBe("2021-01-01 (ongoing)");
  });
});
