import { describe, expect, it } from "vitest";

import {
  hasStructuralEvidence,
  recency,
  requirementAxes,
  scopeAlignment,
  score,
  semanticSimilarityScore,
  seniorityAlignment,
  skillOverlap,
  toolOverlap,
  domainOverlap,
  WEIGHTS,
} from "./score.js";
import type {
  ExperienceUnit,
  JobRequirementUnit,
} from "../types/capability.js";

/**
 * Tests for the matching engine's master scoring composer (sub-issue #97).
 *
 * Pure-function tests — no Firestore, no callables. Each
 * component is tested in isolation, then `score()` is tested for
 * correct composition and the load-bearing confidence-gating
 * invariant.
 */

// -- Helpers ----------------------------------------------------------------

/**
 * Make an ExperienceUnit fixture with safe defaults. Tests
 * override only the fields they care about — the defaults are
 * "well-formed Unit at full confidence with no signals" so the
 * result on any unspecified axis is predictable.
 */
function makeUnit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: "unit-1",
    owner_uid: "u",
    source_type: "resume",
    source_ref: "ref",
    raw_text: "raw",
    normalized_summary: "summary",
    unit_type: "project",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: true,
    embedding: [1, 0, 0],
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRequirement(
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  return {
    id: "req-1",
    owner_uid: "u",
    role_id: "role-1",
    raw_text: "raw",
    normalized_requirement: "norm",
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "medium",
    must_have: false,
    extracted_from: "qualifications",
    embedding: [1, 0, 0],
    ...overrides,
  };
}

// -- WEIGHTS ----------------------------------------------------------------

describe("WEIGHTS", () => {
  it("sum to exactly 1.0 within 1e-9 (PRD pin)", () => {
    const sum =
      WEIGHTS.semantic_similarity +
      WEIGHTS.skill_overlap +
      WEIGHTS.domain_overlap +
      WEIGHTS.tool_overlap +
      WEIGHTS.seniority_alignment +
      WEIGHTS.scope_alignment +
      WEIGHTS.recency;
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it("matches the PRD's documented values exactly", () => {
    // Spec pin: if any of these change without a corresponding
    // PRD update + eval-harness regression report, this fails.
    expect(WEIGHTS.semantic_similarity).toBe(0.3);
    expect(WEIGHTS.skill_overlap).toBe(0.2);
    expect(WEIGHTS.domain_overlap).toBe(0.15);
    expect(WEIGHTS.tool_overlap).toBe(0.1);
    expect(WEIGHTS.seniority_alignment).toBe(0.1);
    expect(WEIGHTS.scope_alignment).toBe(0.1);
    expect(WEIGHTS.recency).toBe(0.05);
  });

  it("is frozen (mutation throws in strict mode)", () => {
    expect(Object.isFrozen(WEIGHTS)).toBe(true);
  });
});

// -- skillOverlap -----------------------------------------------------------

describe("skillOverlap", () => {
  it("returns 1.0 for identical canonical sets", () => {
    const unit = makeUnit({ skills: ["product strategy", "okrs"] });
    const req = makeRequirement({ keywords: ["product strategy", "okrs"] });
    expect(skillOverlap(unit, req)).toBe(1);
  });

  it("returns 0.0 when the Requirement asks and the Unit attests to nothing", () => {
    expect(
      skillOverlap(makeUnit(), makeRequirement({ keywords: ["sql"] })),
    ).toBe(0);
  });

  it("returns 0.5 (neutral) when the REQUIREMENT side is empty, whatever the Unit brings", () => {
    // Directional empty-set rule. An empty Requirement side means
    // the Requirement places no evaluable constraint on this axis
    // — either the JD named nothing, or the seed ontology didn't
    // recognize what it named. "No signal" must not be scored as
    // "candidate fails."
    //
    // Regression: the `coursera-staff-pm-2026` fixture. Its
    // JD-side vocabulary canonicalized at 13% / 9% / 0%
    // (keywords / domains / tools) against 100% on the unit side,
    // so under the prior symmetric rule skill + domain + tool
    // hard-zeroed on EVERY pair. That removed 0.45 of the weight,
    // capped `final_score` below the Gaps view's 0.4 threshold,
    // and rendered a well-matched Role as "every must-have unmet."
    //
    // It also inverted extraction quality: a Unit whose skills all
    // canonicalized scored 0.0 here, while a Unit whose vocabulary
    // was junk (and so normalized away to nothing) collected the
    // both-empty 0.5. Cleaning up a Unit lowered its score. Both
    // Units now sit at the same honest neutral.
    expect(
      skillOverlap(makeUnit({ skills: ["sql"] }), makeRequirement()),
    ).toBe(0.5);
    expect(
      skillOverlap(
        makeUnit({ skills: ["not-in-any-ontology-xyzzy"] }),
        makeRequirement(),
      ),
    ).toBe(0.5);
  });

  it("returns 0.5 (neutral) when BOTH sides are empty (#148 ranking-pathology fix)", () => {
    // Pre-#148 returned 1.0 ("no constraint on this dimension =
    // perfect agreement on nothing"). The live matching trace
    // captured in #148 showed that path firing on every (Unit,
    // Requirement) pair where the seed ontology didn't recognize
    // either side's vocabulary — so 14-year-old broadcast Units
    // ranked above current streaming work because skill / tool /
    // domain all flattened to 1.0 from "all-nulls vs. all-nulls."
    // 0.5 (neutral) is the same fallback `seniorityAlignment`
    // uses for unknown ladder terms — consistent semantics
    // across the rule components.
    expect(skillOverlap(makeUnit(), makeRequirement())).toBe(0.5);
  });

  it("normalizes both sides through the canonical ontology (synonyms match)", () => {
    // 'rice scoring' is a synonym for 'prioritization'; 'gtm' is
    // a synonym for 'go-to-market'.
    const unit = makeUnit({ skills: ["RICE scoring", "GTM"] });
    const req = makeRequirement({ keywords: ["prioritization", "go-to-market"] });
    expect(skillOverlap(unit, req)).toBe(1);
  });

  it("monotonic: more overlap → higher score", () => {
    const req = makeRequirement({
      keywords: ["product strategy", "okrs", "sql"],
    });
    const noOverlap = makeUnit({ skills: ["python"] });
    const oneOverlap = makeUnit({ skills: ["product strategy"] });
    const fullOverlap = makeUnit({
      skills: ["product strategy", "okrs", "sql"],
    });
    expect(skillOverlap(noOverlap, req)).toBeLessThan(
      skillOverlap(oneOverlap, req),
    );
    expect(skillOverlap(oneOverlap, req)).toBeLessThan(
      skillOverlap(fullOverlap, req),
    );
  });

  it("drops un-normalizable terms instead of failing", () => {
    // 'totally novel skill' is not in the ontology → drops to
    // null → excluded from the set. The remaining canonical
    // 'sql' aligns 1:1 with the requirement.
    const unit = makeUnit({ skills: ["sql", "totally novel skill xyz"] });
    const req = makeRequirement({ keywords: ["sql"] });
    expect(skillOverlap(unit, req)).toBe(1);
  });
});

// -- toolOverlap ------------------------------------------------------------

describe("toolOverlap", () => {
  it("returns 1.0 for identical canonical sets, normalizes synonyms", () => {
    const unit = makeUnit({ tools: ["jira", "GitHub"] });
    const req = makeRequirement({ tools: ["atlassian jira", "github.com"] });
    expect(toolOverlap(unit, req)).toBe(1);
  });

  it("monotonic: partial overlap is between 0 and 1", () => {
    const score = toolOverlap(
      makeUnit({ tools: ["jira"] }),
      makeRequirement({ tools: ["jira", "linear", "notion"] }),
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("returns 0.5 (neutral) when BOTH sides are empty (#148)", () => {
    // Mirrors the empty-empty regression tests on `skillOverlap`
    // and `domainOverlap`. JD parser frequently emits empty
    // `tools` on requirements that don't call out specific tools
    // (live trace on Google Compute SPM: 14/15 reqs had
    // `tools=[]`). With pre-#148 `1.0`, every Unit's
    // `tool_overlap` flattened to 1.0 against those reqs, adding
    // 0.10 of false-positive signal to rule_score. 0.5 keeps the
    // dimension neutral when neither side asserts a constraint.
    expect(toolOverlap(makeUnit(), makeRequirement())).toBe(0.5);
  });

  it("applies the directional rule: 0.5 when the Requirement names no tool, 0.0 when it names one the Unit lacks", () => {
    // `tools` is the axis where requirement-side-empty dominates in
    // production — the live Google Compute SPM trace cited above had
    // 14/15 requirements at `tools = []` — so a Unit that carries
    // tools meets an empty Requirement side constantly. Pin both
    // halves here, not just the both-empty case: a refactor that
    // reintroduced the symmetric rule would keep the both-empty
    // test green while silently restoring the 0.10-weight hard-zero
    // this change exists to remove.
    expect(
      toolOverlap(makeUnit({ tools: ["jira"] }), makeRequirement()),
    ).toBe(0.5);
    expect(
      toolOverlap(makeUnit(), makeRequirement({ tools: ["jira"] })),
    ).toBe(0);
  });
});

// -- domainOverlap ----------------------------------------------------------

describe("domainOverlap", () => {
  // Domain ontology may be sparse; test against the structural
  // contract (Jaccard on raw inputs after normalize, both-empty
  // → 0.5 neutral, see skillOverlap test for #148 rationale).
  it("returns 0.5 (neutral) when both sides empty (#148)", () => {
    expect(domainOverlap(makeUnit(), makeRequirement())).toBe(0.5);
  });

  it("returns 0.5 when the Requirement names no domain, 0.0 when it names one the Unit lacks", () => {
    // Use canonical-known domains so the assertions exercise the
    // empty-set rule rather than an incidental normalize() miss.
    expect(
      domainOverlap(
        makeUnit({ domains: ["streaming video"] }),
        makeRequirement(),
      ),
    ).toBe(0.5);
    expect(
      domainOverlap(
        makeUnit(),
        makeRequirement({ domains: ["streaming video"] }),
      ),
    ).toBe(0);
  });
});

// -- seniorityAlignment -----------------------------------------------------

describe("seniorityAlignment", () => {
  it("returns 1.0 when the requirement has no seniority_level (no constraint)", () => {
    const unit = makeUnit({ seniority_signals: ["mid"] });
    const req = makeRequirement(); // no seniority_level
    expect(seniorityAlignment(unit, req)).toBe(1);
  });

  it("returns 0 when the requirement asks but the unit signals nothing", () => {
    // Requirement asks for senior; unit attests to no level.
    // Per the docstring: "requirement asks; unit signals nothing"
    // → 0 (no evidence of meeting the bar).
    const req = makeRequirement({ seniority_level: "senior" });
    expect(seniorityAlignment(makeUnit(), req)).toBe(0);
  });

  it("returns 1.0 for an exact level match", () => {
    const unit = makeUnit({ seniority_signals: ["senior"] });
    const req = makeRequirement({ seniority_level: "senior" });
    expect(seniorityAlignment(unit, req)).toBe(1);
  });

  it("returns 0.5 for a one-level gap (mid vs. senior)", () => {
    const unit = makeUnit({ seniority_signals: ["mid"] });
    const req = makeRequirement({ seniority_level: "senior" });
    expect(seniorityAlignment(unit, req)).toBe(0.5);
  });

  it("returns 0.5 for a one-level gap regardless of direction (senior vs. mid)", () => {
    const unit = makeUnit({ seniority_signals: ["senior"] });
    const req = makeRequirement({ seniority_level: "mid" });
    expect(seniorityAlignment(unit, req)).toBe(0.5);
  });

  it("returns 0 for a multi-level gap (mid vs. director)", () => {
    const unit = makeUnit({ seniority_signals: ["mid"] });
    const req = makeRequirement({ seniority_level: "director" });
    expect(seniorityAlignment(unit, req)).toBe(0);
  });

  it("uses the BEST seniority signal when the unit attests to multiple", () => {
    // Unit signals 'mid' and 'staff'; requirement asks 'staff'.
    // Best (max-index) wins → exact match → 1.0.
    const unit = makeUnit({ seniority_signals: ["mid", "staff"] });
    const req = makeRequirement({ seniority_level: "staff" });
    expect(seniorityAlignment(unit, req)).toBe(1);
  });

  it("ignores unrecognized seniority signals (no false zero from typo)", () => {
    // 'staff' is in the ladder; 'rockstar' isn't → ignored.
    // 'staff' alone is one-level above 'senior' (the ask) → 0.5.
    const unit = makeUnit({ seniority_signals: ["rockstar", "staff"] });
    const req = makeRequirement({ seniority_level: "senior" });
    expect(seniorityAlignment(unit, req)).toBe(0.5);
  });

  // Codex P1 review on PR #103: the extraction prompt
  // (resume.v1.md) emits verb-style signals like "led" and
  // "owned". A strict ladder-only lookup hard-zeros every
  // extracted Unit when a requirement sets seniority_level —
  // a systematic bug. The next two tests pin the verb→ladder
  // mapping so a regression to ladder-only would surface here.

  it("maps the verb 'led' to senior (extraction-prompt vocabulary)", () => {
    // resume.test.ts line 63 emits seniority_signals: ["led"]
    // for a Disney+ playback Unit. Against a senior requirement
    // this should be an exact match (1.0), not 0.
    const unit = makeUnit({ seniority_signals: ["led"] });
    const req = makeRequirement({ seniority_level: "senior" });
    expect(seniorityAlignment(unit, req)).toBe(1);
  });

  it("maps the verb 'owned' to senior", () => {
    const unit = makeUnit({ seniority_signals: ["owned"] });
    const req = makeRequirement({ seniority_level: "senior" });
    expect(seniorityAlignment(unit, req)).toBe(1);
  });

  it("maps 'architected' to staff", () => {
    const unit = makeUnit({ seniority_signals: ["architected"] });
    const req = makeRequirement({ seniority_level: "staff" });
    expect(seniorityAlignment(unit, req)).toBe(1);
  });

  it("maps 'vp' / 'head' to director", () => {
    const reqDirector = makeRequirement({ seniority_level: "director" });
    expect(
      seniorityAlignment(makeUnit({ seniority_signals: ["vp"] }), reqDirector),
    ).toBe(1);
    expect(
      seniorityAlignment(
        makeUnit({ seniority_signals: ["head"] }),
        reqDirector,
      ),
    ).toBe(1);
  });

  it("returns 0.5 (neutral) when unit signals are ALL unrecognized (not 0)", () => {
    // The unit attests to *something* but in vocabulary we can't
    // ladder-map. Penalizing this with 0 (the prior behavior)
    // would systematically zero out Units whose extraction
    // prompt evolves to use new prose. Codex P1 fix.
    const unit = makeUnit({ seniority_signals: ["totally novel verb xyz"] });
    const req = makeRequirement({ seniority_level: "senior" });
    expect(seniorityAlignment(unit, req)).toBe(0.5);
  });

  it("still returns 0 when unit.seniority_signals is empty (no signal at all)", () => {
    // Distinct from the "all unrecognized" case above: an empty
    // signals array means the Unit attests to no level. That's
    // still a hard zero — no evidence of meeting the bar.
    const unit = makeUnit({ seniority_signals: [] });
    const req = makeRequirement({ seniority_level: "senior" });
    expect(seniorityAlignment(unit, req)).toBe(0);
  });
});

// -- scopeAlignment ---------------------------------------------------------

describe("scopeAlignment", () => {
  it("returns 1.0 for non-scope-category requirements (no constraint)", () => {
    // V1: scope is only evaluated against scope-category
    // requirements. A 'skill'-category requirement doesn't
    // constrain scope → no penalty.
    const unit = makeUnit({ scope_signals: ["40M users"] });
    const req = makeRequirement({ category: "skill" });
    expect(scopeAlignment(unit, req)).toBe(1);
  });

  it("returns 0.5 (neutral) when both sides empty on a scope requirement (#148)", () => {
    // Was 1.0 pre-#148 — see skillOverlap's empty-empty test
    // for the ranking-pathology rationale. Same jaccard primitive.
    const req = makeRequirement({ category: "scope", keywords: [] });
    expect(scopeAlignment(makeUnit(), req)).toBe(0.5);
  });

  it("returns 0 when the scope Requirement asks and the Unit attests to nothing", () => {
    const req = makeRequirement({ category: "scope", keywords: ["40M users"] });
    expect(scopeAlignment(makeUnit(), req)).toBe(0);
  });

  it("returns 0.5 (neutral) when a scope Requirement carries no keywords", () => {
    // Same directional rule as skill/tool/domain: a scope-category
    // Requirement with nothing in `keywords` constrains nothing.
    const reqEmpty = makeRequirement({ category: "scope", keywords: [] });
    const unit = makeUnit({ scope_signals: ["40M users"] });
    expect(scopeAlignment(unit, reqEmpty)).toBe(0.5);
  });

  it("returns 1.0 for an exact-string scope match", () => {
    const unit = makeUnit({ scope_signals: ["40M users"] });
    const req = makeRequirement({ category: "scope", keywords: ["40M users"] });
    expect(scopeAlignment(unit, req)).toBe(1);
  });

  it("monotonic: more overlap → higher score", () => {
    const req = makeRequirement({
      category: "scope",
      keywords: ["40M users", "$5M P&L", "team of 10"],
    });
    const partial = makeUnit({ scope_signals: ["40M users"] });
    const full = makeUnit({
      scope_signals: ["40M users", "$5M P&L", "team of 10"],
    });
    expect(scopeAlignment(partial, req)).toBeLessThan(
      scopeAlignment(full, req),
    );
  });
});

// -- recency ----------------------------------------------------------------

describe("recency", () => {
  it("returns ~1.0 for a Unit ending today", () => {
    const asOf = new Date("2026-04-24T00:00:00.000Z");
    const unit = makeUnit({
      date_range: { start: "2026-04-01", end: "2026-04-24" },
    });
    expect(recency(unit, { asOf })).toBeCloseTo(1, 9);
  });

  it("returns ~0.5 for a Unit ending exactly one half-life (5 years) ago", () => {
    const asOf = new Date("2026-04-24T00:00:00.000Z");
    const unit = makeUnit({
      date_range: { start: "2021-04-01", end: "2021-04-24" },
    });
    expect(recency(unit, { asOf })).toBeCloseTo(0.5, 2);
  });

  it("floors at 0.10 for a Unit ending decades ago (zero-fab boundary inverse)", () => {
    // A 30-year-old Unit would decay below the floor; verify the
    // floor holds. The floor exists because Nathan has 12+ years
    // of streaming-video experience that's still relevant; no
    // decay-only model should zero it out.
    const asOf = new Date("2026-04-24T00:00:00.000Z");
    const unit = makeUnit({
      date_range: { start: "1996-01-01", end: "1996-12-31" },
    });
    expect(recency(unit, { asOf })).toBe(0.1);
  });

  it("a 10-year-old Unit still scores well above 0", () => {
    const asOf = new Date("2026-04-24T00:00:00.000Z");
    const unit = makeUnit({
      date_range: { start: "2016-04-01", end: "2016-04-24" },
    });
    // 10y / 5y half-life → 0.5^2 = 0.25, well above the 0.10 floor.
    const result = recency(unit, { asOf });
    expect(result).toBeGreaterThan(0.2);
    expect(result).toBeLessThan(0.3);
  });

  it("returns 0.5 (neutral) when date_range is missing", () => {
    expect(recency(makeUnit())).toBe(0.5);
  });

  // Codex P1 review on PR #103: missing date_range.end means
  // the role is ONGOING, not "ended on the start date." The
  // prior fallback-to-start behavior systematically under-
  // ranked current work — a 6-year ongoing role scored ~0.42
  // instead of 1.0. The next two tests pin the new behavior.

  it("treats missing date_range.end as ongoing (recency = 1.0)", () => {
    const asOf = new Date("2026-04-24T00:00:00.000Z");
    const unitOngoing = makeUnit({ date_range: { start: "2020-01-01" } });
    expect(recency(unitOngoing, { asOf })).toBe(1);
  });

  it("ongoing role with explicit end equal to asOf scores 1.0 (consistency check)", () => {
    // Pin the equivalence: an ongoing role (no end) and an
    // ended-today role behave identically.
    const asOf = new Date("2026-04-24T00:00:00.000Z");
    const ongoing = makeUnit({ date_range: { start: "2020-01-01" } });
    const endedToday = makeUnit({
      date_range: { start: "2020-01-01", end: "2026-04-24" },
    });
    expect(recency(ongoing, { asOf })).toBeCloseTo(
      recency(endedToday, { asOf }),
      9,
    );
  });

  it("returns 0.5 (neutral) when end is missing AND start is unparseable", () => {
    // We can't even confirm the Unit is well-formed → neutral
    // 0.5, same as missing date_range.
    const unit = makeUnit({ date_range: { start: "not-a-date" } });
    expect(recency(unit)).toBe(0.5);
  });

  it("monotonic: a more-recent Unit scores higher than an older Unit", () => {
    const asOf = new Date("2026-04-24T00:00:00.000Z");
    const recent = makeUnit({
      date_range: { start: "2025-01-01", end: "2025-06-01" },
    });
    const older = makeUnit({
      date_range: { start: "2018-01-01", end: "2018-06-01" },
    });
    expect(recency(recent, { asOf })).toBeGreaterThan(
      recency(older, { asOf }),
    );
  });
});

// -- semanticSimilarityScore ------------------------------------------------

describe("semanticSimilarityScore", () => {
  it("returns 1.0 for identical embeddings (parallel)", () => {
    const unit = makeUnit({ embedding: [0.6, 0.8] });
    const req = makeRequirement({ embedding: [0.6, 0.8] });
    expect(semanticSimilarityScore(unit, req)).toBeCloseTo(1, 9);
  });

  it("returns 0 for orthogonal embeddings", () => {
    const unit = makeUnit({ embedding: [1, 0] });
    const req = makeRequirement({ embedding: [0, 1] });
    expect(semanticSimilarityScore(unit, req)).toBeCloseTo(0, 9);
  });

  it("clamps negative cosine to 0 (semanticSimilarity contract)", () => {
    const unit = makeUnit({ embedding: [1, 0] });
    const req = makeRequirement({ embedding: [-1, 0] });
    expect(semanticSimilarityScore(unit, req)).toBe(0);
  });

  it("throws when the unit has no embedding", () => {
    const unit = makeUnit({ embedding: undefined });
    const req = makeRequirement({ embedding: [1, 0] });
    expect(() => semanticSimilarityScore(unit, req)).toThrow(/missing embedding/);
  });

  it("throws when the requirement has no embedding", () => {
    const unit = makeUnit({ embedding: [1, 0] });
    const req = makeRequirement({ embedding: undefined });
    expect(() => semanticSimilarityScore(unit, req)).toThrow(/missing embedding/);
  });
});

// -- score() composer -------------------------------------------------------

describe("score (master composer)", () => {
  it("returns final_score = 0 when confidence_score is 0 (zero-fabrication boundary)", () => {
    // LOAD-BEARING TEST. The confidence_score multiplier is the
    // matching layer's enforcement of the zero-fabrication
    // invariant: a Unit with confidence 0 cannot enter the
    // matching pipeline regardless of how perfectly it overlaps.
    // Complementary to the user_approved gate at #82.
    const unit = makeUnit({
      confidence_score: 0,
      skills: ["product strategy"],
      tools: ["jira"],
      domains: [],
      seniority_signals: ["senior"],
      embedding: [1, 0, 0],
      date_range: { start: "2026-04-01", end: "2026-04-24" },
    });
    const req = makeRequirement({
      keywords: ["product strategy"],
      tools: ["jira"],
      seniority_level: "senior",
      embedding: [1, 0, 0],
    });
    const result = score(unit, req);
    // rule_score should be high (it's a perfect match on every axis)
    // but final_score must be 0 because confidence is 0.
    expect(result.rule_score).toBeGreaterThan(0.5);
    expect(result.final_score).toBe(0);
  });

  it("scales linearly with confidence_score (0.5 confidence → half final_score)", () => {
    const base = makeUnit({
      skills: ["product strategy"],
      embedding: [1, 0, 0],
      date_range: { start: "2025-01-01", end: "2025-06-01" },
    });
    const req = makeRequirement({
      keywords: ["product strategy"],
      embedding: [1, 0, 0],
    });
    // Pass asOf to both calls so recency() doesn't read wall-
    // clock time. Without asOf, the two score() calls happen
    // at slightly different `new Date()` values; the recency
    // component drifts between them and rule_score loses its
    // exact equality. The flake reproduced on slow CI runners
    // (PR #104 round 2 unit + build job) but not on faster
    // local runs. nathanpayne-codex flagged in the round 2
    // review notes.
    const asOf = new Date("2026-04-25T00:00:00.000Z");
    const fullConfidence = score(
      { ...base, confidence_score: 1 },
      req,
      { asOf },
    );
    const halfConfidence = score(
      { ...base, confidence_score: 0.5 },
      req,
      { asOf },
    );
    expect(halfConfidence.final_score).toBeCloseTo(
      fullConfidence.final_score / 2,
      9,
    );
    // rule_score is unaffected by confidence (the multiplier is
    // applied only to final_score). Now exact-equal because
    // both calls ran with the same asOf.
    expect(halfConfidence.rule_score).toBe(fullConfidence.rule_score);
  });

  it("rule_score is the weighted sum of components (composition pin)", () => {
    const unit = makeUnit({
      skills: ["product strategy"],
      tools: ["jira"],
      seniority_signals: ["senior"],
      embedding: [1, 0, 0],
      date_range: { start: "2025-01-01", end: "2025-06-01" },
    });
    const req = makeRequirement({
      keywords: ["product strategy"],
      tools: ["jira"],
      seniority_level: "senior",
      embedding: [1, 0, 0],
      // category="skill" → scope_alignment will be 1.0 (no constraint)
    });
    const result = score(unit, req, {
      asOf: new Date("2025-06-01T00:00:00.000Z"),
    });
    const expectedRule =
      WEIGHTS.semantic_similarity * result.components.semantic_similarity +
      WEIGHTS.skill_overlap * result.components.skill_overlap +
      WEIGHTS.domain_overlap * result.components.domain_overlap +
      WEIGHTS.tool_overlap * result.components.tool_overlap +
      WEIGHTS.seniority_alignment * result.components.seniority_alignment +
      WEIGHTS.scope_alignment * result.components.scope_alignment +
      WEIGHTS.recency * result.components.recency;
    expect(result.rule_score).toBeCloseTo(expectedRule, 9);
  });

  it("semantic_score on the result equals components.semantic_similarity", () => {
    const unit = makeUnit({ embedding: [0.6, 0.8] });
    const req = makeRequirement({ embedding: [0.6, 0.8] });
    const result = score(unit, req);
    expect(result.semantic_score).toBe(result.components.semantic_similarity);
  });

  it("hand-pinned fixture: realistic Nathan-style Unit + target Requirement", () => {
    // Composition-fixture pin per the issue acceptance criterion.
    // If a future component change drifts the math without a
    // corresponding fixture update, this test surfaces it.
    //
    // Construction:
    //   - Unit: senior PM, streaming domain, jira+linear, ending June 2025
    //   - Req:  senior PM, streaming domain, jira, "skill" category
    //   - asOf: 2026-04-24 (today, per machine context)
    //
    // Expected (computed by hand from the formulas):
    //   - semantic_similarity = 1.0 (parallel embeddings)
    //   - skill_overlap = 1.0 (one term, exact match)
    //   - domain_overlap = 1.0 (single domain match)
    //   - tool_overlap = 0.5 (jaccard {jira,linear} vs {jira} = 1/2)
    //   - seniority_alignment = 1.0 (exact match)
    //   - scope_alignment = 1.0 (req.category != "scope" → no constraint)
    //   - recency: ~10.5 months ago = 0.875y / 5y = 0.175 half-lives
    //              → 0.5^0.175 ≈ 0.886
    //
    //   rule_score = 0.30*1.0 + 0.20*1.0 + 0.15*1.0 + 0.10*0.5
    //              + 0.10*1.0 + 0.10*1.0 + 0.05*0.886
    //              ≈ 0.30 + 0.20 + 0.15 + 0.05 + 0.10 + 0.10 + 0.0443
    //              ≈ 0.9443
    //
    //   final_score = 0.95 (confidence) * 0.9443 ≈ 0.897
    const unit = makeUnit({
      id: "unit-pin",
      skills: ["product strategy"],
      tools: ["jira", "linear"],
      domains: ["streaming video"],
      seniority_signals: ["senior"],
      confidence_score: 0.95,
      embedding: [1, 0, 0],
      date_range: { start: "2025-01-01", end: "2025-06-01" },
    });
    const req = makeRequirement({
      id: "req-pin",
      category: "skill",
      keywords: ["product strategy"],
      tools: ["jira"],
      domains: ["streaming video"],
      seniority_level: "senior",
      embedding: [1, 0, 0],
    });
    const result = score(unit, req, {
      asOf: new Date("2026-04-24T00:00:00.000Z"),
    });

    expect(result.components.semantic_similarity).toBeCloseTo(1, 9);
    expect(result.components.skill_overlap).toBe(1);
    expect(result.components.domain_overlap).toBe(1);
    expect(result.components.tool_overlap).toBeCloseTo(0.5, 9);
    expect(result.components.seniority_alignment).toBe(1);
    expect(result.components.scope_alignment).toBe(1);
    expect(result.components.recency).toBeGreaterThan(0.85);
    expect(result.components.recency).toBeLessThan(0.92);

    expect(result.rule_score).toBeGreaterThan(0.93);
    expect(result.rule_score).toBeLessThan(0.96);
    expect(result.final_score).toBeGreaterThan(0.88);
    expect(result.final_score).toBeLessThan(0.92);
  });

  it("no component is identically zero on a representative match (component-coverage pin)", () => {
    // Issue acceptance: "every weight contributes a non-zero
    // value to at least one match." This test pins a single
    // realistic match where EVERY component scores > 0,
    // demonstrating that no scorer is structurally degenerate.
    //
    // Note on the requirement.category choice: skill_overlap
    // compares unit.skills against req.keywords, and req.keywords
    // is the parser's per-category keyword bucket — so on a
    // scope-category requirement the keywords are scope-flavored
    // ("40M users") and unit.skills won't match them. To pin
    // every component > 0 we use a multi-requirement-style
    // construction: scope_signals on the unit + scope-category
    // keywords on the req drive scope_alignment, and we add a
    // matching skill to both sides for skill_overlap. This
    // doesn't faithfully model the JD parser's per-requirement
    // categorization (in real usage one Requirement has one
    // category) — it's a synthetic component-coverage pin.
    const unit = makeUnit({
      skills: ["product strategy"],
      tools: ["jira"],
      domains: ["streaming video"],
      seniority_signals: ["senior"],
      scope_signals: ["40M users"],
      embedding: [0.6, 0.8],
      date_range: { start: "2025-01-01", end: "2025-06-01" },
    });
    const req = makeRequirement({
      category: "scope",
      keywords: ["40M users", "product strategy"],
      tools: ["jira"],
      domains: ["streaming video"],
      seniority_level: "senior",
      embedding: [0.6, 0.8],
    });
    const result = score(unit, req, {
      asOf: new Date("2026-04-24T00:00:00.000Z"),
    });
    // Every component scored above zero on this pair.
    expect(result.components.semantic_similarity).toBeGreaterThan(0);
    expect(result.components.skill_overlap).toBeGreaterThan(0);
    expect(result.components.domain_overlap).toBeGreaterThan(0);
    expect(result.components.tool_overlap).toBeGreaterThan(0);
    expect(result.components.seniority_alignment).toBeGreaterThan(0);
    expect(result.components.scope_alignment).toBeGreaterThan(0);
    expect(result.components.recency).toBeGreaterThan(0);
  });

  it("final_score is in [0, 1] for any input within documented contracts", () => {
    // Upper-bound pin: each component is in [0, 1] by contract,
    // weights sum to 1.0, confidence_score is in [0, 1] → the
    // weighted-sum is in [0, 1] and the multiplier preserves
    // that bound.
    const unit = makeUnit({
      skills: ["product strategy"],
      tools: ["jira", "linear", "notion"],
      domains: ["streaming video"],
      seniority_signals: ["staff"],
      scope_signals: ["40M users"],
      confidence_score: 1,
      embedding: [1, 0, 0],
      date_range: { start: "2025-06-01" },
    });
    const req = makeRequirement({
      category: "scope",
      keywords: ["40M users"],
      tools: ["jira", "linear", "notion"],
      domains: ["streaming video"],
      seniority_level: "staff",
      embedding: [1, 0, 0],
    });
    const result = score(unit, req, {
      asOf: new Date("2025-06-01T00:00:00.000Z"),
    });
    expect(result.rule_score).toBeGreaterThanOrEqual(0);
    expect(result.rule_score).toBeLessThanOrEqual(1);
    expect(result.final_score).toBeGreaterThanOrEqual(0);
    expect(result.final_score).toBeLessThanOrEqual(1);
  });

  it("score() does not read the wall clock when asOf is injected (determinism pin)", () => {
    // Two calls with the same asOf must produce byte-identical
    // results. Pins the "no I/O, no clock dep without asOf
    // injection" purity contract.
    const unit = makeUnit({
      skills: ["product strategy"],
      embedding: [1, 0, 0],
      date_range: { start: "2025-01-01", end: "2025-06-01" },
    });
    const req = makeRequirement({
      keywords: ["product strategy"],
      embedding: [1, 0, 0],
    });
    const asOf = new Date("2026-04-24T00:00:00.000Z");
    const a = score(unit, req, { asOf });
    const b = score(unit, req, { asOf });
    expect(a.final_score).toBe(b.final_score);
    expect(a.rule_score).toBe(b.rule_score);
  });
});

// -- hasStructuralEvidence --------------------------------------------------

describe("hasStructuralEvidence (Codex P1 rounds 1 + 3 on #435)", () => {
  const asOf = new Date("2026-08-31T00:00:00Z");

  // A well-formed, recent Unit at the extraction prompt's
  // confidence anchor. Everything below varies the Requirement.
  function recentUnit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
    return makeUnit({
      skills: ["product strategy"],
      tools: ["jira"],
      domains: ["streaming video"],
      seniority_signals: ["led"],
      confidence_score: 0.85,
      date_range: { start: "2021-01-01" },
      ...overrides,
    });
  }

  it("is false when the Requirement constrains nothing evaluable", () => {
    // The credential shape `jd.v1.md` emits for "BS in Computer
    // Science required": no keywords, tools, domains, or
    // seniority level. Every structural axis falls back to its
    // no-constraint default, so `rule_score` collects ~0.425
    // nothing earned.
    const req = makeRequirement({
      category: "credential",
      keywords: [],
      tools: [],
      domains: [],
    });
    expect(score(recentUnit(), req, { asOf }).structural_evidence).toBe(false);
  });

  it("is false when the Requirement names terms the ontology can't canonicalize", () => {
    // Populated arrays are not evidence on their own. If nothing
    // survives canonicalization the engine has nothing to
    // compare, which is the same position as an empty array.
    const req = makeRequirement({
      keywords: ["xyzzy-not-a-real-skill"],
      tools: ["plugh-not-a-real-tool"],
      domains: ["frobnitz-not-a-real-domain"],
    });
    expect(score(recentUnit(), req, { asOf }).structural_evidence).toBe(false);
  });

  it("is FALSE when the Requirement constrains an axis but this Unit scores 0 on it", () => {
    // Codex P1 round 3. The round-1 fix asked only "was this axis
    // evaluable", which is identical for every Unit — so one
    // recognized keyword marked EVERY Unit as evidenced,
    // including Units scoring 0.0 on that exact axis, and the
    // remaining neutral credit carried them over 0.4.
    //
    // "adding one recognized but wholly unmatched term bypasses
    // the new gate while most invented neutral credit remains."
    const req = makeRequirement({ keywords: ["product strategy"] });
    const unmatched = recentUnit({ skills: ["python"] });
    const result = score(unmatched, req, { asOf });
    expect(result.components.skill_overlap).toBe(0);
    // Still clears the gap threshold on neutral credit alone —
    // which is exactly why the flag, not the score, is the gate.
    expect(result.final_score).toBeGreaterThan(0.4);
    expect(result.structural_evidence).toBe(false);
  });

  it("is true when the Unit actually scores on a constrained axis", () => {
    const req = makeRequirement({ keywords: ["product strategy"] });
    const result = score(recentUnit(), req, { asOf });
    expect(result.components.skill_overlap).toBeGreaterThan(0);
    expect(result.structural_evidence).toBe(true);
  });

  it("accepts evidence from any single structural axis", () => {
    const unit = recentUnit();
    expect(
      score(unit, makeRequirement({ keywords: ["product strategy"] }), { asOf })
        .structural_evidence,
    ).toBe(true);
    expect(
      score(unit, makeRequirement({ tools: ["jira"] }), { asOf })
        .structural_evidence,
    ).toBe(true);
    expect(
      score(unit, makeRequirement({ domains: ["streaming video"] }), { asOf })
        .structural_evidence,
    ).toBe(true);
    // "led" maps to `senior`; an exact-level Requirement scores
    // 1.0 on the seniority axis, which is evidence.
    expect(
      score(unit, makeRequirement({ seniority_level: "senior" }), { asOf })
        .structural_evidence,
    ).toBe(true);
  });

  it("does not accept a constrained axis the Unit hard-zeroed", () => {
    // A two-level seniority gap drives `seniorityAlignment` to
    // 0.0. The Requirement constrained the axis, but this Unit
    // failed it — that is the opposite of evidence.
    const unit = recentUnit({ skills: [], tools: [], domains: [] });
    const result = score(
      unit,
      makeRequirement({ seniority_level: "director" }),
      { asOf },
    );
    expect(result.components.seniority_alignment).toBe(0);
    expect(result.structural_evidence).toBe(false);
  });

  it("does not count the neutral on an UNCONSTRAINED axis as evidence", () => {
    // The interaction that makes the predicate subtle: an
    // unconstrained axis scores 0.5, which is `> 0`. It must
    // still not qualify, because `requirementAxes` marks it
    // inapplicable. Both conditions have to be read together.
    const req = makeRequirement({
      category: "credential",
      keywords: [],
      tools: [],
      domains: [],
    });
    const result = score(recentUnit(), req, { asOf });
    expect(result.components.skill_overlap).toBe(0.5);
    expect(result.components.tool_overlap).toBe(0.5);
    expect(result.structural_evidence).toBe(false);
  });

  it("pairs with requirementAxes rather than duplicating its branches", () => {
    // Direct call, so a future refactor that lets the two drift
    // fails here rather than silently in the Gaps view.
    const req = makeRequirement({ keywords: ["product strategy"] });
    const axes = requirementAxes(req);
    expect(axes.skill_overlap).toBe(true);
    expect(axes.tool_overlap).toBe(false);
    const components = score(recentUnit(), req, { asOf }).components;
    expect(hasStructuralEvidence(components, axes)).toBe(true);
    expect(
      hasStructuralEvidence({ ...components, skill_overlap: 0 }, axes),
    ).toBe(false);
  });
});
