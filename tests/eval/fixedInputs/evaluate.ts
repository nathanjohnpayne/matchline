/**
 * Run the production matcher on fixed inputs and score the result with
 * the eval scorer (`eval:fixed-inputs`, #648).
 *
 * `runMatch` is `runMatchingPipeline` unchanged, with in-memory
 * `listUnits` / `listRequirements` / `persistBatch` (so no Firestore and
 * no run claim) and only `score` and `asOf` injected. Every Unit ×
 * Requirement pair is scored; the eval then ranks by `final_score`.
 *
 * Match accuracy is the eval's: `topKOverlap(expected_top_matches,
 * composites, k)` with the label's k, after mapping Units and
 * Requirements to label ids. With an explicit `k` it is recall@k instead:
 * labelled pairs among the top k over the number of unique labelled
 * pairs (not capped at the label's k).
 *
 * Pure apart from the matcher call: no network, no Firestore.
 */

import { runMatchingPipeline } from "../../../functions/src/matching/pipeline.ts";
import type { ExperienceUnit, JobRequirementUnit, UnitMatch } from "../../../functions/src/types/capability.ts";

import type { ExpectedMatchesFile } from "../loadFixtures.ts";
import { compositeIdsFromMatches } from "../mapping.ts";
import { topKOverlap } from "../scoring.ts";

import type { PairScorer } from "./scorers.ts";

export async function runMatch(
  units: readonly ExperienceUnit[],
  requirements: readonly JobRequirementUnit[],
  asOf: Date,
  score: PairScorer,
): Promise<readonly UnitMatch[]> {
  return runMatchingPipeline(
    { ownerUid: "eval-user", roleId: "eval-role" },
    {
      listUnits: async () => [...units],
      listRequirements: async () => [...requirements],
      persistBatch: async (_ctx, matches) => matches,
      asOf,
      score,
    },
  );
}

/** The window the accuracy and the decomposition use. */
export function windowFor(expected: ExpectedMatchesFile, k?: number): number {
  return k ?? Math.min(expected.k, new Set(expected.expected_top_matches).size);
}

export interface Evaluation {
  /** Match accuracy (label k), or recall@k when `k` is given. In [0, 1]. */
  readonly accuracy: number;
  /** `<unit label>:<requirement label>` per match, best first. */
  readonly composites: readonly string[];
}

export function evaluateMatches(
  matches: readonly UnitMatch[],
  unitMap: ReadonlyMap<string, string>,
  requirementMap: ReadonlyMap<string, string>,
  expected: ExpectedMatchesFile,
  k?: number,
): Evaluation {
  const composites = compositeIdsFromMatches(matches, unitMap, requirementMap);
  if (k === undefined) {
    return { accuracy: topKOverlap(expected.expected_top_matches, composites, expected.k), composites };
  }
  const unique = new Set(expected.expected_top_matches);
  if (unique.size === 0) return { accuracy: 1, composites };
  const top = new Set(composites.slice(0, k));
  let hits = 0;
  for (const e of unique) if (top.has(e)) hits += 1;
  return { accuracy: hits / unique.size, composites };
}

/**
 * Where each labelled pair went. Every unique expected pair is exactly
 * one of `found` (in the window), `A` (its Unit label has no mapped Unit),
 * `B` (its Unit is mapped but its Requirement label is not) or `C` (both
 * mapped, ranked outside the window), so found + A + B + C = expected.
 */
export interface Decomposition {
  readonly expected: number;
  readonly found: number;
  /** Unit missing: no input Unit mapped to the pair's Unit label. */
  readonly A: number;
  /** The A pairs whose Requirement label is unmapped too. */
  readonly A_and_B: number;
  /** Requirement missing: Unit mapped, Requirement label not. */
  readonly B: number;
  /** Ranking: both sides mapped, pair ranked below the window. */
  readonly C: number;
  /** 1-based ranks of the C pairs. */
  readonly cRanks: readonly number[];
  /** Window entries that are not labelled pairs. */
  readonly fp: number;
  /** FP entries with an `unmapped_` side. */
  readonly fpUnmappedSide: number;
  readonly fpBothMapped: number;
}

export function decompose(
  composites: readonly string[],
  unitMap: ReadonlyMap<string, string>,
  requirementMap: ReadonlyMap<string, string>,
  expected: ExpectedMatchesFile,
  k?: number,
): Decomposition {
  const window = windowFor(expected, k);
  const top = composites.slice(0, window);
  const topSet = new Set(top);
  const mappedUnits = new Set([...unitMap.values()].filter((v) => !v.startsWith("unmapped_")));
  const mappedReqs = new Set([...requirementMap.values()].filter((v) => !v.startsWith("unmapped_")));
  const rankOf = new Map<string, number>();
  composites.forEach((c, i) => {
    if (!rankOf.has(c)) rankOf.set(c, i + 1);
  });
  let found = 0;
  let A = 0;
  let AandB = 0;
  let B = 0;
  let C = 0;
  const cRanks: number[] = [];
  const unique = new Set(expected.expected_top_matches);
  for (const pair of unique) {
    const sep = pair.indexOf(":");
    const u = pair.slice(0, sep);
    const r = pair.slice(sep + 1);
    if (topSet.has(pair)) found += 1;
    else if (!mappedUnits.has(u)) {
      A += 1;
      if (!mappedReqs.has(r)) AandB += 1;
    } else if (!mappedReqs.has(r)) B += 1;
    else {
      C += 1;
      const rank = rankOf.get(pair);
      if (rank !== undefined) cRanks.push(rank);
    }
  }
  let fp = 0;
  let fpUnmappedSide = 0;
  for (const t of top) {
    if (unique.has(t)) continue;
    fp += 1;
    if (t.includes("unmapped_")) fpUnmappedSide += 1;
  }
  return {
    expected: unique.size,
    found,
    A,
    A_and_B: AandB,
    B,
    C,
    cRanks,
    fp,
    fpUnmappedSide,
    fpBothMapped: fp - fpUnmappedSide,
  };
}

/** Sum decompositions (ranks are concatenated). */
export function sumDecompositions(ds: readonly Decomposition[]): Decomposition {
  const zero: Decomposition = {
    expected: 0,
    found: 0,
    A: 0,
    A_and_B: 0,
    B: 0,
    C: 0,
    cRanks: [],
    fp: 0,
    fpUnmappedSide: 0,
    fpBothMapped: 0,
  };
  return ds.reduce<Decomposition>(
    (acc, d) => ({
      expected: acc.expected + d.expected,
      found: acc.found + d.found,
      A: acc.A + d.A,
      A_and_B: acc.A_and_B + d.A_and_B,
      B: acc.B + d.B,
      C: acc.C + d.C,
      cRanks: [...acc.cRanks, ...d.cRanks],
      fp: acc.fp + d.fp,
      fpUnmappedSide: acc.fpUnmappedSide + d.fpUnmappedSide,
      fpBothMapped: acc.fpBothMapped + d.fpBothMapped,
    }),
    zero,
  );
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
