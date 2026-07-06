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
 * **Summary scoring evolution.** The first live `npm run eval` run
 * (#146) reported 3.3% extraction accuracy because `unitSetAccuracy`
 * was comparing summaries with `===` — LLMs paraphrase, so the
 * metric collapsed to 0. PR #147 switched to `tokenJaccard`,
 * which lifted extraction to 34% but still penalized the verbosity
 * asymmetry between the runtime extractor's detailed summaries and
 * the labeler's concise ones. PR #158 (this contract) switched to
 * `tokenOverlapCoefficient` (`|A ∩ B| / min(|A|, |B|)`), which
 * gives full credit when the smaller (labeled) set is fully covered
 * by the larger (runtime) one — the asymmetry the fixture
 * convention bakes in. Live extraction lifted to 50.3% and the
 * matching pair this primitive enables (`u_kepler`) finally maps,
 * unblocking match accuracy too.
 *
 * The empty-token-set fallback to trimmed-lowercase exact equality
 * (added per Codex P2 on #147 for "AI ML"-shape short-token
 * summaries) is preserved in this contract — `unitSetAccuracy`'s
 * inner branch still falls back to exact equality when either side
 * tokenizes empty.
 */

import { tokenOverlapCoefficient, tokenize } from "./mapping.js";

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
 * expected and actual Units by `normalizedSummary` overlap-coefficient
 * weighted with `skills` Jaccard. Returns the mean pair score;
 * unpaired expecteds contribute 0, extra actuals are ignored
 * (precision/recall asymmetry — the 80% bar is about recall over
 * expected Units).
 *
 * **Summary metric is paraphrase-resilient AND verbosity-resilient
 * (#146 + #148).** Tokenize both summaries (lowercase, punctuation
 * stripped, short tokens dropped) and use overlap-coefficient
 * (`|A ∩ B| / min(|A|, |B|)`). Pre-#146 used exact-string equality
 * — the metric was always ~0 against real LLM output. Pre-#148
 * used token-Jaccard, which still penalized the runtime's verbose
 * summaries against concise labeler summaries (live diagnostic on
 * Nathan + Google: Kepler runtime scored 0.344 on the matching
 * pair where overlap-coefficient scores 0.846). Overlap-coefficient
 * fixes both at the same primitive.
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
    // Codex P2 on PR #147: a summary made entirely of short
    // tokens (e.g. "AI ML", "TV OS") tokenizes to empty under
    // the >2-char filter, and the token-set similarity
    // function returns 0 on empty-vs-empty — that would
    // punish a perfect textual match. Fall back to exact
    // equality on the trimmed lowercase strings when either
    // side tokenizes empty so identical short-token summaries
    // still get full credit.
    //
    // Summary similarity uses overlap-coefficient (#148) not
    // Jaccard. The runtime extractor produces verbose
    // summaries (~30 tokens with detail); labeled summaries
    // are concise (~13 tokens). Jaccard penalized that
    // asymmetry — the live diagnostic on Nathan-2026 ×
    // Google-Compute-SPM saw token-Jaccard score ~0.34 on
    // the Kepler match where overlap-coefficient scores
    // ~0.85. See `tokenOverlapCoefficient`'s docstring.
    //
    // CodeRabbit Nit on PR #147: `expectedTokens` and the
    // lowercased fallback string depend only on `e`; hoist out
    // of the inner `i` loop so they're computed once per
    // expected unit, not once per (expected × actual) pair.
    const expectedTokens = tokenize(e.normalizedSummary);
    const expectedNormalized = e.normalizedSummary.trim().toLowerCase();
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i < actual.length; i++) {
      if (used.has(i)) continue;
      const a = actual[i]!;
      const actualTokens = tokenize(a.normalizedSummary);
      const summaryMatch =
        expectedTokens.size === 0 || actualTokens.size === 0
          ? expectedNormalized === a.normalizedSummary.trim().toLowerCase()
            ? 1
            : 0
          : tokenOverlapCoefficient(expectedTokens, actualTokens);
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
  const expectedSet = new Set(expected);
  if (expectedSet.size === 0) return 1;
  if (k <= 0) return 0;
  const topK = new Set(actual.slice(0, k));
  let hits = 0;
  for (const e of expectedSet) {
    if (topK.has(e)) hits += 1;
  }
  return hits / expectedSet.size;
}

export const EXTRACTION_ACCURACY_TARGET = 0.8;
export const MATCH_ACCURACY_TARGET = 0.8;
