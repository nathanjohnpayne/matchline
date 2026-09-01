/**
 * Matching engine — scoring composer (sub-issue #97 of #20).
 *
 * Pure functions on (ExperienceUnit, JobRequirementUnit). No
 * Firestore, no callables, no LLM. The persistence pipeline
 * (#99) and the rationale generator (#100) consume this; this
 * module exposes nothing but math.
 *
 * The PRD formula:
 *
 *   final_score = confidence_score × (
 *     0.30 × semantic_similarity +
 *     0.20 × skill_overlap       +
 *     0.15 × domain_overlap      +
 *     0.10 × tool_overlap        +
 *     0.10 × seniority_alignment +
 *     0.10 × scope_alignment     +
 *     0.05 × recency
 *   )
 *
 * The `confidence_score` multiplier is the zero-fabrication
 * boundary at the matching layer: a Unit with `confidence_score
 * = 0` (or any rounding-down to zero) produces `final_score = 0`
 * regardless of overlap, so it cannot enter the matching pipeline
 * even if every component is perfect. The integration test in
 * `tests/rejected-exclusion.integration.test.ts` (#82) pins the
 * complementary user-approval invariant; this module's
 * confidence-gating test pins the analogous invariant for the
 * confidence axis.
 */

import { semanticSimilarity } from "./cosine.js";
import {
  normalizeDomain,
  normalizeKey,
  normalizeSkill,
  normalizeTool,
} from "./normalize.js";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  ScoreComponents,
  SeniorityLevel,
} from "../types/capability.js";

// Re-exported so existing matching-internal callers keep
// working without an import-path change. The canonical
// declaration moved to `../types/capability.ts` because
// ScoreComponents is now persisted on UnitMatch (#131) and
// is therefore part of the shared data contract, not just
// a matching-internal computation type.
export type { ScoreComponents };

// -- Weights ----------------------------------------------------------------

/**
 * The seven scoring weights from the PRD. Frozen so a future
 * caller can't mutate them; sum-checked at module load via the
 * test in score.test.ts (a future weight change without a
 * corresponding delta drift surfaces there).
 */
export const WEIGHTS = Object.freeze({
  semantic_similarity: 0.3,
  skill_overlap: 0.2,
  domain_overlap: 0.15,
  tool_overlap: 0.1,
  seniority_alignment: 0.1,
  scope_alignment: 0.1,
  recency: 0.05,
} as const);

// -- Score component types --------------------------------------------------
// `ScoreComponents` lives in `../types/capability.ts` (shared
// data contract) and is re-exported above. `ScoreResult` stays
// here because it's specifically the matching pipeline's
// internal return shape, not part of the persisted data
// contract.

export interface ScoreResult {
  readonly components: ScoreComponents;
  /**
   * Did ANY axis carry real, evaluable signal from the
   * Requirement side?
   *
   * False means every structural axis fell back to a
   * no-constraint default — `jaccard()`'s 0.5 neutral on
   * skill / tool / domain, `seniorityAlignment`'s 1.0 for an
   * undefined level, `scopeAlignment`'s 1.0 for a non-scope
   * category. Those defaults exist so an unconstrained (or
   * unrecognizable) Requirement doesn't read as a candidate
   * deficiency, but stacked together they hand out 0.225 +
   * 0.20 of `rule_score` that nothing actually earned, and a
   * recent Unit clears the Gaps view's 0.4 threshold on
   * semantics alone.
   *
   * `computeGaps` consumes this so a must-have with no
   * evaluable signal can never be reported as covered. The
   * score itself is left alone: the spec's non-goals say
   * matching "does not hide low-quality matches; they appear
   * in the Gaps view," so the match still renders and still
   * ranks — it just cannot silently satisfy a hard
   * requirement.
   *
   * Codex P1 round 1 on PR #435 caught the false-positive
   * path, using the credential-shaped Requirement that
   * `jd.v1.md` emits with empty `keywords` / `tools` /
   * `domains` as the worked example.
   */
  readonly structural_evidence: boolean;
  /** Weighted sum of components, BEFORE the confidence multiplier. */
  readonly rule_score: number;
  /**
   * Bare semantic similarity, kept on UnitMatch per spec — the
   * Matches tab (#21) shows this independently of the rule-side
   * weighted sum so users can see when a match is driven by
   * semantic prose vs. structural overlap.
   */
  readonly semantic_score: number;
  /**
   * Final score = confidence_score × rule_score. The confidence
   * multiplier is load-bearing for the zero-fabrication invariant
   * (see module docstring + the confidence-gating test in
   * score.test.ts).
   */
  readonly final_score: number;
}

// -- Jaccard primitives -----------------------------------------------------

/**
 * Jaccard similarity between the UNIT side (`unitValues`) and the
 * REQUIREMENT side (`requirementValues`), with each input
 * normalized through the supplied canonicalizer before
 * comparison. Inputs that don't normalize (return `null`) are
 * dropped — they're typically novel terms not yet in the
 * ontology, and including them as raw strings would defeat the
 * canonical-set discipline.
 *
 * **The parameter order is load-bearing**: the empty-set rule
 * below is directional, so every caller must pass the Unit's
 * values first and the Requirement's values second. All four
 * call sites (skill / tool / domain / scope) do.
 *
 * Empty-set rule (#148 → this change):
 *
 *   - **Requirement side empty → 0.5 (neutral).** The
 *     Requirement places no evaluable constraint on this axis
 *     — either the JD genuinely names nothing (very common for
 *     `tools` on a PM req) or the ontology doesn't recognize
 *     what it named. Either way we have no signal, and "no
 *     signal" must not read as "candidate fails this axis."
 *     Same neutral the seniority component uses for "we don't
 *     know," so the semantics stay consistent across the rule
 *     components.
 *   - **Requirement side non-empty, Unit side empty → 0.0.**
 *     The employer asked for something the Unit doesn't attest
 *     to. That IS a signal, and a negative one.
 *   - Otherwise → ordinary Jaccard.
 *
 * Why the rule had to become directional. The prior shape
 * ("either side empty → 0.0, both empty → 0.5") made the score
 * depend on how well the extractor did rather than on how well
 * the candidate fits, in two ways that compounded:
 *
 *   1. **Out-of-domain JDs lost 45% of the weight.** When a
 *      Role's vocabulary sits outside the seed ontology, every
 *      Requirement keyword normalizes to null, so
 *      `skill_overlap + domain_overlap + tool_overlap` (0.20 +
 *      0.15 + 0.10) hard-zeroed for EVERY pair. The remaining
 *      axes cap `rule_score` around 0.55, and after the
 *      `confidence_score` multiplier (~0.85 at the extraction
 *      prompt's anchor) nothing could clear the Gaps view's
 *      0.4 threshold — so a well-matched Role rendered as
 *      "every must-have unmet." Reproduced on the
 *      `coursera-staff-pm-2026` fixture, whose JD-side
 *      vocabulary the seed ontology recognized at 13% / 9% / 0%
 *      (keywords / domains / tools) against 100% on the
 *      unit side.
 *   2. **Better extraction scored worse.** A Unit whose skills
 *      and tools all canonicalize got 0.0 against an
 *      unrecognized Requirement, while a Unit whose vocabulary
 *      was junk (and so normalized to nothing) got the 0.5
 *      both-empty neutral. Cleaning up a Unit lowered its
 *      score.
 *
 * The ontology under-coverage that triggers case 1 is still
 * worth closing on its own (#38, #159 slices) — this rule
 * change stops an ontology gap from being scored as a
 * candidate deficiency in the meantime.
 *
 * **Known residual — a synthetic neutral is not free.** A
 * Requirement whose `keywords`, `tools` AND `domains` all
 * canonicalize to nothing now collects 0.5 on all three axes
 * (0.225 of rule_score) from every Unit, which is enough for a
 * recent Unit to clear the 0.4 gap threshold on semantics
 * alone. That trades the old false negative for a milder false
 * positive. The principled end state is to drop an unsignalled
 * axis and renormalize the remaining weights, so the score
 * stays comparable across Requirements instead of absorbing an
 * invented 0.5 — deferred because `ScoreComponents` is
 * persisted on `UnitMatch` and the breakdown tooltip (#131)
 * renders a fixed weight per row, so per-match effective
 * weights need a data-contract change. Tracked in #433.
 */
function jaccard(
  unitValues: readonly string[],
  requirementValues: readonly string[],
  normalize: (raw: string) => string | null,
): number {
  const unitSet = canonicalize(unitValues, normalize);
  const requirementSet = canonicalize(requirementValues, normalize);
  // Requirement side first: an unconstrained axis is neutral
  // regardless of what the Unit brings to it.
  if (requirementSet.size === 0) return 0.5;
  if (unitSet.size === 0) return 0;
  let intersection = 0;
  for (const v of unitSet) if (requirementSet.has(v)) intersection += 1;
  const union = unitSet.size + requirementSet.size - intersection;
  return intersection / union;
}

/**
 * Does this Requirement constrain ANY structural axis in a way
 * the engine can actually evaluate?
 *
 * An axis counts only when the Requirement side survives
 * canonicalization — a `keywords` array full of terms the seed
 * ontology doesn't recognize constrains nothing we can score,
 * exactly like an empty array. Seniority counts when the level
 * is on the ladder; scope counts when the Requirement is
 * scope-category AND its keywords canonicalize.
 *
 * Deliberately mirrors the branch conditions in `jaccard()`,
 * `seniorityAlignment()` and `scopeAlignment()`. If a future
 * change moves one of those thresholds, this predicate has to
 * move with it — the pairing is pinned in score.test.ts.
 */
export function hasStructuralEvidence(
  requirement: JobRequirementUnit,
): boolean {
  if (canonicalize(requirement.keywords, normalizeSkill).size > 0) return true;
  if (canonicalize(requirement.tools, normalizeTool).size > 0) return true;
  if (canonicalize(requirement.domains, normalizeDomain).size > 0) return true;
  if (
    requirement.seniority_level !== undefined &&
    SENIORITY_LADDER.indexOf(requirement.seniority_level) !== -1
  ) {
    return true;
  }
  if (
    requirement.category === "scope" &&
    canonicalize(requirement.keywords, normalizeScopeKey).size > 0
  ) {
    return true;
  }
  return false;
}

function canonicalize(
  values: readonly string[],
  normalize: (raw: string) => string | null,
): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const canonical = normalize(v);
    if (canonical !== null) out.add(canonical);
  }
  return out;
}

// -- Component scorers ------------------------------------------------------

export function skillOverlap(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
): number {
  return jaccard(unit.skills, requirement.keywords, normalizeSkill);
}

export function toolOverlap(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
): number {
  return jaccard(unit.tools, requirement.tools, normalizeTool);
}

export function domainOverlap(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
): number {
  return jaccard(unit.domains, requirement.domains, normalizeDomain);
}

// -- Seniority alignment ----------------------------------------------------

/**
 * Ladder of seniority levels — used to compute the level-gap
 * penalty. Order matters: index = level. A two-level gap (mid
 * vs. director, indices 1 and 5) produces a steeper penalty
 * than a one-level gap (mid vs. senior, indices 1 and 2).
 */
const SENIORITY_LADDER: readonly SeniorityLevel[] = [
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "director",
];

/**
 * Verb-style seniority signals that the extraction prompt
 * (resume.v1.md) emits in `seniority_signals[]`. Real extracted
 * Units use prose like "led", "owned", "drove" rather than
 * ladder-noun terms like "senior" or "staff", so a strict
 * ladder-only lookup would systematically zero the seniority
 * dimension on every Unit. Codex P1 review on PR #103 caught
 * this against runtime fixtures in resume.test.ts.
 *
 * Mapping rationale:
 *   - led / owned / drove / managed / directed → senior. These
 *     are PM/IC ownership verbs; a Unit that "led" or "owned"
 *     a workstream attests to senior-level scope. Mid-IC work
 *     is more often described in passive form ("contributed
 *     to", "shipped"), which we don't map upward.
 *   - architected → staff. Architecture work usually implies
 *     staff+ scope.
 *   - executive / vp / head / chief → director. Org-level
 *     leadership verbs.
 *
 * Anything not in this table OR the ladder itself drops to
 * `null` and gets handled by the unrecognized-signal fallback
 * in `seniorityAlignment()` below (returns 0.5 — neutral —
 * rather than 0, so a Unit that attests to *something* but in
 * a vocabulary we haven't mapped doesn't get hard-zeroed).
 *
 * If the extraction prompt evolves to emit ladder terms
 * directly, this table is forward-compatible — ladder lookups
 * still work via the explicit-ladder branch in `seniorityIndex`.
 */
const SENIORITY_VERB_MAP: Readonly<Record<string, SeniorityLevel>> =
  Object.freeze({
    led: "senior",
    owned: "senior",
    drove: "senior",
    managed: "senior",
    directed: "senior",
    architected: "staff",
    executive: "director",
    vp: "director",
    head: "director",
    chief: "director",
  });

function seniorityIndex(value: string): number | null {
  const key = normalizeKey(value);
  // Explicit ladder term first — exact-match takes precedence.
  const ladderIdx = SENIORITY_LADDER.indexOf(key as SeniorityLevel);
  if (ladderIdx !== -1) return ladderIdx;
  // Verb-style mapping fallback.
  const mapped = SENIORITY_VERB_MAP[key];
  if (mapped !== undefined) return SENIORITY_LADDER.indexOf(mapped);
  return null;
}

/**
 * Per the PRD: "Seniority and scope are penalty functions
 * (one-level gap reduces; multi-level gap → 0)."
 *
 * Mapping to data:
 *   - `requirement.seniority_level` is the ask. If undefined,
 *     the requirement doesn't constrain seniority → return 1.0
 *     (no penalty axis to evaluate).
 *   - `unit.seniority_signals[]` is what the Unit attests to.
 *     Map each signal through the ladder; the unit's effective
 *     level is the maximum (best-case) seniority signal it
 *     attests to — a Unit with both "senior" and "staff"
 *     signals demonstrates staff-level work.
 *
 * Penalty curve:
 *   - 0-level gap (exact match) → 1.0
 *   - 1-level gap → 0.5
 *   - ≥2-level gap → 0.0
 *
 * The "≥2 → 0" choice is intentionally aggressive: a director-
 * level requirement against a mid-level Unit shouldn't get any
 * partial credit on this axis. The 30% semantic_similarity
 * weight can still surface the match if there's meaningful
 * prose overlap.
 */
export function seniorityAlignment(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
): number {
  if (requirement.seniority_level === undefined) return 1;
  const required = SENIORITY_LADDER.indexOf(requirement.seniority_level);
  if (required === -1) return 1; // unknown level on the requirement side → no constraint
  // Two distinct cases for "unit yields no ladder-mapped signal":
  //   1. unit.seniority_signals = [] — the Unit attests to no
  //      level at all. Hard-zero (0): no evidence of meeting
  //      the requirement's bar.
  //   2. unit.seniority_signals = ["unmapped_term"] — the Unit
  //      attests to *something*, but in vocabulary we can't
  //      ladder-map. Neutral (0.5): treating an unrecognized
  //      verb as a hard zero would systematically penalize
  //      Units whose extraction prompt uses prose we haven't
  //      mapped yet. The 0.5 is a "we don't know" default.
  // Codex P1 review on PR #103 surfaced both cases.
  if (unit.seniority_signals.length === 0) return 0;
  const unitLevels = unit.seniority_signals
    .map(seniorityIndex)
    .filter((v): v is number => v !== null);
  if (unitLevels.length === 0) return 0.5;
  const best = Math.max(...unitLevels);
  const gap = Math.abs(best - required);
  if (gap === 0) return 1;
  if (gap === 1) return 0.5;
  return 0;
}

// -- Scope alignment --------------------------------------------------------

/**
 * Scope alignment is harder than seniority because there's no
 * canonical scope ladder — `unit.scope_signals[]` is free-form
 * strings ("40M users", "$5M P&L", "team of 10"). Per the PRD
 * scope is also a penalty function, but without a structured
 * scope-level enum on either side, V1 implements it as a
 * raw-Jaccard on canonicalized signal strings.
 *
 * Because scope strings are heterogeneous and the JD parser
 * doesn't currently emit a `requirement.scope_signals` field
 * (only `keywords` + `tools` + `domains`), V1 falls back to:
 *   - Requirement keywords empty → 0.5 (neutral: the
 *     Requirement constrains nothing evaluable on this axis)
 *   - Requirement keywords present but the Unit attests to no
 *     scope signals → 0.0
 *   - Else: Jaccard on `normalizeKey`-canonicalized signal sets.
 *     Loose: "40M users" and "40M monthly viewers" don't match
 *     even though they're semantically similar; that's what the
 *     30% semantic_similarity weight is for.
 *
 * The proper "scope-level" penalty function — same shape as
 * seniorityAlignment — is deferred to a future ticket if the
 * V1 Jaccard turns out to under-perform. Documented here so a
 * future contributor sees the deviation from the PRD's
 * "penalty function" framing.
 */
/**
 * Wrap `normalizeKey` to match the `jaccard()` helper's
 * "normalizer returns string | null" contract: empty/whitespace
 * inputs collapse to null and get filtered out by `canonicalize`,
 * preserving the directional empty-set semantics the helper
 * enforces (empty Requirement side → 0.5 neutral; empty Unit
 * side against a populated Requirement → 0.0).
 */
function normalizeScopeKey(raw: string): string | null {
  const key = normalizeKey(raw);
  return key.length === 0 ? null : key;
}

export function scopeAlignment(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
): number {
  // The requirement side doesn't have a typed scope_signals
  // field. The parser categorizes scope-flavored requirements
  // with `category: "scope"`; their keywords are scope-flavored.
  // For category != "scope", the requirement doesn't attest to
  // scope, so we treat it as no-constraint (return 1.0).
  if (requirement.category !== "scope") return 1;
  // Compare unit.scope_signals against the requirement's
  // keywords (the parser's scope-category bucket). Re-uses the
  // same `jaccard()` helper as the skill/tool/domain dimensions
  // so empty-set semantics are guaranteed identical (CodeRabbit
  // PR #103). Until a scope ontology lands, normalize via raw
  // `normalizeKey` (no synonym table yet) — wrapping it to
  // satisfy the helper's null-or-string contract.
  return jaccard(unit.scope_signals, requirement.keywords, normalizeScopeKey);
}

// -- Recency ----------------------------------------------------------------

/**
 * Exponential decay on the Unit's most-recent date, with a
 * floor so a Unit aged out of the decay window still
 * contributes if it's relevant on other axes.
 *
 * Inputs:
 *   - `unit.date_range.end` if present (explicit end of the
 *     experience). If `end` is missing, the role is treated as
 *     **ongoing** — the effective end is `asOf` itself, so
 *     ongoing roles score 1.0. Codex P1 review on PR #103
 *     caught the prior fall-back-to-start behavior, which
 *     systematically under-ranked current work (a 6-year
 *     ongoing role would score ~0.42 instead of 1.0).
 *   - `asOf` defaults to `new Date()`; injected for
 *     deterministic tests.
 *
 * Curve: `0.5 ^ (years_ago / HALF_LIFE_YEARS)`, floored at
 * `RECENCY_FLOOR`. With HALF_LIFE_YEARS = 5, a 5-year-old
 * experience scores ≈ 0.5; a 10-year-old experience scores
 * ≈ 0.25; a brand-new experience scores 1.0. The floor
 * (currently 0.10) means even decade-old work contributes a
 * little — V1 user has 12 years of streaming-video work that
 * the matching engine would otherwise heavily de-prioritize
 * against newer roles.
 *
 * If the Unit has no `date_range` at all, returns 0.5 (neutral)
 * — we have no signal in either direction.
 */
const HALF_LIFE_YEARS = 5;
const RECENCY_FLOOR = 0.1;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export function recency(
  unit: ExperienceUnit,
  options?: { readonly asOf?: Date },
): number {
  const range = unit.date_range;
  if (range === undefined) return 0.5;
  const asOf = options?.asOf ?? new Date();
  // Missing `end` means "ongoing" — score as if the role ends
  // at `asOf` (recency 1.0). Falling back to `start` would
  // systematically penalize current work.
  if (range.end === undefined) {
    // Validate `start` is a real date. If it isn't, we have no
    // anchor to confirm the Unit is well-formed → neutral 0.5.
    if (typeof range.start !== "string" || range.start.length === 0) {
      return 0.5;
    }
    if (Number.isNaN(new Date(range.start).getTime())) return 0.5;
    return 1;
  }
  const referenceDateStr = range.end;
  if (typeof referenceDateStr !== "string" || referenceDateStr.length === 0) {
    return 0.5;
  }
  const referenceDate = new Date(referenceDateStr);
  if (Number.isNaN(referenceDate.getTime())) return 0.5;
  const yearsAgo = Math.max(
    0,
    (asOf.getTime() - referenceDate.getTime()) / MS_PER_YEAR,
  );
  const decayed = Math.pow(0.5, yearsAgo / HALF_LIFE_YEARS);
  return Math.max(RECENCY_FLOOR, decayed);
}

// -- Semantic similarity ----------------------------------------------------

/**
 * Cosine on cached embeddings. Throws via #98's
 * `EmptyVectorError` if either embedding is missing — caller
 * (the runMatching pipeline at #99) is responsible for
 * pre-filtering to embedding-bearing pairs or running the
 * re-embed callable first.
 */
export function semanticSimilarityScore(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
): number {
  const a = unit.embedding;
  const b = requirement.embedding;
  if (a === undefined || b === undefined) {
    throw new Error(
      `score.semanticSimilarity: missing embedding(s) (unit.id=${unit.id}, requirement.id=${requirement.id})`,
    );
  }
  return semanticSimilarity(a, b);
}

// -- Master composer --------------------------------------------------------

/**
 * Compute the full ScoreResult for a (Unit, Requirement) pair.
 * Pure — no I/O, no clock dep without `asOf` injection.
 *
 * The `final_score` is `confidence_score × rule_score`, so a
 * Unit with `confidence_score = 0` produces `final_score = 0`
 * regardless of components. This is the zero-fabrication
 * boundary at the matching layer — pinned by the
 * confidence-gating test in score.test.ts.
 */
export function score(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
  options?: { readonly asOf?: Date },
): ScoreResult {
  const components: ScoreComponents = {
    semantic_similarity: semanticSimilarityScore(unit, requirement),
    skill_overlap: skillOverlap(unit, requirement),
    domain_overlap: domainOverlap(unit, requirement),
    tool_overlap: toolOverlap(unit, requirement),
    seniority_alignment: seniorityAlignment(unit, requirement),
    scope_alignment: scopeAlignment(unit, requirement),
    recency: recency(unit, options),
  };
  const rule_score =
    WEIGHTS.semantic_similarity * components.semantic_similarity +
    WEIGHTS.skill_overlap * components.skill_overlap +
    WEIGHTS.domain_overlap * components.domain_overlap +
    WEIGHTS.tool_overlap * components.tool_overlap +
    WEIGHTS.seniority_alignment * components.seniority_alignment +
    WEIGHTS.scope_alignment * components.scope_alignment +
    WEIGHTS.recency * components.recency;
  const final_score = unit.confidence_score * rule_score;
  return {
    components,
    structural_evidence: hasStructuralEvidence(requirement),
    rule_score,
    semantic_score: components.semantic_similarity,
    final_score,
  };
}
