import { describe, expect, it } from "vitest";

import { score, WEIGHTS } from "../../../functions/src/matching/score.ts";
import type { ExperienceUnit, JobRequirementUnit } from "../../../functions/src/types/capability.ts";

import { cosineScore, renormalizedRule, renormalizedScore, SCORERS } from "./scorers.ts";
import { textVector } from "./testSupport.ts";

const asOf = new Date("2026-10-28T00:00:00.000Z");

function unit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: "u1",
    owner_uid: "eval-user",
    source_type: "resume",
    source_ref: "resume:x:0",
    raw_text: "Led the platform launch",
    normalized_summary: "Led the platform launch across teams",
    unit_type: "project",
    skills: ["platform launch", "release engineering"],
    tools: ["Linux"],
    domains: ["streaming"],
    seniority_signals: ["led"],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 0.8,
    user_approved: true,
    created_at: "",
    updated_at: "",
    embedding: textVector("Led the platform launch across teams"),
    ...overrides,
  };
}

function requirement(overrides: Partial<JobRequirementUnit> = {}): JobRequirementUnit {
  return {
    id: "r1",
    owner_uid: "eval-user",
    role_id: "eval-role",
    raw_text: "Experience launching platforms",
    normalized_requirement: "Experience launching platforms on Linux",
    category: "skill",
    keywords: ["platform launch"],
    tools: ["Linux"],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
    embedding: textVector("Experience launching platforms on Linux"),
    ...overrides,
  };
}

describe("SCORERS", () => {
  it("current is the production score()", () => {
    expect(SCORERS.current).toBe(score);
    expect(SCORERS.renormalized).toBe(renormalizedScore);
    expect(SCORERS.cosine).toBe(cosineScore);
  });

  it("renormalized: the PRD weights over the applicable axes only", () => {
    const u = unit();
    const q = requirement();
    const base = score(u, q, { asOf });
    const r = renormalizedScore(u, q, { asOf });
    let num = 0;
    let den = 0;
    for (const [axis, w] of Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][]) {
      if (base.component_applicability[axis]) {
        num += w * base.components[axis];
        den += w;
      }
    }
    expect(den).toBeGreaterThan(0);
    expect(den).toBeLessThan(1); // some axis is inapplicable, so it is a real renormalization
    expect(r.rule_score).toBeCloseTo(num / den, 12);
    expect(r.final_score).toBeCloseTo(0.8 * (num / den), 12);
    // Components and applicability pass through unchanged, so the rationale still sees them.
    expect(r.components).toEqual(base.components);
    expect(r.component_applicability).toEqual(base.component_applicability);
    expect(r.structural_evidence).toBe(base.structural_evidence);
  });

  it("renormalized: 0 when no axis applies, and only applicable weights count", () => {
    const base = score(unit(), requirement(), { asOf });
    const off = Object.fromEntries(Object.keys(base.component_applicability).map((k) => [k, false])) as typeof base.component_applicability;
    expect(renormalizedRule(base.components, off)).toBe(0);
    const onlySemantic = { ...off, semantic_similarity: true };
    expect(renormalizedRule(base.components, onlySemantic)).toBeCloseTo(base.components.semantic_similarity, 12);
  });

  it("cosine: confidence × semantic similarity", () => {
    const u = unit();
    const q = requirement();
    const base = score(u, q, { asOf });
    const c = cosineScore(u, q, { asOf });
    expect(c.rule_score).toBe(base.components.semantic_similarity);
    expect(c.final_score).toBeCloseTo(0.8 * base.components.semantic_similarity, 12);
    expect(c.components).toEqual(base.components);
  });
});
