import { describe, expect, it } from "vitest";

import type { ValidationCase } from "./fixtures.ts";
import { loadGenerationSnapshots, loadValidationCases } from "./fixtures.ts";
import type { CallRecord, InvocationRecord } from "./instrument.ts";
import {
  assertionCovered,
  assetMetrics,
  clusteredRate,
  costMetrics,
  coverageMetrics,
  expectedTraceRecall,
  liveFlowSpans,
  matchCoverage,
  normalize,
  relationshipCovered,
  requirementCoverage,
  schemaValidity,
  span,
  specificityMetrics,
  traceabilityMetrics,
  unmatchedMustHaves,
  variantValidity,
  wallTime,
  wilson,
} from "./metrics.ts";
import { rate } from "./report.ts";
import type { CaseResult } from "./suites.ts";

const A = (id: string, supported: boolean, specific: boolean | null, supporting: string[] = supported ? ["u1"] : []) => ({
  id,
  text: id,
  required_terms: [id],
  supported,
  supporting_unit_ids: supporting,
  specific,
});

function goldCase(assertions: ReturnType<typeof A>[], status: "passed" | "failed" = "failed"): ValidationCase {
  return {
    id: "vc-01-x",
    gold: { assertions, relationships: [], expected_asset_status: status },
  } as unknown as ValidationCase;
}

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = { ok: false as const, error: "boom" };

function result(partial: Partial<CaseResult>): CaseResult {
  return { caseId: "vc-01-x", category: "c", repeat: 0, claims: null, traceability: {}, specificity: {}, asset: null, assetSpanMs: null, ...partial };
}

function call(p: Partial<CallRecord>): CallRecord {
  return {
    runId: "r", attemptId: "a", suite: "validation", pass: "isolated", variant: "v", caseId: "c", repeat: 0, stage: "traceability",
    invocationId: "i", attemptIndex: 0, requestedModel: "claude-sonnet-4-6", servedModel: "claude-sonnet-4-6", servedModelStatus: "ok",
    maxTokens: 1024, toolChoice: "forced", effort: null, requestKey: "k", startedAtMs: 0, endedAtMs: 100, outcome: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, replayed: false,
    replayedFromRunId: null, tokenFidelity: "metered", modeledUsd: 0.01, ...p,
  };
}

function inv(p: Partial<InvocationRecord>): InvocationRecord {
  return { invocationId: "i", stage: "traceability", pass: "isolated", variant: "v", caseId: "c", repeat: 0, ok: true, attempts: 1, failureKinds: [], startedAtMs: 0, endedAtMs: 1, ...p };
}

describe("normalize and coverage", () => {
  it("folds en-dashes and curly quotes", () => {
    expect(normalize("Cut p99 – by “60%” it’s")).toBe('cut p99 - by "60%" it\'s');
  });

  it("covers an assertion only when one claim carries every group", () => {
    const a = { required_terms: [["$10K", "$10,000"], "MRR"] };
    expect(assertionCovered(a, ["Reached $10,000 MRR in seven months"])).toBe(true);
    expect(assertionCovered(a, ["Reached $10,000 ARR"])).toBe(false);
    expect(assertionCovered(a, ["Reached $10,000", "Grew MRR"])).toBe(false);
  });

  it("does not cover a relationship split across claims", () => {
    const r = { co_terms: [["precoder"], ["38%"]] };
    expect(relationshipCovered(r, ["The precoder filter", "cut mismatch 38%"])).toBe(false);
    expect(relationshipCovered(r, ["The precoder filter cut mismatch 38%"])).toBe(true);
  });

  it("leaves a hard-failed extraction out of the headline coverage and lists it", () => {
    const c = goldCase([A("alpha", true, true), A("beta", true, true)]);
    const m = coverageMetrics([c], [result({ claims: err })]);
    expect(m.assertionCoverage).toEqual({ num: 0, den: 0, value: null });
    expect(m.hardFailedCases).toEqual(["vc-01-x"]);
    expect(m.relationshipCoverage).toBeNull();
    expect(m.perCase).toEqual([]);
    // The end-to-end figure scores the failure as zero, on its own field.
    expect(m.assertionCoverageHardFailsAsZero).toEqual({ num: 0, den: 2, value: 0 });
  });

  it("keeps coverage of perfect extractions at 100% when other cases fail the schema", () => {
    // 14 cases, 3 of which hard-fail: the headline must not read as 78%.
    const cases = Array.from({ length: 14 }, (_, i) => ({
      ...goldCase([A(`alpha${i}`, true, true), A(`beta${i}`, true, true)]),
      id: `vc-${i}`,
      gold: {
        assertions: [A(`alpha${i}`, true, true), A(`beta${i}`, true, true)],
        relationships: [{ co_terms: [[`alpha${i}`], [`beta${i}`]] }],
        expected_asset_status: "passed",
      },
    })) as unknown as ValidationCase[];
    const failing = new Set(["vc-0", "vc-1", "vc-2"]);
    const results = cases.map((c, i) =>
      failing.has(c.id)
        ? result({ caseId: c.id, claims: err })
        : result({ caseId: c.id, claims: ok([{ id: "x", bullet_id: "b", text: `alpha${i} with beta${i}` }, { id: "y", bullet_id: "b", text: `beta${i}` }]) }),
    );
    const m = coverageMetrics(cases, results);
    expect(m.assertionCoverage).toEqual({ num: 22, den: 22, value: 1 });
    expect(m.relationshipCoverage).toEqual({ num: 11, den: 11, value: 1 });
    expect(m.hardFailedCases).toEqual(["vc-0", "vc-1", "vc-2"]);
    expect(m.perCase.map((p) => p.caseId)).not.toContain("vc-0");
    expect(m.assertionCoverageHardFailsAsZero).toEqual({ num: 22, den: 28, value: 22 / 28 });
    expect(m.relationshipCoverageHardFailsAsZero).toEqual({ num: 11, den: 14, value: 11 / 14 });
  });

  it("leaves a budget-stopped extraction out of the denominator", () => {
    const c = goldCase([A("alpha", true, true), A("beta", true, true)]);
    const m = coverageMetrics([c], [result({ claims: { ...err, stopped: "budget_reached" } })]);
    expect(m.assertionCoverage).toEqual({ num: 0, den: 0, value: null });
    expect(m.hardFailedCases).toEqual([]);
    expect(m.stoppedCases).toEqual(["vc-01-x"]);
  });

  it("credits each claim to at most one assertion, and counts fused claims", () => {
    const as = [{ required_terms: ["alpha"] }, { required_terms: ["beta"] }, { required_terms: ["gamma"] }];
    expect(matchCoverage(as, ["alpha beta gamma"])).toEqual({ covered: 1, fused: 1 });
    expect(matchCoverage(as, ["alpha", "beta", "gamma"])).toEqual({ covered: 3, fused: 0 });
    // An augmenting path: the fused claim moves to the assertion no other claim covers.
    expect(matchCoverage(as, ["alpha beta", "alpha", "gamma"])).toEqual({ covered: 3, fused: 1 });
    expect(matchCoverage(as, [])).toEqual({ covered: 0, fused: 0 });
  });

  it("scores an extractor that repeats the whole item as 1/|A| per case, not full coverage", () => {
    const real = loadValidationCases().items.map((i) => i.case);
    const results = real.map((c) =>
      result({ caseId: c.id, claims: ok([{ id: "x", bullet_id: c.item.id, text: c.item.text }]) }),
    );
    const m = coverageMetrics(real, results);
    const total = real.reduce((s, c) => s + c.gold.assertions.length, 0);
    expect(m.assertionCoverage).toEqual({ num: real.length, den: total, value: real.length / total });
    for (const p of m.perCase) expect(p.covered, p.caseId).toBe(1);
    expect(m.fusedClaims).toBe(real.filter((c) => c.gold.assertions.length >= 2).length);
  });
});

describe("clustered rates", () => {
  it("computes a Wilson 95% interval", () => {
    expect(wilson(0, 0)).toBeNull();
    const w = wilson(0, 4)!;
    expect(w.low).toBe(0);
    expect(w.high).toBeCloseTo(0.4899, 3);
    const h = wilson(5, 10)!;
    expect(h.low).toBeCloseTo(0.2366, 3);
    expect(h.high).toBeCloseTo(0.7634, 3);
  });

  it("counts a unit once by majority, a tie against the model", () => {
    const r = clusteredRate([
      { unit: "a", hit: true }, { unit: "a", hit: false }, // tie -> hit
      { unit: "b", hit: false }, { unit: "b", hit: false }, { unit: "b", hit: true }, // 1/3 -> no hit
    ]);
    expect(r.units).toEqual({ num: 1, den: 2, value: 0.5 });
    expect(r.samples).toEqual({ num: 2, den: 5, value: 0.4 });
  });

  it("does not shrink the interval when samples=3 repeats samples=1's verdicts", () => {
    const c = goldCase([A("a1", false, null), A("a2", false, null), A("a3", false, null), A("a4", false, null)]);
    const verdicts = { a1: ok({ supports: false, rationale: "" }), a2: ok({ supports: false, rationale: "" }), a3: ok({ supports: true, supporting_unit_id: "u1", rationale: "" }), a4: ok({ supports: false, rationale: "" }) };
    const one = traceabilityMetrics([c], [result({ traceability: verdicts })]).fabricationFalseAccept;
    const three = traceabilityMetrics([c], [0, 1, 2].map((repeat) => result({ repeat, traceability: verdicts }))).fabricationFalseAccept;
    expect(three.units).toEqual(one.units);
    expect(three.interval).toEqual(one.interval);
    expect(one.units).toEqual({ num: 1, den: 4, value: 0.25 });
    expect(three.samples).toEqual({ num: 3, den: 12, value: 0.25 });
  });
});

describe("fabrication false acceptance counts any accepted sample (#488 review)", () => {
  const accept = ok({ supports: true, supporting_unit_id: "u1", rationale: "" });
  const reject = ok({ supports: false, rationale: "" });
  const fab = goldCase([A("a1", false, null)], "failed");
  const sup = goldCase([A("s1", true, true)], "passed");
  const asset = (status: "passed" | "failed") => ok({ status, flagCounts: {} });

  it("rule 'any' marks a unit hit by one sample; 'majority' does not", () => {
    const obs = [{ unit: "a", hit: true }, { unit: "a", hit: false }, { unit: "a", hit: false }];
    expect(clusteredRate(obs, "any").units).toEqual({ num: 1, den: 1, value: 1 });
    expect(clusteredRate(obs).units).toEqual({ num: 0, den: 1, value: 0 });
  });

  it("reports a fabrication accepted once in three samples as a false acceptance (traceability and asset)", () => {
    const results = [true, false, false].map((accepted, repeat) =>
      result({ repeat, traceability: { a1: accepted ? accept : reject }, asset: asset(accepted ? "passed" : "failed") }),
    );
    const t = traceabilityMetrics([fab], results).fabricationFalseAccept;
    expect(t.units).toEqual({ num: 1, den: 1, value: 1 });
    expect(t.samples).toEqual({ num: 1, den: 3, value: 1 / 3 });
    expect(rate(t, "assertions")).toMatch(/^100\.0% \(1\/1 assertions/);
    const a = assetMetrics([fab], results).fabricationFalseAccept;
    expect(a.units).toEqual({ num: 1, den: 1, value: 1 });
    expect(a.samples).toEqual({ num: 1, den: 3, value: 1 / 3 });
  });

  it("keeps a fabrication rejected in all three samples at zero", () => {
    const results = [0, 1, 2].map((repeat) => result({ repeat, traceability: { a1: reject }, asset: asset("failed") }));
    expect(traceabilityMetrics([fab], results).fabricationFalseAccept.units).toEqual({ num: 0, den: 1, value: 0 });
    expect(assetMetrics([fab], results).fabricationFalseAccept.units).toEqual({ num: 0, den: 1, value: 0 });
  });

  it("keeps the false-flag rates on the majority rule", () => {
    // One of three samples flags a supported claim, or blocks a passing asset: not a flagged unit.
    const results = [true, false, false].map((flagged, repeat) =>
      result({ caseId: sup.id, repeat, traceability: { s1: flagged ? reject : accept }, asset: asset(flagged ? "failed" : "passed") }),
    );
    expect(traceabilityMetrics([sup], results).supportedFalseFlag.units).toEqual({ num: 0, den: 1, value: 0 });
    expect(assetMetrics([sup], results).falseBlock.units).toEqual({ num: 0, den: 1, value: 0 });
    // Two of three is a majority.
    const two = [true, true, false].map((flagged, repeat) =>
      result({ caseId: sup.id, repeat, traceability: { s1: flagged ? reject : accept }, asset: asset(flagged ? "failed" : "passed") }),
    );
    expect(traceabilityMetrics([sup], two).supportedFalseFlag.units).toEqual({ num: 1, den: 1, value: 1 });
    expect(assetMetrics([sup], two).falseBlock.units).toEqual({ num: 1, den: 1, value: 1 });
  });
});

describe("traceability and specificity", () => {
  const c = goldCase([A("a1", false, null), A("a2", false, null), A("a3", true, true), A("a4", true, true)]);

  it("computes false accept, false flag and wrong supporting Unit exactly", () => {
    const r = result({
      traceability: {
        a1: ok({ supports: true, supporting_unit_id: "u1", rationale: "" }),
        a2: ok({ supports: false, rationale: "" }),
        a3: ok({ supports: false, rationale: "" }),
        a4: ok({ supports: true, supporting_unit_id: "u9", rationale: "" }),
      },
    });
    const m = traceabilityMetrics([c], [r]);
    expect(m.fabricationFalseAccept.units).toEqual({ num: 1, den: 2, value: 0.5 });
    expect(m.supportedFalseFlag.units).toEqual({ num: 1, den: 2, value: 0.5 });
    expect(m.wrongSupportingUnit.units).toEqual({ num: 1, den: 1, value: 1 });
  });

  it("lists a hard-failed fabrication as unverified, outside the denominator", () => {
    const r = result({ traceability: { a1: err, a2: ok({ supports: false, rationale: "" }) } });
    const m = traceabilityMetrics([c], [r]);
    expect(m.unverifiedFabrications).toEqual(["vc-01-x:a1"]);
    expect(m.fabricationFalseAccept.units).toEqual({ num: 0, den: 1, value: 0 });
  });

  it("leaves a budget-stopped check out: neither counted nor unverified", () => {
    const r = result({ traceability: { a1: { ...err, stopped: "budget_reached" }, a2: ok({ supports: false, rationale: "" }) } });
    const m = traceabilityMetrics([c], [r]);
    expect(m.unverifiedFabrications).toEqual([]);
    expect(m.hardFailed).toBe(0);
    expect(m.fabricationFalseAccept.units).toEqual({ num: 0, den: 1, value: 0 });
  });

  it("computes specificity false flag and miss", () => {
    const s = goldCase([A("s1", true, true), A("s2", true, false), A("s3", true, false), A("s4", true, null)]);
    const r = result({
      specificity: {
        s1: ok({ specific: false, rationale: "" }),
        s2: ok({ specific: true, rationale: "" }),
        s3: ok({ specific: false, rationale: "" }),
      },
    });
    const m = specificityMetrics([s], [r]);
    expect(m.falseFlag.units).toEqual({ num: 1, den: 1, value: 1 });
    expect(m.miss.units).toEqual({ num: 1, den: 2, value: 0.5 });
  });
});

describe("asset level", () => {
  it("computes false accept and false block, and never counts an errored or stopped case", () => {
    const failed = { ...goldCase([A("a", false, null)], "failed"), id: "f" } as ValidationCase;
    const vague = { ...goldCase([A("a", true, false)], "failed"), id: "v" } as ValidationCase;
    const passed = { ...goldCase([A("a", true, true)], "passed"), id: "p" } as ValidationCase;
    const broken = { ...goldCase([A("a", true, true)], "passed"), id: "e" } as ValidationCase;
    const stopped = { ...goldCase([A("a", false, null)], "failed"), id: "s" } as ValidationCase;
    const m = assetMetrics([failed, vague, passed, broken, stopped], [
      result({ caseId: "f", asset: ok({ status: "passed", flagCounts: {} }) }),
      result({ caseId: "v", asset: ok({ status: "failed", flagCounts: {} }) }),
      result({ caseId: "p", asset: ok({ status: "failed", flagCounts: {} }) }),
      result({ caseId: "e", asset: err }),
      result({ caseId: "s", asset: { ...err, stopped: "budget_reached" } }),
    ]);
    expect(m.fabricationFalseAccept.units).toEqual({ num: 1, den: 1, value: 1 });
    expect(m.specificityFalseAccept.units).toEqual({ num: 0, den: 1, value: 0 });
    expect(m.falseBlock.units).toEqual({ num: 1, den: 1, value: 1 });
    expect(m.errored).toEqual(["e"]);
    expect(m.stopped).toEqual(["s"]);
  });

  it("reports vc-10 passing as a specificity false accept, never a fabrication false accept", () => {
    const real = loadValidationCases().items.map((i) => i.case);
    const results = real.map((c) =>
      result({
        caseId: c.id,
        // A validator that catches every fabrication but misses vc-10's vagueness.
        asset: ok({ status: c.id.startsWith("vc-10-") ? "passed" : c.gold.expected_asset_status, flagCounts: {} }),
      }),
    );
    const m = assetMetrics(real, results);
    expect(m.fabricationFalseAccept.units).toEqual({ num: 0, den: 11, value: 0 });
    expect(m.specificityFalseAccept.units).toEqual({ num: 1, den: 1, value: 1 });
    expect(m.falseBlock.units.num).toBe(0);
  });
});

describe("schema validity, retries and errors", () => {
  it("buckets invocations and computes retry and error rates", () => {
    const invs = [inv({ attempts: 1 }), inv({ attempts: 3 }), inv({ attempts: 2, ok: false, failureKinds: ["schema_error", "schema_error"] })];
    const calls = [call({ outcome: "tool_use" }), call({ outcome: "schema_error" }), call({ outcome: "no_tool_use" }), call({ outcome: "tool_use" })];
    const m = schemaValidity(invs, calls);
    expect(m.firstAttemptPass.num).toBe(1);
    expect(m.passAfterRetry.num).toBe(1);
    expect(m.hardFail.num).toBe(1);
    expect(m.retryRate).toBeCloseTo(1); // (6 - 3) / 3
    expect(m.errorRate).toBeCloseTo(1 / 3);
    expect(m.attemptOutcomes).toEqual({ tool_use: 2, schema_error: 1, no_tool_use: 1 });
    expect(m.hardFailKinds).toEqual({ schema_error: 2 });
  });

  it("keeps a no-call invocation out of every rate, so the buckets still sum to 1", () => {
    const m = schemaValidity([inv({ attempts: 0 }), inv({ attempts: 2 })], []);
    expect(m.invocations).toBe(1);
    expect(m.deterministic).toBe(1);
    expect(m.retryRate).toBe(1);
    expect(m.firstAttemptPass.num + m.passAfterRetry.num + m.hardFail.num).toBe(m.invocations);
  });

  it("counts cancelled and budget-stopped invocations apart from hard failures", () => {
    const m = schemaValidity(
      [
        inv({ attempts: 1, ok: false, failureKinds: ["no_tool_use"] }),
        inv({ attempts: 1, ok: false, failureKinds: ["cancelled"] }),
        inv({ attempts: 1, ok: false, failureKinds: ["cancelled"] }),
        inv({ attempts: 0, ok: false, failureKinds: ["budget_reached"] }),
        inv({ attempts: 1 }),
      ],
      [],
    );
    expect(m.invocations).toBe(2);
    expect(m.hardFail).toEqual({ num: 1, den: 2, value: 0.5 });
    expect(m.errorRate).toBeCloseTo(0.5);
    expect(m.cancelled).toBe(2);
    expect(m.budgetStopped).toBe(1);
    expect(m.hardFailKinds).toEqual({ no_tool_use: 1 });
  });
});

describe("generation", () => {
  const sparse = loadGenerationSnapshots({ ids: ["gs-sparse-sofia-openai"] }).items[0]!.snapshot;
  const content = (ids: string[]) => ({
    summary: { id: "s", text: "x", source_unit_ids: ids },
    bullets: [],
    skills: [],
  });

  it("covers 3 of 5 matched requirements when only u_threadline_mvp is cited, and lists unmatched must-haves", () => {
    expect(requirementCoverage(sparse, content(["u_threadline_mvp"]))).toEqual({ num: 3, den: 5, value: 0.6 });
    expect(unmatchedMustHaves(sparse).sort()).toEqual(["r_9yr_eng", "r_reliability_safety_perf"]);
  });

  it("counts an expected trace as recalled when any item shares a Unit with it", () => {
    const traces = [{ source_unit_ids: ["u_a", "u_b"] }, { source_unit_ids: ["u_c"] }];
    expect(expectedTraceRecall(traces, content(["u_b"]))).toEqual({ num: 1, den: 2, value: 0.5 });
  });
});

describe("cost", () => {
  it("divides all modeled cost, failed flows included, by completed flows", () => {
    const calls = [call({ modeledUsd: 0.1 }), call({ modeledUsd: 0.2 }), call({ modeledUsd: 0.3 })];
    expect(costMetrics(calls, 2).perFlow.usd).toBeCloseTo(0.3);
    expect(costMetrics(calls, 0).perFlow.usd).toBeNull();
  });

  it("counts only the flow passes per validated asset and reports the isolated pass apart", () => {
    const calls = [call({ pass: "isolated", modeledUsd: 0.4 }), call({ pass: "whole_asset", modeledUsd: 0.2 }), call({ pass: "whole_asset", modeledUsd: 0.1 })];
    const m = costMetrics(calls, 1, { label: "validated asset (whole-asset pass)", passes: ["whole_asset"] });
    expect(m.perFlow).toMatchObject({ label: "validated asset (whole-asset pass)", flows: 1 });
    expect(m.perFlow.usd).toBeCloseTo(0.3);
    expect(m.modeledByPass.isolated).toBeCloseTo(0.4);
    expect(m.modeledUsd).toBeCloseTo(0.7);
  });

  it("reports an unpriced call as null, never 0", () => {
    const m = costMetrics([call({ modeledUsd: 0.1 }), call({ modeledUsd: null })], 1);
    expect(m.modeledUsd).toBeNull();
    expect(m.perFlow.usd).toBeNull();
  });

  it("separates actual (live) from modeled (live + replayed) and shows local replay and provider cache", () => {
    const m = costMetrics(
      [
        call({ modeledUsd: 0.1, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 50, cacheCreationInputTokens: 7 } }),
        call({ modeledUsd: 0.2, replayed: true, replayedFromRunId: "old" }),
      ],
      1,
    );
    expect(m.actualUsd).toBeCloseTo(0.1);
    expect(m.modeledUsd).toBeCloseTo(0.3);
    expect(m.localReplay).toEqual({ calls: 1, modeledUsd: 0.2 });
    expect(m.providerCache).toEqual({ read: 50, write: 7 });
  });
});

describe("wall time", () => {
  it("measures a span, not a sum of concurrent calls", () => {
    expect(span([{ startedAtMs: 0, endedAtMs: 100 }, { startedAtMs: 50, endedAtMs: 150 }])).toBe(150);
    const w = wallTime([call({ startedAtMs: 0, endedAtMs: 100 }), call({ startedAtMs: 50, endedAtMs: 150 })], ["traceability"], [400, 600]);
    expect(w.stageSpan["isolated/traceability"]).toMatchObject({ n: 1, p50Ms: 150 });
    expect(w.perCallLatency["isolated/traceability"]).toMatchObject({ n: 2, p50Ms: 100 });
    expect(w.e2eSpan).toMatchObject({ n: 2, p50Ms: 400, p95Ms: 600 });
  });

  it("keeps the isolated and whole-asset passes apart", () => {
    const w = wallTime(
      [call({ pass: "isolated", startedAtMs: 0, endedAtMs: 100 }), call({ pass: "whole_asset", startedAtMs: 0, endedAtMs: 900 })],
      ["traceability"],
      null,
    );
    expect(w.stageSpan["isolated/traceability"]).toMatchObject({ n: 1, p50Ms: 100 });
    expect(w.stageSpan["whole_asset/traceability"]).toMatchObject({ n: 1, p50Ms: 900 });
    expect(w.stageSpan.traceability).toBeUndefined();
  });

  it("leaves a flow with a replayed call out of the end-to-end spans", () => {
    const flows = [
      { variant: "v", caseId: "a", repeat: 0, spanMs: 100 },
      { variant: "v", caseId: "b", repeat: 0, spanMs: 200 },
      { variant: "v", caseId: "c", repeat: 0, spanMs: null },
    ];
    const calls = [call({ caseId: "b", pass: "whole_asset", replayed: true }), call({ caseId: "a", pass: "isolated", replayed: true })];
    expect(liveFlowSpans(flows, calls, ["whole_asset"])).toEqual([100]);
  });
});

describe("variant validity", () => {
  it("is invalid on api when a served model is missing, never for that reason on the CLI", () => {
    const base = { settingsMismatches: 0, preflightFailed: false, budgetReached: false };
    expect(variantValidity({ ...base, calls: [call({ servedModelStatus: "missing", servedModel: null })] })).toBe("invalid: served-model");
    expect(variantValidity({ ...base, calls: [call({ servedModelStatus: "cli-asserted", tokenFidelity: "estimated" })] })).toBe("valid");
    expect(variantValidity({ ...base, calls: [], settingsMismatches: 1 })).toBe("invalid: settings-mismatch");
    expect(variantValidity({ ...base, calls: [], budgetReached: true })).toBe("incomplete: budget_reached");
  });

  it("is invalid when any answer could not be classified", () => {
    const base = { settingsMismatches: 0, preflightFailed: false, budgetReached: false };
    expect(variantValidity({ ...base, calls: [call({ outcome: "unclassified" })] })).toBe("invalid: unclassified");
  });

  it("is incomplete when every invocation failed and no request got a response", () => {
    const base = { settingsMismatches: 0, preflightFailed: false, budgetReached: false };
    const failedInv = inv({ ok: false, attempts: 3, failureKinds: ["transport_error", "transport_error", "transport_error"] });
    const noResponse = call({ outcome: "transport_error", usage: null, servedModel: null, servedModelStatus: "missing" });
    expect(variantValidity({ ...base, calls: [noResponse], invocations: [failedInv] })).toBe("incomplete: all_failed");
    // A schema failure got a response: that is a measurement, not a run that measured nothing.
    expect(variantValidity({ ...base, calls: [call({ outcome: "schema_error" })], invocations: [failedInv] })).toBe("valid");
    expect(variantValidity({ ...base, calls: [noResponse], invocations: [failedInv, inv({})] })).toBe("valid");
  });
});
