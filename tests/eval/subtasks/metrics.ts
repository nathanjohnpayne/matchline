/**
 * Metrics for the subtask suites (#488). Pure functions; no model
 * judge. Every rate keeps its numerator and denominator so a reader can
 * see how few cases stand behind it.
 *
 * Coverage is lexical: a gold assertion is covered when ONE extracted
 * claim contains every term group of the assertion (each group satisfied
 * by any of its alternatives, after `normalize`). Paraphrases outside the
 * listed alternatives count as misses, so coverage is conservative. Each
 * claim is credited to at most one assertion (a maximum one-to-one
 * matching), so an extractor that stops splitting and repeats the whole
 * item scores 1/|A|, not |A|/|A|.
 *
 * Rates over labeled verdicts are clustered by what was labeled: with
 * `--samples N` the N verdicts on one assertion (or one case) are one
 * observation, so repeats never shrink an interval. The two fabrication
 * false-accept rates count a unit as accepted when ANY sample accepted it
 * (zero fabrication means zero false acceptance across all repetitions);
 * every other rate uses the majority of the samples, a tie counting
 * against the model. Each such rate reports the distinct count, the
 * pooled sample count and a Wilson 95% interval.
 *
 * Invocations that were stopped (budget) or cancelled (the validation
 * call pool aborted them after another call failed) are left out of
 * every denominator and counted on their own.
 */

import type { Stage } from "../../../functions/src/llm/config.ts";
import type { GeneratedAssetContent } from "../../../functions/src/types/crm.ts";
import { stats, type LatencyStats } from "../../../scripts/latency/report.ts";

import { groupCovered, normalize, type GenerationSnapshot, type GoldAssertion, type GoldRelationship, type TermGroup, type ValidationCase } from "./fixtures.ts";
import { stoppedKind, type CallOutcome, type CallPass, type CallRecord, type InvocationRecord } from "./instrument.ts";
import type { CaseResult, FlowResult } from "./suites.ts";

export { normalize, groupCovered };

export interface Ratio {
  readonly num: number;
  readonly den: number;
  /** `num / den`, or null when the denominator is 0. */
  readonly value: number | null;
}

export function ratio(num: number, den: number): Ratio {
  return { num, den, value: den === 0 ? null : num / den };
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/** Wilson score interval for `num` of `den` (95% by default); null when `den` is 0. */
export function wilson(num: number, den: number, z = 1.959964): Interval | null {
  if (den === 0) return null;
  const p = num / den;
  const z2 = z * z;
  const centre = (p + z2 / (2 * den)) / (1 + z2 / den);
  const half = (z * Math.sqrt((p * (1 - p)) / den + z2 / (4 * den * den))) / (1 + z2 / den);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * A rate over labeled units (an assertion, or a case), with repeats
 * clustered: `units` counts each distinct unit once, as a hit by the
 * rule of its `UnitRule`; `samples` pools every verdict; `interval` is
 * Wilson 95% over `units`.
 */
export interface ClusteredRate {
  readonly units: Ratio;
  readonly samples: Ratio;
  readonly interval: Interval | null;
}

/**
 * How a unit's samples become one verdict:
 *   - `"majority"`: a hit when at least half its samples hit (a tie
 *     counts as a hit, i.e. against the model);
 *   - `"any"`: a hit when any sample hit. Used for the fabrication
 *     false-accept rates, where one accepted fabrication in N repetitions
 *     breaks the zero-fabrication contract (#488 review).
 */
export type UnitRule = "majority" | "any";

export function clusteredRate(
  observations: readonly { readonly unit: string; readonly hit: boolean }[],
  rule: UnitRule = "majority",
): ClusteredRate {
  const byUnit = new Map<string, { hits: number; n: number }>();
  for (const o of observations) {
    const u = byUnit.get(o.unit) ?? { hits: 0, n: 0 };
    u.n++;
    if (o.hit) u.hits++;
    byUnit.set(o.unit, u);
  }
  const unitHit = rule === "any" ? (u: { hits: number }) => u.hits > 0 : (u: { hits: number; n: number }) => 2 * u.hits >= u.n;
  const unitHits = [...byUnit.values()].filter(unitHit).length;
  return {
    units: ratio(unitHits, byUnit.size),
    samples: ratio(observations.filter((o) => o.hit).length, observations.length),
    interval: wilson(unitHits, byUnit.size),
  };
}

/** True when a single text satisfies every group. */
export function coversAll(groups: readonly TermGroup[], text: string): boolean {
  return groups.every((g) => groupCovered(g, text));
}

/** Some single claim covers every required term of the assertion (ignoring other assertions). */
export function assertionCovered(a: Pick<GoldAssertion, "required_terms">, claims: readonly string[]): boolean {
  return claims.some((c) => coversAll(a.required_terms, c));
}

/**
 * Coverage with each claim credited to at most one assertion: the size
 * of a maximum bipartite matching between assertions and claims, where
 * an edge means the claim covers every term of the assertion (Kuhn's
 * augmenting paths; |A| and |claims| are small). `fused` counts claims
 * that cover the terms of two or more assertions: a sign the extractor
 * did not decompose.
 */
export function matchCoverage(
  assertions: readonly Pick<GoldAssertion, "required_terms">[],
  claims: readonly string[],
): { readonly covered: number; readonly fused: number } {
  const edges = assertions.map((a) => claims.flatMap((c, j) => (coversAll(a.required_terms, c) ? [j] : [])));
  const owner = new Array<number>(claims.length).fill(-1);
  const augment = (a: number, seen: boolean[]): boolean => {
    for (const j of edges[a]!) {
      if (seen[j]) continue;
      seen[j] = true;
      if (owner[j] === -1 || augment(owner[j]!, seen)) {
        owner[j] = a;
        return true;
      }
    }
    return false;
  };
  let covered = 0;
  for (let a = 0; a < assertions.length; a++) {
    if (augment(a, new Array<boolean>(claims.length).fill(false))) covered++;
  }
  const fused = claims.filter((_, j) => edges.filter((e) => e.includes(j)).length >= 2).length;
  return { covered, fused };
}

export function relationshipCovered(r: Pick<GoldRelationship, "co_terms">, claims: readonly string[]): boolean {
  return claims.some((c) => coversAll(r.co_terms, c));
}

// -- Claim extraction ------------------------------------------------------------

export interface CoverageMetrics {
  /**
   * One-to-one: each claim credited to at most one assertion. Over
   * successful extractions only: a hard-failed extraction is a schema
   * (or transport) failure, counted under schema validity and listed in
   * `hardFailedCases`, never as poor decomposition.
   */
  readonly assertionCoverage: Ratio;
  readonly relationshipCoverage: Ratio | null;
  /**
   * End-to-end figures (secondary): the same ratios with each hard-failed
   * extraction scored as covering nothing. Equal to the headline figures
   * when no extraction hard-failed.
   */
  readonly assertionCoverageHardFailsAsZero: Ratio;
  readonly relationshipCoverageHardFailsAsZero: Ratio | null;
  /** Claims that cover the terms of two or more assertions (summed over cases and samples). */
  readonly fusedClaims: number;
  /** Extractions that hard-failed: left out of the headline denominators. */
  readonly hardFailedCases: readonly string[];
  /** Extractions the budget stopped: left out of the denominators. */
  readonly stoppedCases: readonly string[];
  readonly perCase: readonly { caseId: string; covered: number; total: number; relCovered: number; relTotal: number; fused: number }[];
}

export function coverageMetrics(
  cases: readonly ValidationCase[],
  results: readonly CaseResult[],
): CoverageMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  let num = 0;
  let den = 0;
  let rNum = 0;
  let rDen = 0;
  let failedDen = 0;
  let failedRDen = 0;
  let fusedTotal = 0;
  const hardFailed: string[] = [];
  const stopped: string[] = [];
  const perCase: CoverageMetrics["perCase"][number][] = [];
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (c === undefined || r.skipped !== undefined) continue;
    if (r.claims?.ok === false && r.claims.stopped !== undefined) {
      stopped.push(r.caseId);
      continue;
    }
    if (r.claims?.ok === false) {
      hardFailed.push(r.caseId);
      failedDen += c.gold.assertions.length;
      failedRDen += c.gold.relationships.length;
      continue;
    }
    const claims = r.claims?.ok === true ? r.claims.value.map((cl) => cl.text) : [];
    const { covered, fused } = matchCoverage(c.gold.assertions, claims);
    const relCovered = c.gold.relationships.filter((rel) => relationshipCovered(rel, claims)).length;
    num += covered;
    den += c.gold.assertions.length;
    rNum += relCovered;
    rDen += c.gold.relationships.length;
    fusedTotal += fused;
    perCase.push({ caseId: r.caseId, covered, total: c.gold.assertions.length, relCovered, relTotal: c.gold.relationships.length, fused });
  }
  return {
    assertionCoverage: ratio(num, den),
    relationshipCoverage: rDen > 0 ? ratio(rNum, rDen) : null,
    assertionCoverageHardFailsAsZero: ratio(num, den + failedDen),
    relationshipCoverageHardFailsAsZero: rDen + failedRDen > 0 ? ratio(rNum, rDen + failedRDen) : null,
    fusedClaims: fusedTotal,
    hardFailedCases: hardFailed,
    stoppedCases: stopped,
    perCase,
  };
}

// -- Schema validity, retries, errors ----------------------------------------------

export interface SchemaValidity {
  /** Invocations that made at least one model call and were not stopped or cancelled: the denominator below. */
  readonly invocations: number;
  /** Finished without a model call (e.g. traceability with no candidate Units). */
  readonly deterministic: number;
  /** Failed before sending any request, for a reason other than a stop (e.g. a refused setting). */
  readonly failedBeforeRequest: number;
  /** Cancelled by the validation call pool after another call failed. */
  readonly cancelled: number;
  /** Stopped by the budget. */
  readonly budgetStopped: number;
  readonly firstAttemptPass: Ratio;
  readonly passAfterRetry: Ratio;
  readonly hardFail: Ratio;
  readonly retryRate: number | null;
  readonly errorRate: number | null;
  readonly attemptOutcomes: Readonly<Partial<Record<CallOutcome, number>>>;
  readonly hardFailKinds: Readonly<Record<string, number>>;
}

function histogram<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function schemaValidity(
  invocations: readonly InvocationRecord[],
  calls: readonly CallRecord[],
): SchemaValidity {
  const cancelled = invocations.filter((i) => stoppedKind(i) === "cancelled").length;
  const budgetStopped = invocations.filter((i) => stoppedKind(i) === "budget_reached").length;
  const live = invocations.filter((i) => stoppedKind(i) === null);
  const deterministic = live.filter((i) => i.attempts === 0 && i.ok).length;
  const failedBeforeRequest = live.filter((i) => i.attempts === 0 && !i.ok).length;
  const counted = live.filter((i) => i.attempts > 0);
  const n = counted.length;
  const ok1 = counted.filter((i) => i.ok && i.attempts === 1).length;
  const okN = counted.filter((i) => i.ok && i.attempts > 1).length;
  const bad = counted.filter((i) => !i.ok);
  const attempts = counted.reduce((s, i) => s + i.attempts, 0);
  return {
    invocations: n,
    deterministic,
    failedBeforeRequest,
    cancelled,
    budgetStopped,
    firstAttemptPass: ratio(ok1, n),
    passAfterRetry: ratio(okN, n),
    hardFail: ratio(bad.length, n),
    retryRate: n === 0 ? null : (attempts - n) / n,
    errorRate: n === 0 ? null : bad.length / n,
    attemptOutcomes: histogram(calls.map((c) => c.outcome)),
    hardFailKinds: histogram(bad.flatMap((i) => [...i.failureKinds])) as Record<string, number>,
  };
}

/** Schema validity per stage, from the given pass's records. */
export function schemaByStage(
  invocations: readonly InvocationRecord[],
  calls: readonly CallRecord[],
  stages: readonly Stage[],
): Record<string, SchemaValidity> {
  const out: Record<string, SchemaValidity> = {};
  for (const s of stages) {
    out[s] = schemaValidity(
      invocations.filter((i) => i.stage === s),
      calls.filter((c) => c.stage === s),
    );
  }
  return out;
}

// -- Traceability and specificity ----------------------------------------------------

export interface TraceabilityMetrics {
  readonly fabricationFalseAccept: ClusteredRate;
  readonly supportedFalseFlag: ClusteredRate;
  readonly wrongSupportingUnit: ClusteredRate;
  /** Unsupported assertions whose check hard-failed: never counted as caught. */
  readonly unverifiedFabrications: readonly string[];
  readonly hardFailed: number;
}

export function traceabilityMetrics(
  cases: readonly ValidationCase[],
  results: readonly CaseResult[],
): TraceabilityMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const fa: Obs[] = [], ff: Obs[] = [], wu: Obs[] = [];
  let hardFailed = 0;
  const unverified = new Set<string>();
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (c === undefined || r.skipped !== undefined) continue;
    for (const a of c.gold.assertions) {
      const v = r.traceability[a.id];
      if (v === undefined) continue;
      const unit = `${c.id}:${a.id}`;
      if (!v.ok) {
        if (v.stopped !== undefined) continue;
        hardFailed++;
        if (!a.supported) unverified.add(unit);
        continue;
      }
      if (!a.supported) {
        fa.push({ unit, hit: v.value.supports });
      } else {
        ff.push({ unit, hit: !v.value.supports });
        if (v.value.supports) {
          wu.push({
            unit,
            hit: v.value.supporting_unit_id === undefined || !a.supporting_unit_ids.includes(v.value.supporting_unit_id),
          });
        }
      }
    }
  }
  return {
    // Any accepted sample is a false acceptance: zero fabrication holds
    // across every repetition, not on most of them.
    fabricationFalseAccept: clusteredRate(fa, "any"),
    // False flags keep the majority rule: an occasional false flag on a
    // supported claim costs the user a re-check, not a fabricated claim,
    // and one noisy sample should not mark the unit as flagged.
    supportedFalseFlag: clusteredRate(ff),
    wrongSupportingUnit: clusteredRate(wu),
    unverifiedFabrications: [...unverified],
    hardFailed,
  };
}

type Obs = { readonly unit: string; readonly hit: boolean };

export interface SpecificityMetrics {
  readonly falseFlag: ClusteredRate;
  readonly miss: ClusteredRate;
  readonly hardFailed: number;
}

export function specificityMetrics(
  cases: readonly ValidationCase[],
  results: readonly CaseResult[],
): SpecificityMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const ff: Obs[] = [], miss: Obs[] = [];
  let hardFailed = 0;
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (c === undefined || r.skipped !== undefined) continue;
    for (const a of c.gold.assertions) {
      if (a.specific === null) continue;
      const v = r.specificity[a.id];
      if (v === undefined) continue;
      if (!v.ok) {
        if (v.stopped === undefined) hardFailed++;
        continue;
      }
      const unit = `${c.id}:${a.id}`;
      if (a.specific) ff.push({ unit, hit: !v.value.specific });
      else miss.push({ unit, hit: v.value.specific });
    }
  }
  return { falseFlag: clusteredRate(ff), miss: clusteredRate(miss), hardFailed };
}

/**
 * Whole-asset rates, split by WHY the gold expects the asset to fail, so
 * a specificity regression is never reported as a fabrication accepted:
 *   - `fabricationFalseAccept`: cases with an unsupported assertion that
 *     the asset passed (the zero-fabrication contract);
 *   - `specificityFalseAccept`: cases expected to fail only on
 *     specificity (every assertion supported, some not specific) that
 *     the asset passed;
 *   - `falseBlock`: cases expected to pass that the asset failed.
 */
export interface AssetMetrics {
  readonly fabricationFalseAccept: ClusteredRate;
  readonly specificityFalseAccept: ClusteredRate;
  readonly falseBlock: ClusteredRate;
  /** A thrown `validateAsset`: neither passed nor failed. */
  readonly errored: readonly string[];
  /** Stopped by the budget: left out of every denominator. */
  readonly stopped: readonly string[];
}

export function assetMetrics(cases: readonly ValidationCase[], results: readonly CaseResult[]): AssetMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const fab: Obs[] = [], spec: Obs[] = [], fb: Obs[] = [];
  const errored: string[] = [];
  const stopped: string[] = [];
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (c === undefined || r.asset === null) continue;
    if (!r.asset.ok) {
      (r.asset.stopped !== undefined ? stopped : errored).push(r.caseId);
      continue;
    }
    const passed = r.asset.value.status === "passed";
    const fabricated = c.gold.assertions.some((a) => !a.supported);
    if (fabricated) {
      fab.push({ unit: c.id, hit: passed });
    } else if (c.gold.expected_asset_status === "failed") {
      // The loader's status rule: with every assertion supported, only a
      // not-specific assertion makes the asset fail.
      spec.push({ unit: c.id, hit: passed });
    } else {
      fb.push({ unit: c.id, hit: !passed });
    }
  }
  return {
    // As in traceabilityMetrics: a case is a false acceptance when any
    // sample passed it; the other two rates keep the majority rule.
    fabricationFalseAccept: clusteredRate(fab, "any"),
    specificityFalseAccept: clusteredRate(spec),
    falseBlock: clusteredRate(fb),
    errored,
    stopped,
  };
}

// -- Generation -------------------------------------------------------------------

export interface GenerationMetrics {
  readonly runs: number;
  readonly schemaValidRate: Ratio;
  readonly firstAttemptRate: Ratio;
  readonly inventedIdRetryRate: Ratio;
  readonly requirementCoverage: Ratio;
  readonly unmatchedMustHaves: readonly string[];
  readonly expectedTraceRecall: Ratio | null;
  readonly downstreamPassRate: Ratio;
  readonly downstreamFlagCounts: Readonly<Record<string, number>>;
}

/** Requirements with at least one approved match. */
export function matchedRequirements(s: GenerationSnapshot): Set<string> {
  return new Set(s.approved_matches.map((m) => m.job_requirement_unit_id));
}

export function contentItems(content: GeneratedAssetContent): { text: string; source_unit_ids: readonly string[] }[] {
  return [content.summary, ...content.bullets, ...content.skills, ...(content.education ?? [])];
}

/** Share of matched requirements that some item grounds through an approved (unit, requirement) pair. */
export function requirementCoverage(s: GenerationSnapshot, content: GeneratedAssetContent): Ratio {
  const rm = matchedRequirements(s);
  const cited = new Set(contentItems(content).flatMap((i) => [...i.source_unit_ids]));
  let num = 0;
  for (const r of rm) {
    if (s.approved_matches.some((m) => m.job_requirement_unit_id === r && cited.has(m.experience_unit_id))) num++;
  }
  return ratio(num, rm.size);
}

export function unmatchedMustHaves(s: GenerationSnapshot): string[] {
  const rm = matchedRequirements(s);
  return s.requirements.filter((r) => r.must_have && !rm.has(r.id)).map((r) => r.id);
}

/** Share of expected traces with at least one item citing one of the trace's Units. */
export function expectedTraceRecall(
  traces: readonly { source_unit_ids: readonly string[] }[],
  content: GeneratedAssetContent,
): Ratio {
  const items = contentItems(content);
  const hit = traces.filter((t) => items.some((i) => i.source_unit_ids.some((u) => t.source_unit_ids.includes(u)))).length;
  return ratio(hit, traces.length);
}

export function generationMetrics(
  flows: readonly FlowResult[],
  snapshots: ReadonlyMap<string, { snapshot: GenerationSnapshot; traces: readonly { source_unit_ids: readonly string[] }[] | null }>,
  calls: readonly CallRecord[],
): GenerationMetrics {
  const runs = flows.filter((f) => f.skipped === undefined);
  const generated = runs.filter((f) => f.generated);
  // `calls` are one variant's records, so (snapshot, repeat) identifies a run.
  const inventedRuns = new Set(
    calls.filter((c) => c.stage === "generation" && c.outcome === "invented_id").map((c) => `${c.caseId}/${c.repeat}`),
  );
  const invented = runs.filter((f) => inventedRuns.has(`${f.snapshotId}/${f.repeat}`)).length;
  let covNum = 0, covDen = 0, trNum = 0, trDen = 0;
  let anyTraces = false;
  const unmatched = new Set<string>();
  for (const [, v] of snapshots) for (const id of unmatchedMustHaves(v.snapshot)) unmatched.add(id);
  for (const f of generated) {
    const s = snapshots.get(f.snapshotId);
    if (s === undefined || f.content === null) continue;
    const cov = requirementCoverage(s.snapshot, f.content);
    covNum += cov.num;
    covDen += cov.den;
    if (s.traces !== null) {
      anyTraces = true;
      const tr = expectedTraceRecall(s.traces, f.content);
      trNum += tr.num;
      trDen += tr.den;
    }
  }
  const completed = runs.filter((f) => f.completed);
  const passed = completed.filter((f) => f.downstream?.ok === true && f.downstream.value.status === "passed").length;
  const flagCounts: Record<string, number> = {};
  for (const f of completed) {
    if (f.downstream?.ok !== true) continue;
    for (const [k, n] of Object.entries(f.downstream.value.flagCounts)) flagCounts[k] = (flagCounts[k] ?? 0) + n;
  }
  return {
    runs: runs.length,
    schemaValidRate: ratio(generated.length, runs.length),
    firstAttemptRate: ratio(generated.filter((f) => f.attempts === 1).length, runs.length),
    inventedIdRetryRate: ratio(invented, runs.length),
    requirementCoverage: ratio(covNum, covDen),
    unmatchedMustHaves: [...unmatched].sort(),
    expectedTraceRecall: anyTraces ? ratio(trNum, trDen) : null,
    downstreamPassRate: ratio(passed, completed.length),
    downstreamFlagCounts: flagCounts,
  };
}

// -- Cost ---------------------------------------------------------------------------

export interface PerFlowCost {
  /** What one flow is: "completed flow" (generation) or "validated asset (whole-asset pass)" (validation). */
  readonly label: string;
  /** Modeled cost of the flow passes' calls (failed flows included) / completed flows; null when none completed or unpriced. */
  readonly usd: number | null;
  readonly flows: number;
}

export interface CostMetrics {
  /** Live and replayed calls; null ("unpriced") if any call could not be priced. */
  readonly modeledUsd: number | null;
  /** Modeled cost by pass, so an evaluation-only pass (isolated) is never folded into a flow cost. */
  readonly modeledByPass: Readonly<Partial<Record<CallPass, number | null>>>;
  /** Live calls only; 0 for a CLI source (unmetered), then marked estimated. */
  readonly actualUsd: number;
  readonly actualIsEstimated: boolean;
  readonly providerCache: { readonly read: number; readonly write: number };
  readonly localReplay: { readonly calls: number; readonly modeledUsd: number | null };
  readonly perFlow: PerFlowCost;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/**
 * `perFlow.passes` names the passes that make up one flow; calls of other
 * passes count in the totals but not in the per-flow figure. Generation:
 * every pass (generation + downstream). Validation: the whole-asset pass
 * only, because the isolated pass is an evaluation artifact production
 * never runs.
 */
export function costMetrics(
  calls: readonly CallRecord[],
  completedFlows: number,
  perFlow: { readonly label: string; readonly passes?: readonly CallPass[] } = { label: "completed flow" },
): CostMetrics {
  const priced = (cs: readonly CallRecord[]): number | null => sumOrNull(cs.filter((c) => c.usage !== null).map((c) => c.modeledUsd));
  const modeled = priced(calls);
  const flowCalls = perFlow.passes === undefined ? calls : calls.filter((c) => perFlow.passes!.includes(c.pass));
  const flowModeled = priced(flowCalls);
  const modeledByPass: Partial<Record<CallPass, number | null>> = {};
  for (const pass of new Set(calls.map((c) => c.pass))) modeledByPass[pass] = priced(calls.filter((c) => c.pass === pass));
  const live = calls.filter((c) => !c.replayed && c.usage !== null);
  const estimated = calls.some((c) => c.tokenFidelity === "estimated");
  const replayed = calls.filter((c) => c.replayed);
  return {
    modeledUsd: modeled,
    actualUsd: estimated ? 0 : live.reduce((s, c) => s + (c.modeledUsd ?? 0), 0),
    actualIsEstimated: estimated,
    providerCache: {
      read: calls.reduce((s, c) => s + (c.usage?.cacheReadInputTokens ?? 0), 0),
      write: calls.reduce((s, c) => s + (c.usage?.cacheCreationInputTokens ?? 0), 0),
    },
    localReplay: { calls: replayed.length, modeledUsd: sumOrNull(replayed.map((c) => c.modeledUsd)) },
    modeledByPass,
    perFlow: {
      label: perFlow.label,
      usd: flowModeled === null || completedFlows === 0 ? null : flowModeled / completedFlows,
      flows: completedFlows,
    },
  };
}

// -- Wall time -------------------------------------------------------------------------

/** Elapsed span of a set of calls: max end minus min start. Never a sum of concurrent durations. */
export function span(calls: readonly Pick<CallRecord, "startedAtMs" | "endedAtMs">[]): number | null {
  if (calls.length === 0) return null;
  return Math.max(...calls.map((c) => c.endedAtMs)) - Math.min(...calls.map((c) => c.startedAtMs));
}

export interface WallTime {
  /** Keyed `<pass>/<stage>`: the isolated pass (one gold assertion per call) and the whole-asset pass are different workloads. */
  readonly stageSpan: Readonly<Record<string, LatencyStats>>;
  readonly e2eSpan: LatencyStats | null;
  /** Keyed `<pass>/<stage>`. */
  readonly perCallLatency: Readonly<Record<string, LatencyStats>>;
}

export function wallTime(
  calls: readonly CallRecord[],
  stages: readonly Stage[],
  e2eSpans: readonly number[] | null,
): WallTime {
  const stageSpan: Record<string, LatencyStats> = {};
  const perCall: Record<string, LatencyStats> = {};
  for (const s of stages) {
    const mine = calls.filter((c) => c.stage === s && !c.replayed);
    for (const pass of [...new Set(mine.map((c) => c.pass))].sort()) {
      const inPass = mine.filter((c) => c.pass === pass);
      const groups = new Map<string, CallRecord[]>();
      for (const c of inPass) {
        const k = `${c.variant}/${c.caseId}/${c.repeat}`;
        groups.set(k, [...(groups.get(k) ?? []), c]);
      }
      const key = `${pass}/${s}`;
      stageSpan[key] = stats([...groups.values()].map((g) => span(g)).filter((v): v is number => v !== null));
      perCall[key] = stats(inPass.map((c) => c.endedAtMs - c.startedAtMs));
    }
  }
  return { stageSpan, e2eSpan: e2eSpans === null ? null : stats(e2eSpans), perCallLatency: perCall };
}

/**
 * End-to-end spans of the flows that ran live: a flow with any replayed
 * call in `passes` is left out, as replayed calls are for per-call stats.
 */
export function liveFlowSpans(
  flows: readonly { readonly variant: string; readonly caseId: string; readonly repeat: number; readonly spanMs: number | null }[],
  calls: readonly CallRecord[],
  passes: readonly CallPass[],
): number[] {
  const replayed = new Set(
    calls.filter((c) => c.replayed && passes.includes(c.pass)).map((c) => `${c.variant}/${c.caseId}/${c.repeat}`),
  );
  return flows
    .filter((f) => f.spanMs !== null && !replayed.has(`${f.variant}/${f.caseId}/${f.repeat}`))
    .map((f) => f.spanMs!);
}

// -- Variant validity ------------------------------------------------------------------

export type Validity =
  | "valid"
  | "invalid: served-model"
  | "invalid: settings-mismatch"
  | "invalid: unclassified"
  | "failed-preflight"
  | "incomplete: budget_reached"
  | "incomplete: all_failed";

/**
 * `invalid: unclassified`: some answer could not be classified (no
 * outcome schema for the module's prompt version), so the schema and
 * invented-id metrics would silently read as clean.
 * `incomplete: all_failed`: every invocation failed and no request got a
 * response (a bad key, an outage, an offline replay miss): the run
 * measured nothing.
 */
export function variantValidity(args: {
  readonly calls: readonly CallRecord[];
  readonly invocations?: readonly InvocationRecord[];
  readonly settingsMismatches: number;
  readonly preflightFailed: boolean;
  readonly budgetReached: boolean;
}): Validity {
  if (args.preflightFailed) return "failed-preflight";
  if (args.calls.some((c) => c.tokenFidelity === "metered" && c.usage !== null && (c.servedModelStatus === "missing" || c.servedModelStatus === "mismatch"))) {
    return "invalid: served-model";
  }
  if (args.settingsMismatches > 0) return "invalid: settings-mismatch";
  if (args.calls.some((c) => c.outcome === "unclassified")) return "invalid: unclassified";
  if (args.budgetReached) return "incomplete: budget_reached";
  const invs = args.invocations ?? [];
  if (invs.length > 0 && invs.every((i) => !i.ok) && args.calls.every((c) => c.usage === null)) return "incomplete: all_failed";
  return "valid";
}

