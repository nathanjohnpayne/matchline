/**
 * The seniority-only case of "could not be evaluated" (#602), end to
 * end through the real scorer.
 *
 * A must-have constrained only by seniority (category `experience_level`,
 * a ladder level such as `senior`) names something perfectly
 * checkable. It still cannot be evaluated when every Unit carries
 * only seniority signals the ladder does not map (`mentored`):
 * `effectiveAxes` then drops seniority for every pair, no structural
 * axis applies, each pair scores 0 (#601), and `computeGaps` reports
 * `not_evaluated`. The cause is on the Units' side, which is why the
 * Gaps copy must not say the requirement itself names no level.
 *
 * One Unit with a mapped signal is enough to make it evaluated.
 */

import { describe, expect, it } from "vitest";

import { effectiveAxes, score } from "../functions/src/matching/score.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../functions/src/types/capability.ts";
import { computeGaps } from "../src/routes/RoleDetail/computeGaps.ts";

const AS_OF = new Date("2026-08-31T00:00:00Z");

function unit(id: string, seniority_signals: string[]): ExperienceUnit {
  return {
    id,
    owner_uid: "u",
    source_type: "resume",
    source_ref: "ref",
    raw_text: "raw",
    normalized_summary: `summary ${id}`,
    unit_type: "project",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals,
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 0.85,
    user_approved: true,
    date_range: { start: "2021-01-01" },
    embedding: [1, 0],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const REQ: JobRequirementUnit = {
  id: "r-senior",
  owner_uid: "u",
  role_id: "role-1",
  raw_text: "Senior-level product manager",
  normalized_requirement: "Senior-level product manager",
  category: "experience_level",
  keywords: [],
  tools: [],
  domains: [],
  seniority_level: "senior",
  priority: "high",
  must_have: true,
  extracted_from: "qualifications",
  embedding: [0.9, Math.sqrt(1 - 0.81)],
};

function matchesFor(units: readonly ExperienceUnit[]): UnitMatch[] {
  return units.map((u) => {
    const r = score(u, REQ, { asOf: AS_OF });
    return {
      id: `${u.id}::${REQ.id}`,
      owner_uid: "u",
      experience_unit_id: u.id,
      job_requirement_unit_id: REQ.id,
      role_id: REQ.role_id,
      semantic_score: r.semantic_score,
      rule_score: r.rule_score,
      final_score: r.final_score,
      components: { ...r.components },
      structural_evidence: r.structural_evidence,
      component_applicability: { ...r.component_applicability },
      effective_weights: { ...r.effective_weights },
      rationale: "",
      surface_evidence: "",
      approved_for_use: false,
      user_rejected: false,
      created_at: "2026-01-01T00:00:00.000Z",
    };
  });
}

describe("not_evaluated: seniority-only must-have, unmapped Unit signals (#602)", () => {
  it("is not_evaluated when every Unit's seniority signals are unmapped", () => {
    const units = [unit("u1", ["mentored"]), unit("u2", ["mentored", "coached"])];
    for (const u of units) {
      expect(effectiveAxes(u, REQ).seniority_alignment).toBe(false);
    }
    const matches = matchesFor(units);
    expect(matches.every((m) => m.final_score === 0)).toBe(true);
    const { gaps } = computeGaps([REQ], matches);
    expect(gaps.map((g) => [g.requirement.id, g.status])).toEqual([
      ["r-senior", "not_evaluated"],
    ]);
  });

  it("is evaluated (and reported unmet, not not_evaluated) once one Unit has no signals at all", () => {
    // An empty signal list is a measurement (seniority 0), so the
    // pair is evaluated; the must-have is an ordinary unmet gap.
    const matches = matchesFor([unit("u1", ["mentored"]), unit("u2", [])]);
    const { gaps } = computeGaps([REQ], matches);
    expect(gaps.map((g) => g.status)).toEqual(["unmet"]);
  });

  it("is covered once one Unit carries a mapped signal at the required level", () => {
    const matches = matchesFor([unit("u1", ["mentored"]), unit("u2", ["senior"])]);
    const { gaps } = computeGaps([REQ], matches);
    expect(gaps).toEqual([]);
  });
});
