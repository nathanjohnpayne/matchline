/**
 * Pure helper: compute the per-component breakdown rows for
 * the Matches tab's sub-score tooltip (#131).
 *
 * Input: a UnitMatch's persisted `components` (the 7
 * sub-scores) + the source Unit's `confidence_score`. Output:
 * a normalized row list the tooltip renders directly.
 *
 * Why this lives outside the component:
 *   - Pure function — testable in isolation; no React.
 *   - The weight constants (mirrored from
 *     `functions/src/matching/score.ts`'s `WEIGHTS`) live
 *     here as a single source of truth for the client side.
 *     A drift between client + server weights would be a
 *     real bug; the matching pipeline's score test pins the
 *     server-side sum, and this module's tests pin the
 *     client-side sum to match.
 *   - The "contribution = sub-score × weight" arithmetic
 *     is canonical here so a future tooltip variant doesn't
 *     re-derive it inconsistently.
 */

import type { ScoreComponents } from "../../types/capability.ts";

/**
 * Client-side mirror of the server's `WEIGHTS` const at
 * `functions/src/matching/score.ts`. MUST stay in sync —
 * the test in `scoreBreakdown.test.ts` asserts they sum to
 * exactly 1.0, so a future drift surfaces there.
 *
 * Keys match `ScoreComponents` field names so the
 * breakdown renderer can iterate component → weight by
 * key lookup.
 */
export const COMPONENT_WEIGHTS: Readonly<Record<keyof ScoreComponents, number>> = Object.freeze({
  semantic_similarity: 0.3,
  skill_overlap: 0.2,
  domain_overlap: 0.15,
  tool_overlap: 0.1,
  seniority_alignment: 0.1,
  scope_alignment: 0.1,
  recency: 0.05,
});

/**
 * Display order for the breakdown rows. Matches the spec's
 * narrative order (highest weight first, lowest last) so
 * the tooltip reads top-to-bottom in importance order.
 */
export const COMPONENT_DISPLAY_ORDER: ReadonlyArray<keyof ScoreComponents> = [
  "semantic_similarity",
  "skill_overlap",
  "domain_overlap",
  "tool_overlap",
  "seniority_alignment",
  "scope_alignment",
  "recency",
];

/**
 * Human-readable label per component key. Kept here so a
 * future i18n pass has one place to translate.
 */
export const COMPONENT_LABELS: Readonly<Record<keyof ScoreComponents, string>> = Object.freeze({
  semantic_similarity: "Semantic",
  skill_overlap: "Skill",
  domain_overlap: "Domain",
  tool_overlap: "Tool",
  seniority_alignment: "Seniority",
  scope_alignment: "Scope",
  recency: "Recency",
});

export interface BreakdownRow {
  readonly key: keyof ScoreComponents;
  readonly label: string;
  /** Sub-score in [0, 1]. */
  readonly value: number;
  /** This component's contribution to `rule_score`. */
  readonly weight: number;
  /** `value × weight` — what this row contributes to the final number. */
  readonly contribution: number;
  /**
   * Did the engine actually evaluate this axis for this pair?
   *
   * `false` means `value` is a no-constraint neutral rather than
   * a measurement, and the row must NOT be rendered as a score:
   * "Skill 0.50 × 0.20 = 0.100" tells the user they achieved 50%
   * overlap on a comparison that never happened, which is the
   * opposite of what the spec's neutral-fallback rule requires.
   * Codex P2 on #435.
   *
   * Legacy rows (no persisted `component_applicability`) default
   * to `true` — they predate the field, and their components
   * were computed under a rule that hard-zeroed unevaluated
   * axes rather than paying a neutral, so presenting them as
   * measured is accurate for that data.
   */
  readonly evaluated: boolean;
}

/**
 * Build the breakdown rows. Returns `null` when components
 * aren't persisted on the match (legacy pre-#131 row); the
 * tooltip can render a "breakdown unavailable, rerun
 * matching" hint instead.
 */
export function buildBreakdownRows(
  components: ScoreComponents | undefined,
  applicability?: Readonly<Record<keyof ScoreComponents, boolean>>,
): readonly BreakdownRow[] | null {
  if (components === undefined) return null;
  return COMPONENT_DISPLAY_ORDER.map((key) => {
    const value = components[key];
    const weight = COMPONENT_WEIGHTS[key];
    return {
      key,
      label: COMPONENT_LABELS[key],
      value,
      weight,
      contribution: value * weight,
      evaluated: applicability?.[key] ?? true,
    };
  });
}
