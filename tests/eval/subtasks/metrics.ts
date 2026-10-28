/**
 * Metrics for the subtask suites (#488). Pure functions; no model
 * judge. Every rate keeps its numerator and denominator so a reader can
 * see how few cases stand behind it.
 *
 * Coverage is lexical: a gold assertion is covered when ONE extracted
 * claim contains every term group of the assertion (each group satisfied
 * by any of its alternatives, after `normalize`). Paraphrases outside the
 * listed alternatives count as misses, so coverage is conservative.
 */

import type { Stage } from "../../../functions/src/llm/config.ts";
import type { GeneratedAssetContent } from "../../../functions/src/types/crm.ts";
import { stats, type LatencyStats } from "../../../scripts/latency/report.ts";

import { groupCovered, normalize, type GenerationSnapshot, type GoldAssertion, type GoldRelationship, type TermGroup, type ValidationCase } from "./fixtures.ts";
import type { CallOutcome, CallRecord, InvocationRecord } from "./instrument.ts";
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

/** True when a single text satisfies every group. */
export function coversAll(groups: readonly TermGroup[], text: string): boolean {
  return groups.every((g) => groupCovered(g, text));
}

/** Some single claim covers every required term of the assertion. */
export function assertionCovered(a: Pick<GoldAssertion, "required_terms">, claims: readonly string[]): boolean {
  return claims.some((c) => coversAll(a.required_terms, c));
}

export function relationshipCovered(r: Pick<GoldRelationship, "co_terms">, claims: readonly string[]): boolean {
  return claims.some((c) => coversAll(r.co_terms, c));
}

// -- Claim extraction ------------------------------------------------------------

export interface CoverageMetrics {
  readonly assertionCoverage: Ratio;
  readonly relationshipCoverage: Ratio | null;
  readonly hardFailedCases: readonly string[];
  readonly perCase: readonly { caseId: string; covered: number; total: number; relCovered: number; relTotal: number }[];
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
  const hardFailed: string[] = [];
  const perCase: CoverageMetrics["perCase"][number][] = [];
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (c === undefined || r.skipped !== undefined) continue;
    const claims = r.claims?.ok === true ? r.claims.value.map((cl) => cl.text) : [];
    if (r.claims?.ok === false) hardFailed.push(r.caseId);
    const covered = c.gold.assertions.filter((a) => assertionCovered(a, claims)).length;
    const relCovered = c.gold.relationships.filter((rel) => relationshipCovered(rel, claims)).length;
    num += covered;
    den += c.gold.assertions.length;
    rNum += relCovered;
    rDen += c.gold.relationships.length;
    perCase.push({ caseId: r.caseId, covered, total: c.gold.assertions.length, relCovered, relTotal: c.gold.relationships.length });
  }
  return {
    assertionCoverage: ratio(num, den),
    relationshipCoverage: rDen > 0 ? ratio(rNum, rDen) : null,
    hardFailedCases: hardFailed,
    perCase,
  };
}

// -- Schema validity, retries, errors ----------------------------------------------

export interface SchemaValidity {
  readonly invocations: number;
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
  const n = invocations.length;
  const ok1 = invocations.filter((i) => i.ok && i.attempts === 1).length;
  const okN = invocations.filter((i) => i.ok && i.attempts > 1).length;
  const bad = invocations.filter((i) => !i.ok);
  const attempts = invocations.reduce((s, i) => s + i.attempts, 0);
  return {
    invocations: n,
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
  readonly fabricationFalseAccept: Ratio;
  readonly supportedFalseFlag: Ratio;
  readonly wrongSupportingUnit: Ratio;
  /** Unsupported assertions whose check hard-failed: never counted as caught. */
  readonly unverifiedFabrications: readonly string[];
  readonly hardFailed: number;
}

export function traceabilityMetrics(
  cases: readonly ValidationCase[],
  results: readonly CaseResult[],
): TraceabilityMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  let fa = 0, faDen = 0, ff = 0, ffDen = 0, wu = 0, wuDen = 0, hardFailed = 0;
  const unverified: string[] = [];
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (c === undefined || r.skipped !== undefined) continue;
    for (const a of c.gold.assertions) {
      const v = r.traceability[a.id];
      if (v === undefined) continue;
      if (!v.ok) {
        hardFailed++;
        if (!a.supported) unverified.push(`${c.id}:${a.id}`);
        continue;
      }
      if (!a.supported) {
        faDen++;
        if (v.value.supports) fa++;
      } else {
        ffDen++;
        if (!v.value.supports) ff++;
        else {
          wuDen++;
          if (v.value.supporting_unit_id === undefined || !a.supporting_unit_ids.includes(v.value.supporting_unit_id)) wu++;
        }
      }
    }
  }
  return {
    fabricationFalseAccept: ratio(fa, faDen),
    supportedFalseFlag: ratio(ff, ffDen),
    wrongSupportingUnit: ratio(wu, wuDen),
    unverifiedFabrications: unverified,
    hardFailed,
  };
}

export interface SpecificityMetrics {
  readonly falseFlag: Ratio;
  readonly miss: Ratio;
  readonly hardFailed: number;
}

export function specificityMetrics(
  cases: readonly ValidationCase[],
  results: readonly CaseResult[],
): SpecificityMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  let ff = 0, ffDen = 0, miss = 0, missDen = 0, hardFailed = 0;
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (c === undefined || r.skipped !== undefined) continue;
    for (const a of c.gold.assertions) {
      if (a.specific === null) continue;
      const v = r.specificity[a.id];
      if (v === undefined) continue;
      if (!v.ok) {
        hardFailed++;
        continue;
      }
      if (a.specific) {
        ffDen++;
        if (!v.value.specific) ff++;
      } else {
        missDen++;
        if (v.value.specific) miss++;
      }
    }
  }
  return { falseFlag: ratio(ff, ffDen), miss: ratio(miss, missDen), hardFailed };
}

export interface AssetMetrics {
  readonly fabricationFalseAccept: Ratio;
  readonly falseBlock: Ratio;
  /** A thrown `validateAsset`: neither passed nor failed. */
  readonly errored: readonly string[];
}

export function assetMetrics(cases: readonly ValidationCase[], results: readonly CaseResult[]): AssetMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  let fa = 0, faDen = 0, fb = 0, fbDen = 0;
  const errored: string[] = [];
  for (const r of results) {
    const c = byId.get(r.caseId);
    if (c === undefined || r.asset === null) continue;
    if (!r.asset.ok) {
      errored.push(r.caseId);
      continue;
    }
    if (c.gold.expected_asset_status === "failed") {
      faDen++;
      if (r.asset.value.status === "passed") fa++;
    } else {
      fbDen++;
      if (r.asset.value.status === "failed") fb++;
    }
  }
  return { fabricationFalseAccept: ratio(fa, faDen), falseBlock: ratio(fb, fbDen), errored };
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

export interface CostMetrics {
  /** Live and replayed calls; null ("unpriced") if any call could not be priced. */
  readonly modeledUsd: number | null;
  /** Live calls only; 0 for a CLI source (unmetered), then marked estimated. */
  readonly actualUsd: number;
  readonly actualIsEstimated: boolean;
  readonly providerCache: { readonly read: number; readonly write: number };
  readonly localReplay: { readonly calls: number; readonly modeledUsd: number | null };
  /** modeled cost of every flow (failed included) / completed flows; null when none completed. */
  readonly costPerCompletedFlow: number | null;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

export function costMetrics(calls: readonly CallRecord[], completedFlows: number): CostMetrics {
  const modeled = sumOrNull(calls.filter((c) => c.usage !== null).map((c) => c.modeledUsd));
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
    costPerCompletedFlow: modeled === null || completedFlows === 0 ? null : modeled / completedFlows,
  };
}

// -- Wall time -------------------------------------------------------------------------

/** Elapsed span of a set of calls: max end minus min start. Never a sum of concurrent durations. */
export function span(calls: readonly Pick<CallRecord, "startedAtMs" | "endedAtMs">[]): number | null {
  if (calls.length === 0) return null;
  return Math.max(...calls.map((c) => c.endedAtMs)) - Math.min(...calls.map((c) => c.startedAtMs));
}

export interface WallTime {
  readonly stageSpan: Readonly<Record<string, LatencyStats>>;
  readonly e2eSpan: LatencyStats | null;
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
    const groups = new Map<string, CallRecord[]>();
    for (const c of mine) {
      const k = `${c.variant}/${c.caseId}/${c.repeat}/${c.pass}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    stageSpan[s] = stats([...groups.values()].map((g) => span(g)!).filter((v) => v !== null));
    perCall[s] = stats(mine.map((c) => c.endedAtMs - c.startedAtMs));
  }
  return { stageSpan, e2eSpan: e2eSpans === null ? null : stats(e2eSpans), perCallLatency: perCall };
}

// -- Variant validity ------------------------------------------------------------------

export type Validity =
  | "valid"
  | "invalid: served-model"
  | "invalid: settings-mismatch"
  | "failed-preflight"
  | "incomplete: budget_reached";

export function variantValidity(args: {
  readonly calls: readonly CallRecord[];
  readonly settingsMismatches: number;
  readonly preflightFailed: boolean;
  readonly budgetReached: boolean;
}): Validity {
  if (args.preflightFailed) return "failed-preflight";
  if (args.calls.some((c) => c.tokenFidelity === "metered" && c.usage !== null && (c.servedModelStatus === "missing" || c.servedModelStatus === "mismatch"))) {
    return "invalid: served-model";
  }
  if (args.settingsMismatches > 0) return "invalid: settings-mismatch";
  if (args.budgetReached) return "incomplete: budget_reached";
  return "valid";
}

