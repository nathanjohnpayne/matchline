/**
 * Pair scorers for `eval:fixed-inputs` (#648), injected into the
 * production matcher through `MatchingDeps.score`.
 *
 * `current` is the production `score()` itself. `renormalized` and
 * `cosine` are EXPERIMENTAL scorers that exist only in this harness:
 * they do not touch `functions/src`, and nothing in production calls
 * them. They are the formulas the read-only matching diagnostic used,
 * kept here verbatim so the runner reproduces its numbers:
 *
 * - `renormalized` (#433/#601): keep only the axes the pair's
 *   `component_applicability` marks applicable and renormalize the
 *   PRD weights over them, so an axis the Requirement does not
 *   constrain contributes neither its neutral default nor its weight.
 *   With no applicable axis the rule score is 0.
 * - `cosine`: rank on embedding similarity alone
 *   (`confidence × semantic_similarity`).
 *
 * Both keep `components`, `component_applicability` and
 * `structural_evidence` from `score()`, so the pipeline's rationale
 * generator still runs on the real components; only `rule_score` and
 * `final_score` (the ranking key) change.
 */

import { score, WEIGHTS, type ScoreResult } from "../../../functions/src/matching/score.ts";
import type { ExperienceUnit, JobRequirementUnit } from "../../../functions/src/types/capability.ts";

export type PairScorer = typeof score;

export type ScorerName = "current" | "renormalized" | "cosine";

export const SCORER_NAMES: readonly ScorerName[] = Object.freeze(["current", "renormalized", "cosine"]);

export function isScorerName(value: string): value is ScorerName {
  return (SCORER_NAMES as readonly string[]).includes(value);
}

/** Σ w·component / Σ w over the applicable axes; 0 when none applies. */
export function renormalizedRule(
  components: ScoreResult["components"],
  applicability: ScoreResult["component_applicability"],
): number {
  let num = 0;
  let den = 0;
  for (const [axis, weight] of Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][]) {
    if (applicability[axis]) {
      num += weight * components[axis];
      den += weight;
    }
  }
  return den > 0 ? num / den : 0;
}

/** Experimental: the PRD weights renormalized over the pair's applicable axes. */
export function renormalizedScore(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
  options?: { readonly asOf?: Date },
): ScoreResult {
  const base = score(unit, requirement, options);
  const rule = renormalizedRule(base.components, base.component_applicability);
  return { ...base, rule_score: rule, final_score: unit.confidence_score * rule };
}

/** Experimental: confidence × embedding cosine similarity, nothing else. */
export function cosineScore(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
  options?: { readonly asOf?: Date },
): ScoreResult {
  const base = score(unit, requirement, options);
  const semantic = base.components.semantic_similarity;
  return { ...base, rule_score: semantic, final_score: unit.confidence_score * semantic };
}

export const SCORERS: Readonly<Record<ScorerName, PairScorer>> = Object.freeze({
  current: score,
  renormalized: renormalizedScore,
  cosine: cosineScore,
});
