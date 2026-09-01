/**
 * Unit tests for the read-only evidence derivation (#441).
 *
 * The decision itself (`hasStructuralEvidence`) is pinned in
 * `score.test.ts`. What is pinned here is everything the
 * derivation adds on top: that it agrees with the matcher, that
 * it distinguishes the three states, and that it never quietly
 * upgrades ignorance into a pass.
 */

import { describe, expect, it } from "vitest";

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";

import {
  deriveEvidenceForMatches,
  deriveStructuralEvidence,
  resolveMatchEvidence,
} from "./evidence.js";
import { score } from "./score.js";

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

/** A legacy row: no `structural_evidence`, no applicability. */
function makeLegacyMatch(overrides: Partial<UnitMatch> = {}): UnitMatch {
  return {
    id: "match-1",
    owner_uid: "u",
    experience_unit_id: "unit-1",
    job_requirement_unit_id: "req-1",
    role_id: "role-1",
    semantic_score: 0.5,
    rule_score: 0.5,
    final_score: 0.5,
    components: {
      semantic_similarity: 0.5,
      skill_overlap: 0.5,
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
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveStructuralEvidence agrees with the matcher", () => {
  // The whole point of delegating to `hasStructuralEvidence`
  // rather than reimplementing the rule. If these ever disagree,
  // a Role's Gaps view says one thing on read and a different
  // thing after an explicit rematch.
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly unit: ExperienceUnit;
    readonly requirement: JobRequirementUnit;
  }> = [
    {
      name: "real skill overlap",
      unit: makeUnit({ skills: ["Product Strategy"] }),
      requirement: makeRequirement({ keywords: ["product strategy"] }),
    },
    {
      name: "constrained skill axis the unit misses entirely",
      unit: makeUnit({ skills: ["Product Strategy"] }),
      requirement: makeRequirement({ keywords: ["machine learning"] }),
    },
    {
      name: "wholly unconstrained requirement",
      unit: makeUnit({ skills: ["Product Strategy"] }),
      requirement: makeRequirement(),
    },
    {
      name: "domain overlap only",
      unit: makeUnit({ domains: ["Fintech"] }),
      requirement: makeRequirement({ domains: ["fintech"] }),
    },
    {
      name: "seniority constrained, unit has no mapped signal",
      unit: makeUnit({ seniority_signals: ["mentored"] }),
      requirement: makeRequirement({ seniority_level: "senior" }),
    },
    {
      name: "seniority constrained, unit mapped",
      unit: makeUnit({ seniority_signals: ["Staff"] }),
      requirement: makeRequirement({ seniority_level: "senior" }),
    },
  ];

  for (const c of cases) {
    it(`matches score()'s own verdict: ${c.name}`, () => {
      const fresh = score(c.unit, c.requirement);
      expect(deriveStructuralEvidence(c.unit, c.requirement)).toBe(
        fresh.structural_evidence,
      );
    });
  }
});

describe("resolveMatchEvidence: stored beats derived", () => {
  it("returns the persisted verdict without looking at the pair", () => {
    // A Unit edited after the match was written must not
    // retroactively change a judgement the matcher already made
    // and recorded.
    const stored = makeLegacyMatch({ structural_evidence: true });
    const result = resolveMatchEvidence(
      stored,
      makeUnit({ skills: [] }),
      makeRequirement({ keywords: ["machine learning"] }),
    );
    expect(result).toEqual({ verdict: "evidenced", stored: true });
  });

  it("honours a stored false the same way", () => {
    const result = resolveMatchEvidence(
      makeLegacyMatch({ structural_evidence: false }),
      makeUnit({ skills: ["Product Strategy"] }),
      makeRequirement({ keywords: ["product strategy"] }),
    );
    expect(result).toEqual({ verdict: "unevidenced", stored: true });
  });

  it("resolves a stored verdict even when the Unit is gone", () => {
    expect(
      resolveMatchEvidence(
        makeLegacyMatch({ structural_evidence: true }),
        undefined,
        makeRequirement(),
      ).verdict,
    ).toBe("evidenced");
  });
});

describe("resolveMatchEvidence: the three states", () => {
  it("derives evidence for a legacy row whose pair really overlaps", () => {
    expect(
      resolveMatchEvidence(
        makeLegacyMatch(),
        makeUnit({ skills: ["Product Strategy"] }),
        makeRequirement({ keywords: ["product strategy"] }),
      ),
    ).toEqual({ verdict: "evidenced", stored: false });
  });

  it("derives NO evidence for a legacy row that only carried neutrals", () => {
    // The case the whole issue is about: a Requirement that
    // constrains nothing evaluable stacks no-constraint defaults
    // into ~0.425 of rule_score, clears the 0.4 gap threshold on
    // semantics alone, and reads as covering a must-have.
    expect(
      resolveMatchEvidence(
        makeLegacyMatch(),
        makeUnit({ skills: ["Product Strategy"] }),
        makeRequirement({ raw_text: "BS in Computer Science required" }),
      ),
    ).toEqual({ verdict: "unevidenced", stored: false });
  });

  it("reports a missing Unit as unverifiable, not as either answer", () => {
    expect(
      resolveMatchEvidence(makeLegacyMatch(), undefined, makeRequirement()),
    ).toEqual({
      verdict: "unverifiable",
      reason: "unit_missing",
      stored: false,
    });
  });

  it("reports an orphaned Requirement as unverifiable", () => {
    // #442's failure mode observed from this side: a JD re-parse
    // replaces Requirement ids, stranding every match that
    // pointed at the old ones.
    expect(
      resolveMatchEvidence(makeLegacyMatch(), makeUnit(), undefined),
    ).toEqual({
      verdict: "unverifiable",
      reason: "requirement_missing",
      stored: false,
    });
  });

  it("reports a reembed_pending Unit as unverifiable even though the math would work", () => {
    // Not an embeddings problem — the structural axes never read
    // the vector. The pipeline's `defaultListUnits` excludes
    // these Units, so the next re-match will not produce this
    // pair at all, and claiming "evidenced" would let a
    // must-have read as covered by a match the pipeline itself
    // currently declines to score.
    expect(
      resolveMatchEvidence(
        makeLegacyMatch(),
        makeUnit({
          skills: ["Product Strategy"],
          reembed_pending: true,
        }),
        makeRequirement({ keywords: ["product strategy"] }),
      ),
    ).toEqual({
      verdict: "unverifiable",
      reason: "unit_reembed_pending",
      stored: false,
    });
  });

  it("reports a Unit with no usable embedding as unverifiable", () => {
    // Codex P2 on PR #446. The structural axes never read a
    // vector, so the derivation COULD answer here — but
    // `runMatchingPipeline` skips the pair outright, so an answer
    // would outlive the match it describes. The rule is "would
    // the pipeline produce this pair", not "can we compute it".
    for (const embedding of [undefined, []]) {
      expect(
        resolveMatchEvidence(
          makeLegacyMatch(),
          makeUnit({ skills: ["Product Strategy"], embedding }),
          makeRequirement({ keywords: ["product strategy"] }),
        ),
      ).toEqual({
        verdict: "unverifiable",
        reason: "unit_embedding_missing",
        stored: false,
      });
    }
  });

  it("reports a Requirement with no usable embedding as unverifiable", () => {
    for (const embedding of [undefined, []]) {
      expect(
        resolveMatchEvidence(
          makeLegacyMatch(),
          makeUnit({ skills: ["Product Strategy"] }),
          makeRequirement({ keywords: ["product strategy"], embedding }),
        ).reason,
      ).toBe("requirement_embedding_missing");
    }
  });

  it("reports an unapproved Unit as unverifiable for the same reason", () => {
    expect(
      resolveMatchEvidence(
        makeLegacyMatch(),
        makeUnit({ skills: ["Product Strategy"], user_approved: false }),
        makeRequirement({ keywords: ["product strategy"] }),
      ).reason,
    ).toBe("unit_unapproved");
  });
});

describe("deriveStructuralEvidence uses today's ontology, not the stored components", () => {
  it("finds evidence a legacy row's own components deny", () => {
    // A row written before #435's ontology expansion stored
    // skill_overlap 0 for a term the vocabulary did not yet
    // recognize. Deriving from the stored number would answer
    // "what did we think then"; deriving from the pair answers
    // the question the Gaps view actually asks, and agrees with
    // what an explicit rematch would produce today.
    const unit = makeUnit({ skills: ["Agentic AI"] });
    const requirement = makeRequirement({ keywords: ["agentic ai"] });
    const legacy = makeLegacyMatch({
      components: {
        semantic_similarity: 0.5,
        skill_overlap: 0,
        domain_overlap: 0.5,
        tool_overlap: 0.5,
        seniority_alignment: 1,
        scope_alignment: 1,
        recency: 1,
      },
    });
    expect(resolveMatchEvidence(legacy, unit, requirement).verdict).toBe(
      "evidenced",
    );
    expect(score(unit, requirement).structural_evidence).toBe(true);
  });
});

describe("deriveEvidenceForMatches", () => {
  it("keys by match id and resolves each pair independently", () => {
    const units = [
      makeUnit({ id: "unit-1", skills: ["Product Strategy"] }),
      makeUnit({ id: "unit-2", skills: ["Woodworking"] }),
    ];
    const requirements = [
      makeRequirement({ id: "req-1", keywords: ["product strategy"] }),
    ];
    const matches = [
      makeLegacyMatch({ id: "m-1", experience_unit_id: "unit-1" }),
      makeLegacyMatch({ id: "m-2", experience_unit_id: "unit-2" }),
      makeLegacyMatch({ id: "m-3", experience_unit_id: "unit-gone" }),
    ];
    const out = deriveEvidenceForMatches({ matches, units, requirements });
    expect(out.get("m-1")?.verdict).toBe("evidenced");
    expect(out.get("m-2")?.verdict).toBe("unevidenced");
    expect(out.get("m-3")?.verdict).toBe("unverifiable");
    expect(out.size).toBe(3);
  });

  it("returns an entry for every match, including already-stored ones", () => {
    // The callable returns the full map rather than only the
    // legacy subset, so the client has one source for the
    // question instead of merging two.
    const out = deriveEvidenceForMatches({
      matches: [makeLegacyMatch({ id: "m-1", structural_evidence: true })],
      units: [makeUnit()],
      requirements: [makeRequirement()],
    });
    expect(out.get("m-1")).toEqual({ verdict: "evidenced", stored: true });
  });
});
