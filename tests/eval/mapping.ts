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
 * Sanity floor in [0, 1] for the relative best-match mapping
 * (#148 acceptance #1). The map functions below are greedy
 * *relative* best-pairing: each actual entry is assigned to its
 * single best available expected entry (highest score wins, each
 * expected consumed at most once). This floor exists ONLY to
 * reject wholly-unrelated garbage — it is NOT a quality cutoff
 * for real matches.
 *
 * **Why 0.10, not the prior 0.30.** 0.30 was an absolute cutoff
 * that left real-but-paraphrased pairs `unmapped_<id>`. The live
 * Kepler pair scored ~0.17 pre-#157's overlap-coefficient fix and
 * ~0.30 after — right on the knife's edge. Pairs hovering near
 * 0.30 flipped mapped/unmapped as the non-deterministic extractor
 * reworded summaries run-to-run, injecting ~8–13pp of pure noise
 * into match accuracy (observed on PR #258: a single fixture swung
 * 12.5–25.0% across three samples). Dropping the floor to a low
 * sanity guard lets the relative best-match do the real work: the
 * strongest available pairing wins regardless of its absolute
 * score, so a real pair at 0.15–0.30 maps *stably* instead of
 * flickering. Only genuine garbage (< 0.10 to its best expected)
 * stays unmapped.
 *
 * Override per call via the `threshold` parameter on each map
 * function (e.g. a stricter floor for a content-dense fixture).
 */
export const DEFAULT_MAPPING_THRESHOLD = 0.1;

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
 * Overlap coefficient (Szymkiewicz–Simpson):
 *   |A ∩ B| / min(|A|, |B|)
 *
 * Returns [0, 1]; empty vs. empty defined as 0 (mirror of
 * `tokenJaccard`'s convention — no shared tokens = no
 * mapping signal).
 *
 * **Why we need this for summary scoring (#148).** The
 * runtime extractor produces verbose summaries (~30 tokens
 * with detail / metrics / context); labeled `expected_units`
 * are intentionally concise (~13 tokens — the essential
 * claim). Token-Jaccard penalizes that asymmetry hard:
 *
 *   runtime "Led the Amazon Kepler launch, a ground-up
 *           rewrite of Fire TV's Android stack..." (30 tok)
 *   expected "Led Amazon Kepler launch — ground-up rewrite
 *            replacing Fire TV Android stack with native
 *            Linux-based OS" (13 tok)
 *
 *   intersection: 11 tokens (kepler, launch, ground-up,
 *                 rewrite, fire, android, stack, native,
 *                 linux-based, etc.)
 *   tokenJaccard = 11 / (30+13-11) = 0.344
 *   overlapCoef  = 11 / min(30, 13) = 0.846
 *
 * Live diagnostic on Nathan-2026 × Google-Compute-SPM
 * (#148) showed the runtime "Kepler" unit scoring **0.174**
 * total (= 0.6×Jaccard summary + 0.4×skills) against
 * `u_kepler` — below the 0.30 mapping threshold, so
 * `mapUnitIds` left u_kepler unmapped despite Kepler being
 * the most distinctive content match. With overlap
 * coefficient on the summary axis the same pair scores
 * 0.6×0.846 + 0.4×skills ≈ 0.55-0.60, comfortably above
 * threshold.
 *
 * **Why not for skills.** Skills are intentionally curated
 * canonical phrases (e.g. "release engineering", "platform
 * launch"). Both labeler and extractor emit the same shape
 * (small list, no verbosity asymmetry), so the size-disparity
 * problem doesn't apply. Keeping `tokenJaccard` for skills
 * preserves the existing semantics + tests.
 */
export function tokenOverlapCoefficient(
  a: Set<string>,
  b: Set<string>,
): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  return inter / Math.min(a.size, b.size);
}

/**
 * Score how well an actual ExperienceUnit matches an
 * ExpectedUnit. 0.6 × summary overlap-coefficient + 0.4 ×
 * skills Jaccard.
 *
 * Summary uses overlap coefficient (not Jaccard) for
 * verbosity-asymmetry resilience — see
 * `tokenOverlapCoefficient` docstring + #148 diagnostic.
 * Skills stay full-phrase Jaccard since both labeler and
 * extractor emit the same curated canonical-phrase shape.
 *
 * **Empty-token fallback (cursor on PR #158).** Mirrors
 * `unitSetAccuracy` in `scoring.ts`: a summary made entirely
 * of short tokens (e.g. "AI ML", "TV OS") tokenizes to empty
 * under the >2-char filter, and `tokenOverlapCoefficient`
 * returns 0 on empty-vs-empty by convention (mirrors
 * `tokenJaccard`). Without the fallback, extraction-acc and
 * mapping disagree for these edge cases — extraction gives
 * full summary credit via the same fallback, but mapping
 * would leave an exact-match short-token pair as
 * `unmapped_<id>`. Fall back to trimmed-lowercase exact
 * equality so an exact textual match still gets full summary
 * credit at the mapping boundary.
 */
export function scoreUnitPair(
  expected: ExpectedUnit,
  actual: ExperienceUnit,
): number {
  const expectedTokens = tokenize(expected.normalized_summary);
  const actualTokens = tokenize(actual.normalized_summary);
  const summaryScore =
    expectedTokens.size === 0 || actualTokens.size === 0
      ? expected.normalized_summary.trim().toLowerCase() ===
        actual.normalized_summary.trim().toLowerCase()
        ? 1
        : 0
      : tokenOverlapCoefficient(expectedTokens, actualTokens);
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
  // Three-key sort: score desc, then expectedIdx asc, then
  // actualIdx asc. CR Major caught the prior shape where
  // ties on (score, expectedIdx) fell back to V8's Array
  // input order, which itself depends on extractor /
  // parser output ordering — not stable across runs. The
  // explicit actualIdx tiebreaker pins the eval result
  // against ordering drift in upstream pipelines.
  scored.sort(
    (x, y) =>
      y.score - x.score ||
      x.expectedIdx - y.expectedIdx ||
      x.actualIdx - y.actualIdx,
  );

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
  // Three-key sort: score desc, then expectedIdx asc, then
  // actualIdx asc. CR Major caught the prior shape where
  // ties on (score, expectedIdx) fell back to V8's Array
  // input order, which itself depends on extractor /
  // parser output ordering — not stable across runs. The
  // explicit actualIdx tiebreaker pins the eval result
  // against ordering drift in upstream pipelines.
  scored.sort(
    (x, y) =>
      y.score - x.score ||
      x.expectedIdx - y.expectedIdx ||
      x.actualIdx - y.actualIdx,
  );
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
