import { describe, expect, it } from "vitest";

import type { ValidationCase } from "./fixtures.ts";
import { loadGenerationSnapshots } from "./fixtures.ts";
import type { CallRecord, InvocationRecord } from "./instrument.ts";
import {
  assertionCovered,
  assetMetrics,
  costMetrics,
  coverageMetrics,
  expectedTraceRecall,
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
} from "./metrics.ts";
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
  return { caseId: "vc-01-x", category: "c", repeat: 0, claims: null, traceability: {}, specificity: {}, asset: null, ...partial };
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

  it("counts a hard-failed extraction as all uncovered and lists it", () => {
    const c = goldCase([A("alpha", true, true), A("beta", true, true)]);
    const m = coverageMetrics([c], [result({ claims: err })]);
    expect(m.assertionCoverage).toEqual({ num: 0, den: 2, value: 0 });
    expect(m.hardFailedCases).toEqual(["vc-01-x"]);
    expect(m.relationshipCoverage).toBeNull();
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
    expect(m.fabricationFalseAccept).toEqual({ num: 1, den: 2, value: 0.5 });
    expect(m.supportedFalseFlag).toEqual({ num: 1, den: 2, value: 0.5 });
    expect(m.wrongSupportingUnit).toEqual({ num: 1, den: 1, value: 1 });
  });

  it("lists a hard-failed fabrication as unverified, outside the denominator", () => {
    const r = result({ traceability: { a1: err, a2: ok({ supports: false, rationale: "" }) } });
    const m = traceabilityMetrics([c], [r]);
    expect(m.unverifiedFabrications).toEqual(["vc-01-x:a1"]);
    expect(m.fabricationFalseAccept).toEqual({ num: 0, den: 1, value: 0 });
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
    expect(m.falseFlag).toEqual({ num: 1, den: 1, value: 1 });
    expect(m.miss).toEqual({ num: 1, den: 2, value: 0.5 });
  });
});

describe("asset level", () => {
  it("computes false accept and false block, and never counts an errored case", () => {
    const failed = { ...goldCase([A("a", false, null)], "failed"), id: "f" } as ValidationCase;
    const passed = { ...goldCase([A("a", true, true)], "passed"), id: "p" } as ValidationCase;
    const broken = { ...goldCase([A("a", true, true)], "passed"), id: "e" } as ValidationCase;
    const m = assetMetrics([failed, passed, broken], [
      result({ caseId: "f", asset: ok({ status: "passed", flagCounts: {} }) }),
      result({ caseId: "p", asset: ok({ status: "failed", flagCounts: {} }) }),
      result({ caseId: "e", asset: err }),
    ]);
    expect(m.fabricationFalseAccept).toEqual({ num: 1, den: 1, value: 1 });
    expect(m.falseBlock).toEqual({ num: 1, den: 1, value: 1 });
    expect(m.errored).toEqual(["e"]);
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
    expect(costMetrics(calls, 2).costPerCompletedFlow).toBeCloseTo(0.3);
    expect(costMetrics(calls, 0).costPerCompletedFlow).toBeNull();
  });

  it("reports an unpriced call as null, never 0", () => {
    const m = costMetrics([call({ modeledUsd: 0.1 }), call({ modeledUsd: null })], 1);
    expect(m.modeledUsd).toBeNull();
    expect(m.costPerCompletedFlow).toBeNull();
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
    expect(w.stageSpan.traceability).toMatchObject({ n: 1, p50Ms: 150 });
    expect(w.perCallLatency.traceability).toMatchObject({ n: 2, p50Ms: 100 });
    expect(w.e2eSpan).toMatchObject({ n: 2, p50Ms: 400, p95Ms: 600 });
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
});
