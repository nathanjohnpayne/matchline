/**
 * Runtime UUID → labeler mnemonic ID mapping (#136).
 *
 * The matching pipeline produces UnitMatches keyed by the
 * runtime extraction's random UUIDs. The eval harness's
 * fixture labels (`expected_top_matches`, `expected_traces`)
 * use stable mnemonic IDs the labeler controls. Scoring
 * requires translating the former into the latter so the
 * composite-string format matches.
 *
 * Mapping shape:
 *   - For Units: pair each actual ExperienceUnit to the
 *     closest labeled ExpectedUnit by (normalized_summary
 *     fuzzy match × skills Jaccard). Threshold-based; below
 *     threshold → unmapped.
 *   - For Requirements: pair by (text fuzzy match) since
 *     the labeled `text` is shorter than the runtime's
 *     `normalized_requirement`/`raw_text`.
 *
 * Unmapped entries become `unmapped_<actualId>` in the
 * composite — those will never match any expected_top_match
 * and count as misses, which is the right behavior (the
 * extractor produced something the labeler didn't expect, OR
 * the threshold needs tuning).
 *
 * Pure functions; no I/O. Tested in isolation.
 */

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../functions/src/types/capability.ts";

import type {
  ExpectedRequirement,
  ExpectedUnit,
} from "./loadFixtures.ts";

/**
 * Default mapping threshold in [0, 1]. Below this, the
 * actual entry is considered "no honest mapping" and gets
 * `unmapped_<id>` in the composite output. 0.30 is permissive
 * enough that paraphrased extractor output (LLMs rarely
 * reproduce the labeler's exact wording) maps correctly,
 * but strict enough that wholly unrelated content doesn't
 * accidentally collapse onto a single labeled entry.
 *
 * Override for fixtures with unusual content density via
 * the `threshold` parameter on each map function.
 */
export const DEFAULT_MAPPING_THRESHOLD = 0.3;

/**
 * Tokenize a string for similarity comparison: lowercase,
 * strip punctuation, split on whitespace, drop very short
 * tokens (`a`, `or`, etc.). Returns a `Set<string>` —
 * caller's choice whether to use it for Jaccard or
 * substring checks.
 */
export function tokenize(text: string): Set<string> {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter((t) => t.length > 2);
  return new Set(tokens);
}

/**
 * Jaccard similarity between two token sets (already
 * tokenized). Returns [0, 1]; empty vs. empty defined as 0
 * (NOT 1 — different from the matching engine's empty-vs-
 * empty=1 convention because here "no shared tokens" is
 * the disagreement signal we're scoring; two empty strings
 * are vacuously "similar" in the matching engine but
 * meaningless for our mapping).
 */
export function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  return inter / (a.size + b.size - inter);
}

/**
 * Score how well an actual ExperienceUnit matches an
 * ExpectedUnit. Same shape as `unitSetAccuracy`'s pairing
 * logic in `scoring.ts`: 0.6 × normalized_summary token
 * Jaccard + 0.4 × skills Jaccard.
 */
export function scoreUnitPair(
  expected: ExpectedUnit,
  actual: ExperienceUnit,
): number {
  const summaryScore = tokenJaccard(
    tokenize(expected.normalized_summary),
    tokenize(actual.normalized_summary),
  );
  const skillsScore = tokenJaccard(
    new Set(expected.skills.map((s) => s.toLowerCase())),
    new Set(actual.skills.map((s) => s.toLowerCase())),
  );
  return summaryScore * 0.6 + skillsScore * 0.4;
}

/**
 * Score how well an actual JobRequirementUnit matches an
 * ExpectedRequirement. Just text-token Jaccard — the
 * labeled `text` is the requirement's essence; the runtime
 * `normalized_requirement` is a paraphrase produced by the
 * parser. Keep the comparison field-equivalent.
 */
export function scoreRequirementPair(
  expected: ExpectedRequirement,
  actual: JobRequirementUnit,
): number {
  return tokenJaccard(
    tokenize(expected.text),
    tokenize(actual.normalized_requirement),
  );
}

/**
 * Build a runtimeId → mnemonicId map for Units. Greedy
 * best-pairing: each actual Unit picks its highest-scoring
 * expected Unit if score crosses threshold; ties broken by
 * lower index in expected. Each expected Unit is consumed
 * at most once — the SECOND actual Unit competing for the
 * same expected gets skipped down its preference list.
 *
 * Unmapped actuals → mnemonic `unmapped_<actualId>` so the
 * composite-string consumer treats them as misses.
 */
export function mapUnitIds(
  expected: readonly ExpectedUnit[],
  actual: readonly ExperienceUnit[],
  threshold: number = DEFAULT_MAPPING_THRESHOLD,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const usedExpected = new Set<number>();
  // Score every (actual, expected) pair, then greedy-assign
  // by descending score. Stable across input order.
  const scored: Array<{
    actualIdx: number;
    expectedIdx: number;
    score: number;
  }> = [];
  for (let a = 0; a < actual.length; a++) {
    for (let e = 0; e < expected.length; e++) {
      const score = scoreUnitPair(expected[e]!, actual[a]!);
      if (score >= threshold) {
        scored.push({ actualIdx: a, expectedIdx: e, score });
      }
    }
  }
  scored.sort((x, y) => y.score - x.score || x.expectedIdx - y.expectedIdx);

  const usedActual = new Set<number>();
  for (const pair of scored) {
    if (usedExpected.has(pair.expectedIdx)) continue;
    if (usedActual.has(pair.actualIdx)) continue;
    out.set(actual[pair.actualIdx]!.id, expected[pair.expectedIdx]!.id);
    usedExpected.add(pair.expectedIdx);
    usedActual.add(pair.actualIdx);
  }
  // Unmapped actuals → `unmapped_<id>`.
  for (const a of actual) {
    if (!out.has(a.id)) {
      out.set(a.id, `unmapped_${a.id}`);
    }
  }
  return out;
}

/**
 * Build a runtimeId → mnemonicId map for Requirements.
 * Same greedy-best-pairing shape as `mapUnitIds`.
 */
export function mapRequirementIds(
  expected: readonly ExpectedRequirement[],
  actual: readonly JobRequirementUnit[],
  threshold: number = DEFAULT_MAPPING_THRESHOLD,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const usedExpected = new Set<number>();
  const usedActual = new Set<number>();
  const scored: Array<{
    actualIdx: number;
    expectedIdx: number;
    score: number;
  }> = [];
  for (let a = 0; a < actual.length; a++) {
    for (let e = 0; e < expected.length; e++) {
      const score = scoreRequirementPair(expected[e]!, actual[a]!);
      if (score >= threshold) {
        scored.push({ actualIdx: a, expectedIdx: e, score });
      }
    }
  }
  scored.sort((x, y) => y.score - x.score || x.expectedIdx - y.expectedIdx);
  for (const pair of scored) {
    if (usedExpected.has(pair.expectedIdx)) continue;
    if (usedActual.has(pair.actualIdx)) continue;
    out.set(actual[pair.actualIdx]!.id, expected[pair.expectedIdx]!.id);
    usedExpected.add(pair.expectedIdx);
    usedActual.add(pair.actualIdx);
  }
  for (const a of actual) {
    if (!out.has(a.id)) {
      out.set(a.id, `unmapped_${a.id}`);
    }
  }
  return out;
}

/**
 * Convert actual UnitMatches into composite mnemonic-ID
 * strings the scorer (`tests/eval/scoring.ts::topKOverlap`)
 * consumes. Format: `"<unit_mnemonic>:<requirement_mnemonic>"`.
 *
 * Sorted by `final_score` desc so the caller can slice the
 * first K for the scorer's k-prefix semantics.
 */
export function compositeIdsFromMatches(
  matches: readonly UnitMatch[],
  unitMap: ReadonlyMap<string, string>,
  requirementMap: ReadonlyMap<string, string>,
): readonly string[] {
  const sorted = [...matches].sort((a, b) => b.final_score - a.final_score);
  return sorted.map((m) => {
    const unitMnemonic = unitMap.get(m.experience_unit_id) ?? `unmapped_${m.experience_unit_id}`;
    const reqMnemonic =
      requirementMap.get(m.job_requirement_unit_id) ??
      `unmapped_${m.job_requirement_unit_id}`;
    return `${unitMnemonic}:${reqMnemonic}`;
  });
}
