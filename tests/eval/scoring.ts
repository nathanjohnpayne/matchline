/**
 * Pure scoring functions used by the eval harness to compare extractor
 * / matcher output against hand-labeled expected outputs.
 *
 * No I/O, no LLM calls — tested in isolation. The harness (`run.ts`)
 * assembles these into per-fixture and aggregate scores.
 *
 * See `specs/matchline.md § Success metrics` for the 80/80 quality
 * bar these score functions feed.
 */

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
 * expected and actual Units by `normalizedSummary` equality, falling
 * back to Jaccard on `skills` for soft pairing. Returns the mean
 * pair score; unpaired expecteds contribute 0, extra actuals are
 * ignored (precision/recall asymmetry — the 80% bar is about recall
 * over expected Units).
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
      const summaryMatch = e.normalizedSummary === a.normalizedSummary ? 1 : 0;
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
