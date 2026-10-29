/**
 * View-layer tests for `MatchCard`. Pure
 * `renderToStaticMarkup` shape checks — no Firebase, no
 * router. Mirrors the RoleDetailView test pattern.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit, UnitMatch } from "../../types/capability.ts";

import MatchCard from "./MatchCard.tsx";

const ALICE = "user-alice";

function makeUnit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: "unit-1",
    owner_uid: ALICE,
    source_type: "resume",
    source_ref: "ref",
    raw_text: "raw",
    normalized_summary: "Led the living-room launch programme",
    unit_type: "project",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 0.85,
    user_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMatch(overrides: Partial<UnitMatch> = {}): UnitMatch {
  return {
    id: "match-1",
    owner_uid: ALICE,
    experience_unit_id: "unit-1",
    job_requirement_unit_id: "req-1",
    role_id: "role-1",
    semantic_score: 0.5,
    rule_score: 0.5,
    final_score: 0.5,
    components: {
      semantic_similarity: 0.45,
      skill_overlap: 0.6,
      domain_overlap: 0.5,
      tool_overlap: 0.5,
      seniority_alignment: 1,
      scope_alignment: 1,
      recency: 1,
    },
    rationale: "Matched on skill overlap.",
    surface_evidence: "product strategy",
    approved_for_use: false,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MatchCard: applicability reaches the score badge", () => {
  // Regression for a wiring gap: `MatchCard` rendered
  // `MatchScoreBadge` without passing `component_applicability`,
  // so the badge always received `undefined`. With
  // `buildBreakdownRows` defaulting an absent map to
  // UNEVALUATED — deliberately, so legacy neutrals are never
  // shown as measurements — that labelled all seven components
  // "not evaluated" on every freshly scored match. The
  // conservative default and the missing prop were individually
  // correct and jointly useless.
  it("renders measured axes as numbers when applicability says they were evaluated", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          component_applicability: {
            semantic_similarity: true,
            skill_overlap: true,
            domain_overlap: true,
            tool_overlap: true,
            seniority_alignment: true,
            scope_alignment: true,
            recency: true,
          },
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).not.toContain("not evaluated");
    expect(html).toContain("0.60");
  });

  it("renders an unevaluated axis as 'not evaluated', not as a score", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          component_applicability: {
            semantic_similarity: true,
            skill_overlap: false,
            domain_overlap: false,
            tool_overlap: false,
            seniority_alignment: false,
            scope_alignment: false,
            recency: true,
          },
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    // The five unconstrained axes, and no others.
    expect(html.match(/not evaluated/g)?.length).toBe(5);
  });

  it("shows nothing per-axis for a legacy match with no applicability", () => {
    // Conservative by design: pre-existing rows store the same
    // neutrals without marking them, so we cannot say which of
    // their components were measured.
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch()}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html.match(/not evaluated/g)?.length).toBe(7);
  });
});

describe("MatchCard: the breakdown must reconcile with the badge (Codex P2 on #435)", () => {
  it("discloses what unevaluated axes contribute, so the footer equation holds", () => {
    // `score()` includes an unevaluated axis's neutral in
    // `rule_score`. Hiding those rows outright left the footer
    // asserting "Final score = Σ(score × weight) × confidence"
    // while the visible rows summed to something else entirely —
    // a breakdown that explains a different number than the one
    // above it.
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          component_applicability: {
            semantic_similarity: true,
            skill_overlap: false,
            domain_overlap: false,
            tool_overlap: false,
            seniority_alignment: false,
            scope_alignment: false,
            recency: true,
          },
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).toContain("Unevaluated axes still contribute");
    // 0.6*0.2 + 0.5*0.15 + 0.5*0.1 + 1*0.1 + 1*0.1 = 0.445
    expect(html).toContain("0.445");
  });

  it("omits the disclosure when every axis was measured", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          component_applicability: {
            semantic_similarity: true,
            skill_overlap: true,
            domain_overlap: true,
            tool_overlap: true,
            seniority_alignment: true,
            scope_alignment: true,
            recency: true,
          },
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).not.toContain("Unevaluated axes still contribute");
  });
});


describe("MatchCard: legacy rationale is not presented as a claim (#440)", () => {
  // Found by nathanpayne-codex during Phase 4b on #435, after
  // approval — the seventh instance of the neutral-as-measurement
  // pattern, and the first one that is PERSISTED.
  //
  // Rows written before #435's rationale axis-gating were
  // generated by a `pickDrivingComponent` with no applicability
  // filter, so a 0.5 no-constraint neutral could win the
  // tie-break and emit "Matched on skill axis" with the Unit's
  // own skills as evidence. The breakdown learned the truth in
  // #435; the prose beside it did not, so the card contradicted
  // itself — "not evaluated" in the tooltip, "matched on skill
  // overlap" in the Why line.
  it("hides Why and Evidence on a legacy match, and says why", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          rationale: "Matched on skill overlap: shared product strategy.",
          surface_evidence: "product strategy",
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).not.toContain("Matched on skill overlap");
    expect(html).not.toContain("Evidence:");
    expect(html).toContain("Explanation unavailable");
    // Must not advise a rematch: that clear-and-replaces the
    // Role's matches, and rows for `reembed_pending` Units are
    // dropped with their approval flags. Suggesting it to fix a
    // display gap would advise the worst available action.
    expect(html).not.toMatch(/re-?run matching/i);
  });

  it("renders both normally on a versioned row with NO applicability (#444)", () => {
    // The row shape the pipeline writes today, minus the field
    // the old inference depended on. If provenance were still
    // read off `component_applicability`, this hides the prose.
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          rationale: "Matched on skill overlap: shared product strategy.",
          surface_evidence: "product strategy",
          schema_version: 1,
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).toContain("Matched on skill overlap");
    expect(html).toContain("Evidence:");
    expect(html).not.toContain("Explanation unavailable");
  });

  it("renders both normally once the match carries applicability", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          rationale: "Matched on skill overlap: shared product strategy.",
          surface_evidence: "product strategy",
          component_applicability: {
            semantic_similarity: true,
            skill_overlap: true,
            domain_overlap: true,
            tool_overlap: true,
            seniority_alignment: true,
            scope_alignment: true,
            recency: true,
          },
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).toContain("Matched on skill overlap");
    expect(html).toContain("Evidence:");
    expect(html).not.toContain("Explanation unavailable");
  });

  it("trusts the rationale even when some axes were unevaluated", () => {
    // Presence of the map is the signal, not its contents: a
    // match scored under the gated rule already had its
    // rationale restricted to applicable axes, so an unevaluated
    // axis in the breakdown does not make the prose suspect.
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          rationale: "Matched on semantic similarity: x ↔ y.",
          surface_evidence: "x",
          component_applicability: {
            semantic_similarity: true,
            skill_overlap: false,
            domain_overlap: false,
            tool_overlap: false,
            seniority_alignment: false,
            scope_alignment: false,
            recency: true,
          },
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).toContain("Matched on semantic similarity");
    expect(html).not.toContain("Explanation unavailable");
  });
});

describe("MatchCard: renormalized rows explain their own number (#601)", () => {
  type Axes = NonNullable<UnitMatch["component_applicability"]>;
  type Weights = NonNullable<UnitMatch["effective_weights"]>;
  const AXES: Axes = {
    semantic_similarity: true,
    skill_overlap: true,
    domain_overlap: false,
    tool_overlap: false,
    seniority_alignment: false,
    scope_alignment: false,
    recency: true,
  };
  const total = 0.3 + 0.2 + 0.05;
  const EW: Weights = {
    semantic_similarity: 0.3 / total,
    skill_overlap: 0.2 / total,
    domain_overlap: 0,
    tool_overlap: 0,
    seniority_alignment: 0,
    scope_alignment: 0,
    recency: 0.05 / total,
  };
  const ZERO: Weights = {
    semantic_similarity: 0,
    skill_overlap: 0,
    domain_overlap: 0,
    tool_overlap: 0,
    seniority_alignment: 0,
    scope_alignment: 0,
    recency: 0,
  };

  it("shows the effective weights and no neutral-placeholder note", () => {
    const rule = 0.45 * EW.semantic_similarity + 0.6 * EW.skill_overlap + EW.recency;
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          component_applicability: AXES,
          effective_weights: EW,
          rule_score: rule,
          final_score: 0.85 * rule,
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    // 0.30 / 0.55 and 0.20 / 0.55, not the fixed 0.30 / 0.20.
    expect(html).toContain("×0.55");
    expect(html).toContain("×0.36");
    expect(html).not.toContain("×0.30");
    expect(html).not.toContain("match-score-unevaluated-contribution");
    expect(html).not.toContain("neutral placeholders");
    expect(html).toContain("match-score-formula-renormalized");
    // Contributions shown: 0.245 + 0.218 + 0.091 = rule_score 0.555.
    expect(html).toContain("0.245");
    expect(html).toContain("0.218");
    expect(html).toContain("0.091");
    expect(rule).toBeCloseTo(0.5545, 3);
  });

  it("an all-zero row says it was not evaluated instead of listing contributions", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({
          component_applicability: {
            ...AXES,
            skill_overlap: false,
          },
          effective_weights: ZERO,
          rule_score: 0,
          final_score: 0,
          rationale: "Not scored: nothing in this requirement could be compared against this Experience Unit.",
          surface_evidence: "",
        })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).toContain("match-score-not-scored");
    expect(html).toContain("no score");
    expect(html).not.toContain('data-testid="match-score-row"');
    expect(html).not.toContain("match-score-unevaluated-contribution");
    expect(html).not.toContain("still contribute");
    expect(html).not.toContain("×0.30");
  });

  it("a legacy row (no effective_weights) renders exactly as before", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({ component_applicability: AXES })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).toContain("×0.30");
    expect(html).toContain("×0.20");
    expect(html).toContain("match-score-unevaluated-contribution");
    expect(html).not.toContain("match-score-formula-renormalized");
    expect(html).not.toContain("match-score-not-scored");
  });
});
