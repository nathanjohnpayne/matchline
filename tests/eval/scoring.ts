/**
 * Pure scoring functions used by the eval harness to compare extractor
 * / matcher output against hand-labeled expected outputs.
 *
 * No I/O, no LLM calls — tested in isolation. The harness (`run.ts`)
 * assembles these into per-fixture and aggregate scores.
 *
 * See `specs/matchline.md § Success metrics` for the 80/80 quality
 * bar these score functions feed.
 *
 * **Summary scoring is token-Jaccard, not exact equality (#146).**
 * The first live `npm run eval` run against Nathan's resume + the
 * Google JD reported 3.3% extraction accuracy because
 * `unitSetAccuracy` was comparing summaries with `===`. LLMs
 * paraphrase — they essentially never reproduce a hand-labeled
 * summary verbatim — so the metric collapsed to 0 in nearly every
 * pair, even when the underlying claim was the same. Token-Jaccard
 * via `tokenize` + `tokenJaccard` (already battle-tested in
 * `mapping.ts::scoreUnitPair`) is the right primitive: paraphrased
 * summaries with the same factual content score in the 0.4–0.7
 * range; wholly unrelated content stays near 0.
 */

import { tokenize, tokenJaccard } from "./mapping.js";

export interface ExpectedUnit {
  readonly normalizedSummary: string;
  readonly skills: readonly string[];
}

export interface ActualUnit {
  readonly normalizedSummary: string;
  readonly skills: readonly string[];
}

/**
 * Jaccard similarity between two string sets. Canonical skill /
 * tool / domain overlap uses this at matching time; reused here so
 * the eval harness grades extraction quality on the same metric.
 *
 * Returns a value in [0, 1]; empty vs. empty is defined as 1 (perfect
 * agreement on "nothing").
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Normalized-Unit set accuracy. Greedy best-match pairing between
 * expected and actual Units by `normalizedSummary` token-Jaccard
 * weighted with `skills` Jaccard. Returns the mean pair score;
 * unpaired expecteds contribute 0, extra actuals are ignored
 * (precision/recall asymmetry — the 80% bar is about recall over
 * expected Units).
 *
 * **Summary metric is paraphrase-resilient (#146).** Tokenize both
 * summaries (lowercase, punctuation stripped, short tokens dropped)
 * and Jaccard the sets. A 0.55-overlap paraphrase scores 0.55, not
 * 0 — which is what real LLM output produces against a hand-labeled
 * fixture. The 0.6/0.4 weighting still reflects "summary content is
 * the primary signal; canonical-vocab skills are secondary".
 *
 * **Skills metric stays full-phrase Jaccard.** Skill names should
 * be canonical ontology terms; phrase-level matching is what the
 * production matching engine uses. If the prompt produces
 * non-canonical skill phrases at scale, that's a prompt-tuning
 * concern (Phase 3 #38), not a metric one.
 */
export function unitSetAccuracy(
  expected: readonly ExpectedUnit[],
  actual: readonly ActualUnit[],
): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const used = new Set<number>();
  let total = 0;
  for (const e of expected) {
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i < actual.length; i++) {
      if (used.has(i)) continue;
      const a = actual[i]!;
      // Codex P2 on PR #147: a summary made entirely of short
      // tokens (e.g. "AI ML", "TV OS") tokenizes to empty under
      // the >2-char filter, and `tokenJaccard(empty, empty) = 0`
      // would punish a perfect textual match. Fall back to exact
      // equality on the trimmed lowercase strings when either side
      // tokenizes empty so identical short-token summaries still
      // get full credit.
      const expectedTokens = tokenize(e.normalizedSummary);
      const actualTokens = tokenize(a.normalizedSummary);
      const summaryMatch =
        expectedTokens.size === 0 || actualTokens.size === 0
          ? e.normalizedSummary.trim().toLowerCase() ===
            a.normalizedSummary.trim().toLowerCase()
            ? 1
            : 0
          : tokenJaccard(expectedTokens, actualTokens);
      const skillsMatch = jaccard(e.skills, a.skills);
      const score = summaryMatch * 0.6 + skillsMatch * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) used.add(bestIdx);
    total += bestScore;
  }
  return total / expected.length;
}

/**
 * Top-K overlap: fraction of expected match IDs that appear in the
 * actual top-K match list. Used for the PRD's 80% match-accuracy bar.
 */
export function topKOverlap(
  expected: readonly string[],
  actual: readonly string[],
  k: number,
): number {
  if (expected.length === 0) return 1;
  if (k <= 0) return 0;
  const topK = new Set(actual.slice(0, k));
  let hits = 0;
  for (const e of expected) {
    if (topK.has(e)) hits += 1;
  }
  return hits / expected.length;
}

export const EXTRACTION_ACCURACY_TARGET = 0.8;
export const MATCH_ACCURACY_TARGET = 0.8;
