/**
 * End-to-end deterministic regression for the failure reported in
 * #430: the Coursera + Udemy Staff PM Role rendered EVERY must-have
 * Requirement as an unmet gap, contradicting the hand-written fit
 * brief that scores the role three-for-three on basic qualifications.
 *
 * Codex P1 round 2 on PR #435 asked for exactly this: the JD fixture
 * added by that PR was read by nothing, so the all-gaps failure could
 * return while the focused unit tests stayed green.
 *
 * What this exercises, with no network and no LLM call:
 *
 *   tests/fixtures/jds/coursera-staff-pm-2026.txt   (the real JD text)
 *     → Requirements phrased as `prompts/parsing/jd.v1.md` instructs
 *     → real `score()` over the real seed ontology
 *     → real `computeGaps()` at the production GAP_THRESHOLD
 *
 * Two things are held constant so the assertions isolate the rule
 * side, which is what #435 changed:
 *
 *   - `semantic_similarity` is pinned by construction. Unit vectors
 *     are `[1, 0]` and Requirement vectors `[cos θ, sin θ]`, so the
 *     cosine IS `cos θ` — no embedding call, no drift.
 *   - `confidence_score` is pinned at 0.85, the extraction prompt's
 *     anchor for a clear first-person claim without numerics.
 *
 * The Units are the 22 labeled fixtures in
 * `expected-units/nathan-2026.json` — real extraction output, not
 * invented — given the runtime fields `score()` needs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  hasMappedSenioritySignal,
  requirementAxes,
  score,
} from "../functions/src/matching/score.js";
import {
  computeGaps,
  GAP_THRESHOLD,
} from "../src/routes/RoleDetail/computeGaps.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../functions/src/types/capability.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const JD_PATH = join(HERE, "fixtures/jds/coursera-staff-pm-2026.txt");
const UNITS_PATH = join(HERE, "fixtures/expected-units/nathan-2026.json");

const JD_TEXT = readFileSync(JD_PATH, "utf-8");
const SEMANTIC = 0.45;
const CONFIDENCE = 0.85;
const AS_OF = new Date("2026-08-31T00:00:00Z");

/**
 * Requirements as the JD parser is instructed to emit them:
 * `raw_text` a near-verbatim span, `keywords` / `domains` preserving
 * the employer's phrasing.
 *
 * `anchor` is a literal substring of the JD fixture. Every entry is
 * asserted to appear in the file below, so this table cannot drift
 * away from the fixture it claims to represent — editing the JD out
 * from under these Requirements fails the suite rather than silently
 * testing fiction.
 */
interface Spec {
  readonly id: string;
  readonly anchor: string;
  readonly keywords: readonly string[];
  readonly domains: readonly string[];
  readonly mustHave: boolean;
}

const SPECS: readonly Spec[] = [
  {
    id: "r-ai-driven",
    anchor: "workflow automation, conversational AI, decision support, or agentic AI",
    keywords: ["AI-driven products", "workflow automation", "conversational AI", "decision support", "agentic AI"],
    domains: ["edtech"],
    mustHave: true,
  },
  {
    id: "r-zero-to-launch",
    anchor: "taken a product from zero to launch where the path wasn't clear",
    keywords: ["zero to launch", "product ideation to launch", "0 to 1"],
    domains: [],
    mustHave: true,
  },
  {
    id: "r-creation-experience",
    anchor: "Own the end-to-end content creation experience for Udemy & Coursera",
    keywords: ["content creation experience", "authoring tools", "creator tools"],
    domains: ["creator tools", "edtech"],
    mustHave: true,
  },
  {
    id: "r-creator-psychology",
    anchor: "You understand creator psychology",
    keywords: ["creator psychology", "creation tools", "instructional design"],
    domains: ["creator tools"],
    mustHave: false,
  },
  {
    id: "r-design-partner",
    anchor: "Strong aesthetic sensibility and deep respect for craft in UX",
    keywords: ["aesthetic sensibility", "craft in UX", "design partnership"],
    domains: [],
    mustHave: false,
  },
  {
    id: "r-commercial",
    anchor: "Commercially literate.",
    keywords: ["commercial literacy", "monetization", "revenue awareness"],
    domains: [],
    mustHave: false,
  },
  {
    id: "r-roadmap",
    anchor: "own the roadmap for a high-priority area of the Coursera platform",
    keywords: ["product strategy", "roadmap ownership", "product vision"],
    domains: [],
    mustHave: true,
  },
  {
    id: "r-data-informed",
    anchor: "Leverage data and customer feedback to inform decisions",
    keywords: ["customer insights", "data-informed decision making", "analytics"],
    domains: [],
    mustHave: true,
  },
];

function requirementFor(spec: Spec): JobRequirementUnit {
  return {
    id: spec.id,
    owner_uid: "u",
    role_id: "role-coursera-staff-pm",
    raw_text: spec.anchor,
    normalized_requirement: spec.anchor,
    category: "skill",
    keywords: [...spec.keywords],
    tools: [],
    domains: [...spec.domains],
    priority: "high",
    must_have: spec.mustHave,
    extracted_from: "qualifications",
    // cos(θ) with the Unit's [1, 0] IS the semantic score.
    embedding: [SEMANTIC, Math.sqrt(1 - SEMANTIC * SEMANTIC)],
  };
}

interface LabeledUnit {
  readonly id: string;
  readonly normalized_summary: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly domains: readonly string[];
}

function loadUnits(): ExperienceUnit[] {
  const raw = JSON.parse(readFileSync(UNITS_PATH, "utf-8")) as {
    expected_units: readonly LabeledUnit[];
  };
  return raw.expected_units.map((u) => ({
    id: u.id,
    owner_uid: "u",
    source_type: "resume",
    source_ref: "nathan-2026",
    raw_text: u.normalized_summary,
    normalized_summary: u.normalized_summary,
    unit_type: "project",
    skills: [...u.skills],
    tools: [...u.tools],
    domains: [...u.domains],
    // Every Unit gets identical seniority / scope / recency
    // treatment so the assertions isolate skill / domain / tool.
    seniority_signals: ["led"],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: CONFIDENCE,
    user_approved: true,
    date_range: { start: "2021-01-01" },
    embedding: [1, 0],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  })) as ExperienceUnit[];
}

function matchesFor(
  units: readonly ExperienceUnit[],
  requirements: readonly JobRequirementUnit[],
): UnitMatch[] {
  const out: UnitMatch[] = [];
  for (const unit of units) {
    for (const requirement of requirements) {
      const r = score(unit, requirement, { asOf: AS_OF });
      out.push({
        id: `${unit.id}::${requirement.id}`,
        owner_uid: "u",
        experience_unit_id: unit.id,
        job_requirement_unit_id: requirement.id,
        role_id: "role-coursera-staff-pm",
        semantic_score: r.semantic_score,
        rule_score: r.rule_score,
        final_score: r.final_score,
        components: { ...r.components },
        structural_evidence: r.structural_evidence,
        rationale: "",
        surface_evidence: "",
        approved_for_use: false,
        user_rejected: false,
        created_at: "2026-01-01T00:00:00.000Z",
      });
    }
  }
  return out;
}

describe("Coursera Staff PM × nathan-2026 (regression for #430)", () => {
  const requirements = SPECS.map(requirementFor);
  const units = loadUnits();
  const matches = matchesFor(units, requirements);
  const { gaps } = computeGaps(requirements, matches);
  const gapIds = new Set(gaps.map((g) => g.requirement.id));
  const mustHaves = SPECS.filter((s) => s.mustHave);

  it("every Requirement is anchored in the committed JD fixture", () => {
    // Guards the table above against drifting from the fixture.
    for (const spec of SPECS) {
      expect(
        JD_TEXT.includes(spec.anchor),
        `${spec.id}: anchor not found in ${JD_PATH}`,
      ).toBe(true);
    }
  });

  it("does NOT cap every must-have below the threshold — the #430 failure", () => {
    // The reported bug was structural. Before #435, an
    // unrecognized Requirement side hard-zeroed skill + domain +
    // tool (0.45 of the weight), capping final_score below
    // GAP_THRESHOLD for EVERY pair whatever the Unit brought.
    //
    // Since #601 the weights are renormalized over the applicable
    // axes, so no axis the Requirement leaves unconstrained can
    // cap the score: a Unit matching every constrained axis
    // reaches the confidence ceiling. This asserted
    // `gapIds.size < mustHaves.length` before #601; that held only
    // because unconstrained axes paid neutral credit (see the
    // calibration pin below), so it is restated as the structural
    // property #430 was actually about.
    for (const spec of mustHaves) {
      const req = requirements.find((r) => r.id === spec.id)!;
      const perfect = score(
        {
          ...units[0]!,
          skills: [...req.keywords],
          domains: [...req.domains],
          embedding: [1, 0],
        },
        { ...req, embedding: [1, 0] },
        { asOf: AS_OF },
      );
      expect(perfect.rule_score, spec.id).toBeCloseTo(1, 9);
      expect(perfect.final_score, spec.id).toBeGreaterThanOrEqual(
        GAP_THRESHOLD,
      );
    }
  });

  it("grounds zero-to-launch, which the corpus genuinely evidences", () => {
    // Four Units carry `0-to-1 product` / `0-to-1 product launch`,
    // and the JD's "zero to launch" canonicalizes onto the same
    // entry — real shared vocabulary, not neutral credit. The
    // evidenced Units must outrank every unevidenced one on this
    // Requirement. If they don't, the engine has drifted back
    // toward #430.
    const forReq = matches
      .filter((m) => m.job_requirement_unit_id === "r-zero-to-launch")
      .sort((a, b) => b.final_score - a.final_score);
    const evidenced = forReq.filter((m) => m.structural_evidence === true);
    expect(evidenced.length).toBeGreaterThanOrEqual(4);
    const lowestEvidenced = Math.min(...evidenced.map((m) => m.final_score));
    const highestUnevidenced = Math.max(
      ...forReq
        .filter((m) => m.structural_evidence !== true)
        .map((m) => m.final_score),
    );
    expect(lowestEvidenced).toBeGreaterThan(highestUnevidenced);
  });

  it("calibration pin (#601): at the 0.4 threshold, zero-to-launch's evidence no longer clears", () => {
    // Honest pin of a known shift, owned by #39 / #177 (score
    // calibration), not by matching. Before #601 the best
    // evidenced pair scored 0.85 × 0.55 ≈ 0.47: semantic 0.45,
    // skill 1/3, recency 1, PLUS 0.325 of neutral credit from the
    // unconstrained domain, tool, seniority and scope axes. With
    // that credit removed it scores 0.85 × (0.30·0.45 + 0.20·⅓ +
    // 0.05·1) / 0.55 ≈ 0.389, just under GAP_THRESHOLD, so every
    // must-have on this fixture now reads as a gap.
    //
    // The fix is to recalibrate the threshold on the renormalized
    // scale, not to re-inflate the score. If this starts failing
    // because the threshold moved, update it with the new
    // calibration; if it fails because the score rose without new
    // evidence in the corpus, the score is being inflated again.
    const best = Math.max(
      ...matches
        .filter((m) => m.job_requirement_unit_id === "r-zero-to-launch")
        .map((m) => m.final_score),
    );
    expect(best).toBeCloseTo(
      CONFIDENCE * (0.3 * SEMANTIC + 0.2 / 3 + 0.05) / 0.55,
      9,
    );
    expect(best).toBeLessThan(GAP_THRESHOLD);
    expect(gapIds.has("r-zero-to-launch")).toBe(true);
  });

  it("reports the PM-craft Requirements as gaps — an extraction finding, not a matching one", () => {
    // Uncomfortable but honest, and worth pinning so nobody
    // "fixes" it at the wrong layer.
    //
    // The fit brief scores roadmap ownership and data-informed
    // decision making as clear passes on 20+ years of shipped
    // product work, and it is right. The engine can't see it
    // because of what the labeled corpus SAYS: across 22 Units
    // and 68 distinct skills, not one is `product strategy`,
    // `product roadmap`, `user research`, or `analytics`. The
    // extraction prompt describes the work in delivery and
    // broadcast-engineering vocabulary — `release engineering`,
    // `platform launch`, `cross-team leadership`.
    //
    // So the skill axis finds nothing to compare on any PM-craft
    // Requirement, for any PM role, not just this one. That is
    // #38 (extraction prompt tuning), and the fix is richer Units
    // — NOT loosening this gate, and NOT declaring delivery terms
    // synonyms of product-craft terms in the ontology.
    expect(gapIds.has("r-roadmap")).toBe(true);
    expect(gapIds.has("r-data-informed")).toBe(true);
  });

  it("still reports the creator-tools Requirement as a gap — the honest one", () => {
    // The fit brief independently calls creator-tools-at-scale the
    // real gap: the creator-facing evidence in the corpus is
    // developer-facing (SDK) or hobby-scale. The fix must not paper
    // over it. A change that makes this pass without new Units in
    // the corpus is inflating scores, not improving matching.
    expect(gapIds.has("r-creation-experience")).toBe(true);
  });

  it("discriminates on evidence rather than marking every pair evidenced", () => {
    // Codex P1 round 3. Evidence is a property of the PAIR, not
    // of the Requirement: a Requirement naming one recognized
    // keyword must not mark every Unit evidenced, including
    // Units that score 0.0 on that exact axis.
    const evidenced = matches.filter((m) => m.structural_evidence === true);
    expect(evidenced.length).toBeGreaterThan(0);
    expect(evidenced.length).toBeLessThan(matches.length);

    // And the discrimination is the right one: every evidenced
    // pair scored above zero on some axis its Requirement
    // actually CONSTRAINS.
    //
    // The applicability filter is load-bearing, not decoration.
    // An unconstrained axis carries the 0.5 neutral, which is
    // `> 0` — so checking the raw components alone would accept
    // neutral credit as proof and the assertion would pass even
    // if `structural_evidence` were computed wrongly. Deriving
    // the applicable axes through `requirementAxes()` — the
    // authoritative predicate — is what makes this able to catch
    // a false positive. CodeRabbit on #435.
    const reqById = new Map(requirements.map((r) => [r.id, r]));
    for (const m of evidenced) {
      const c = m.components!;
      const req = reqById.get(m.job_requirement_unit_id)!;
      const axes = requirementAxes(req);
      const unit = units.find((u) => u.id === m.experience_unit_id)!;
      const scoredOnConstrainedAxis =
        (axes.skill_overlap && c.skill_overlap > 0) ||
        (axes.domain_overlap && c.domain_overlap > 0) ||
        (axes.tool_overlap && c.tool_overlap > 0) ||
        // Mirrors the mapped-seniority rule: the 0.5 a Unit gets
        // for unmapped signals is not a measurement.
        (axes.seniority_alignment &&
          c.seniority_alignment > 0 &&
          hasMappedSenioritySignal(unit)) ||
        (axes.scope_alignment && c.scope_alignment > 0);
      expect(scoredOnConstrainedAxis).toBe(true);
    }
  });

  it("does not let neutral credit alone clear a must-have", () => {
    // The arithmetic Codex flagged: on a Requirement whose axes
    // this Unit scores nothing on, the unconstrained-axis
    // fallbacks still push final_score over 0.4. The gate, not
    // the score, is what stops it covering the must-have.
    // The claim is per-Requirement, not per-match: a must-have
    // whose only threshold-clearing matches lack evidence must
    // still be a gap. (A Requirement can hold BOTH kinds of
    // match — zero-to-launch does — and is legitimately covered
    // by the evidenced ones.)
    //
    // Since #601 the score itself no longer pays that credit: on
    // this fixture no unevidenced must-have match reaches the
    // threshold at all, which is the stronger form of the same
    // claim. The gate is still pinned on a synthetic pair in
    // functions/src/matching/score.test.ts, where semantics alone
    // clear 0.4. Before #601 this test asserted that at least one
    // Requirement exercised the gate here; that path no longer
    // exists on this fixture, so the vacuity guard below now
    // asserts its absence instead.
    let gatedSomething = false;
    for (const spec of mustHaves) {
      const forReq = matches.filter(
        (m) => m.job_requirement_unit_id === spec.id,
      );
      const clearing = forReq.filter((m) => m.final_score >= 0.4);
      const evidencedClearing = clearing.filter(
        (m) => m.structural_evidence === true,
      );
      if (clearing.length > 0 && evidencedClearing.length === 0) {
        // Neutral credit alone got these over 0.4. The gate is
        // the only thing stopping the must-have from reading as
        // covered.
        gatedSomething = true;
        expect(gapIds.has(spec.id)).toBe(true);
      }
    }
    // Neutral credit can no longer lift an unevidenced match over
    // the threshold on this fixture. Not vacuous: the loop above
    // ran over every must-have, and the assertion below fails if
    // any unevidenced match clears.
    expect(gatedSomething).toBe(false);
    const unevidencedClearing = matches.filter(
      (m) =>
        mustHaves.some((s) => s.id === m.job_requirement_unit_id) &&
        m.structural_evidence !== true &&
        m.final_score >= GAP_THRESHOLD,
    );
    expect(unevidencedClearing).toEqual([]);
  });

  it("puts both sides in a shared canonical space — real skill overlap, not neutral credit", () => {
    // The root cause in #430 was requirement-side canonicalization
    // at 13%: the JD's vocabulary normalized to nothing, so
    // skill_overlap could only ever be the empty-set fallback.
    // Without this assertion the suite above would still pass on
    // neutral credit alone, which is the exact failure mode the
    // directional rule introduces if the ontology work regresses.
    //
    // Deliberately corpus-wide rather than per-Requirement. Some
    // Requirements legitimately find no lexical overlap — see the
    // AI-vocabulary note below — and pinning one would encourage
    // inventing a synonym bridge to keep a test green.
    const realOverlap = matches.filter(
      (m) => (m.components?.skill_overlap ?? 0) > 0,
    );
    expect(realOverlap.length).toBeGreaterThan(0);
  });

  it("does not pretend the AI requirement has lexical overlap it lacks", () => {
    // Honest negative pin. The fit brief calls AI the strongest
    // pass, and substantively it is — Mergepath is agentic
    // infrastructure. But the labeled corpus phrases that work as
    // "AI agent governance" and "AI tooling adoption", which
    // canonicalize to `agent governance` and `ai tooling adoption`,
    // while the JD asks for `agentic ai` / `workflow automation`.
    // Those are genuinely different canonicals, so this
    // Requirement rests on the 0.30 semantic axis, not on skill
    // overlap.
    //
    // This is pinned so nobody closes the gap by declaring the
    // terms synonyms. Bridging them would be fabrication at the
    // vocabulary layer — the right fixes are richer Units or the
    // scoring recalibration in #39 / #177.
    const aiSkillScores = matches
      .filter((m) => m.job_requirement_unit_id === "r-ai-driven")
      .map((m) => m.components?.skill_overlap ?? -1);
    expect(aiSkillScores.every((s) => s === 0)).toBe(true);
  });
});
