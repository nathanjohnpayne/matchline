/**
 * Read-only derivation of structural evidence for matches that
 * predate `UnitMatch.structural_evidence` (#441).
 *
 * ## Why this module exists
 *
 * #435 added `structural_evidence` and `component_applicability`
 * to every newly scored match. Rows written before it have
 * neither, and `computeGaps` lets those legacy rows satisfy a
 * must-have — deliberately, so that deploying the gate could not
 * make an already-matched Role sprout gaps overnight. Nothing
 * heals them, so the permissive allowance is permanent for any
 * Role the user does not re-match.
 *
 * The first attempt at healing them (#438) re-ran the **full
 * matcher** on Role open. That was the wrong module: it
 * clear-and-replaces every match under new document ids, and the
 * review found eleven defects, nine of which existed only
 * because a write happened. This module is the replacement. It
 * derives; it never writes.
 *
 * ## The fact that makes it possible
 *
 * **Structural evidence needs no embeddings.** `STRUCTURAL_AXES`
 * is skill / domain / tool / seniority / scope — `semantic_similarity`
 * and `recency` are excluded because neither is something the
 * employer asked for — and none of those five scorers reads
 * `embedding` or `semanticSimilarity`. `requirementAxes` needs
 * only `category` / `keywords` / `tools` / `domains` /
 * `seniority_level` plus the ontology.
 *
 * So the derivation is pure math over fields both documents
 * already carry, and it covers **both** legacy tiers: rows with
 * no `components` map at all (pre-#131) as well as rows with
 * components but no applicability (pre-#435).
 *
 * ## Why it recomputes rather than reading the stored components
 *
 * A stored `components` map records the ontology **as of the
 * write**. #435 expanded that vocabulary by thirteen skill
 * canonicals and one domain, which is precisely why the Coursera
 * JD went from 13% to 78% keyword recognition. Deriving from the
 * stored numbers would answer "what did we think in March",
 * which is not the question the Gaps view asks.
 *
 * The honest reading is: **under today's ontology, does this pair
 * carry evidence?** That is also the answer a re-match would
 * produce, so the derived verdict and an explicit rematch agree
 * by construction.
 *
 * This cuts both ways and that is intended. A pair can gain
 * evidence when the ontology learns a term, and it can lose
 * evidence if a canonical is ever withdrawn — in which case the
 * Role *should* sprout the gap, because the gap is real. What
 * this never does is invent coverage: `hasStructuralEvidence`
 * still requires the Requirement to constrain the axis AND the
 * Unit to score on it.
 *
 * ## What it does not do
 *
 * A stored `structural_evidence` is authoritative and is never
 * second-guessed. This module fills absences only, so a Role
 * whose matches are current behaves exactly as it does today and
 * costs no round-trip at all.
 */

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";
import type { MatchEvidence } from "../types/evidence.js";


import {
  domainOverlap,
  effectiveAxes,
  hasMappedSenioritySignal,
  hasStructuralEvidence,
  scopeAlignment,
  seniorityAlignment,
  skillOverlap,
  toolOverlap,
} from "./score.js";

// Declared in `../types/evidence.ts` rather than here so the app
// can type-import them: this module's import graph reaches
// `node:fs` through the ontology loader, and the app carries no
// `@types/node`. Re-exported so server-side callers have one
// import site for the whole surface.
export type {
  EvidenceVerdict,
  MatchEvidence,
  UnverifiableReason,
} from "../types/evidence.js";

/**
 * Does this (Unit, Requirement) pair carry evidence on an axis
 * the Requirement actually constrains?
 *
 * Delegates the decision itself to `hasStructuralEvidence` — the
 * same function `score()` calls at write time — so the derived
 * answer and the persisted one cannot drift apart. All this adds
 * is the recomputation of the five structural components, which
 * a legacy row may not carry.
 *
 * `semantic_similarity` and `recency` are absent from the
 * components object rather than filled with a placeholder:
 * `hasStructuralEvidence` reads only the structural axes, and
 * fabricating the other two would be the exact
 * neutral-as-measurement move this whole line of work exists to
 * stamp out.
 */
export function deriveStructuralEvidence(
  unit: ExperienceUnit,
  requirement: JobRequirementUnit,
): boolean {
  return hasStructuralEvidence({
    components: {
      skill_overlap: skillOverlap(unit, requirement),
      domain_overlap: domainOverlap(unit, requirement),
      tool_overlap: toolOverlap(unit, requirement),
      seniority_alignment: seniorityAlignment(unit, requirement),
      scope_alignment: scopeAlignment(unit, requirement),
    },
    axes: effectiveAxes(unit, requirement),
    seniorityMapped: hasMappedSenioritySignal(unit),
  });
}

/**
 * Resolve one match to a verdict.
 *
 * Order matters. A stored verdict short-circuits before any
 * input check, because a row the matcher already judged is not
 * made unverifiable by a Unit that has since been edited — the
 * judgement was sound when it was made and the field is the
 * matcher's own record of it.
 *
 * ### The unverifiable cases share one rule
 *
 * **If the matching pipeline would currently decline to produce
 * this pair, we cannot claim it is evidenced.** Saying otherwise
 * would let a must-have read as covered by a match that an
 * explicit rematch is about to delete.
 *
 * That rule, not any property of the derivation itself, is what
 * decides each case:
 *
 *   - `reembed_pending` and `user_approved: false` are filtered
 *     out by `defaultListUnits`. Note this is **not** because the
 *     derivation needs the embedding — it does not read one.
 *   - A missing or empty embedding on **either** side is skipped
 *     by `runMatchingPipeline`'s own pre-filter.
 *   - Two embeddings of DIFFERENT dimensions are skipped a step
 *     later: `cosine()` throws `MismatchedDimensionsError` and the
 *     pipeline's try/catch drops the pair.
 *
 * Both embedding cases came from Codex on PR #446, in successive
 * rounds, and both were the same mistake: the original version
 * fell through to derivation and could return `evidenced` for a
 * pair the pipeline will not score — contradicting the rule stated
 * directly above it. Worth noting that the derivation *could*
 * answer in every one of these cases, since the structural axes
 * never read a vector. That is precisely why "we can compute it"
 * kept reading as permission to answer, and why the test is the
 * pipeline's behaviour instead.
 */
export function resolveMatchEvidence(
  match: Pick<
    UnitMatch,
    "experience_unit_id" | "job_requirement_unit_id" | "structural_evidence"
  >,
  unit: ExperienceUnit | undefined,
  requirement: JobRequirementUnit | undefined,
): MatchEvidence {
  if (match.structural_evidence !== undefined) {
    return {
      verdict: match.structural_evidence ? "evidenced" : "unevidenced",
      stored: true,
    };
  }
  if (unit === undefined) {
    return { verdict: "unverifiable", reason: "unit_missing", stored: false };
  }
  if (requirement === undefined) {
    return {
      verdict: "unverifiable",
      reason: "requirement_missing",
      stored: false,
    };
  }
  if (!unit.user_approved) {
    return {
      verdict: "unverifiable",
      reason: "unit_unapproved",
      stored: false,
    };
  }
  if (unit.reembed_pending === true) {
    return {
      verdict: "unverifiable",
      reason: "unit_reembed_pending",
      stored: false,
    };
  }
  // Mirrors the two guards in `runMatchingPipeline` that skip a
  // pair when either side has no usable vector. The structural
  // axes never read an embedding, so the derivation COULD answer
  // here — but the pipeline would not produce the pair, so an
  // answer would outlive the match it describes.
  if (unit.embedding === undefined || unit.embedding.length === 0) {
    return {
      verdict: "unverifiable",
      reason: "unit_embedding_missing",
      stored: false,
    };
  }
  if (
    requirement.embedding === undefined ||
    requirement.embedding.length === 0
  ) {
    return {
      verdict: "unverifiable",
      reason: "requirement_embedding_missing",
      stored: false,
    };
  }
  // Present on both sides but incompatible — a stale vector from a
  // previous embedding model is the realistic cause. `cosine()`
  // throws `MismatchedDimensionsError`, `score()` propagates it,
  // and `runMatchingPipeline`'s try/catch skips the pair. Same
  // rule as every case above: the pipeline declines it, so we
  // cannot claim it. Codex P2 on PR #446, found after the
  // missing/empty case was closed.
  if (unit.embedding.length !== requirement.embedding.length) {
    return {
      verdict: "unverifiable",
      reason: "embedding_dimension_mismatch",
      stored: false,
    };
  }
  return {
    verdict: deriveStructuralEvidence(unit, requirement)
      ? "evidenced"
      : "unevidenced",
    stored: false,
  };
}

/**
 * Resolve every match in a Role to a verdict, keyed by match id.
 *
 * Pure: takes the three document sets and returns a map. The
 * callable owns the Firestore reads; this owns the decision, so
 * the whole rule is unit-testable without an emulator and the
 * emulator test can concentrate on the read path.
 */
export function deriveEvidenceForMatches(input: {
  readonly matches: readonly UnitMatch[];
  readonly units: readonly ExperienceUnit[];
  readonly requirements: readonly JobRequirementUnit[];
}): ReadonlyMap<string, MatchEvidence> {
  const unitById = new Map(input.units.map((u) => [u.id, u]));
  const requirementById = new Map(input.requirements.map((r) => [r.id, r]));
  const out = new Map<string, MatchEvidence>();
  for (const match of input.matches) {
    out.set(
      match.id,
      resolveMatchEvidence(
        match,
        unitById.get(match.experience_unit_id),
        requirementById.get(match.job_requirement_unit_id),
      ),
    );
  }
  return out;
}
