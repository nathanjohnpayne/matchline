import { describe, expect, it } from "vitest";

import { priceUsage, type UsageRecord } from "../../../functions/src/llm/cost.ts";
import type { FlowRecord, RecordedCall } from "../flowRecord.ts";

import { analyzeRecords, formatAnalysisMarkdown, type AnalysisLabels } from "./analyzeRecords.ts";

const GOOD = { raw_text: "SECRET-UNIT-TEXT Led the Kepler launch", normalized_summary: "led kepler launch", skills: ["a"] };
const MID = { raw_text: "Led Kepler", normalized_summary: "led kepler", skills: [] }; // 0.6
const BAD = { raw_text: "Invented", normalized_summary: "zzz qqq", skills: [] }; // 0

const LABELS: AnalysisLabels = {
  units: new Map([
    ["r1", { expectedUnits: [{ id: "u", normalized_summary: "led kepler launch", skills: ["a"] }], resumeText: "- Led Kepler\n- SECRET-UNIT-TEXT Led the Kepler launch" }],
    ["r2", { expectedUnits: [{ id: "u", normalized_summary: "led kepler launch", skills: ["a"] }], resumeText: "nothing" }],
  ]),
  requirements: new Map([
    ["r1__j1", { expectedRequirements: [{ id: "q", text: "kubernetes experience", must_have: true, category: "c" }] }],
    ["r2__j1", { expectedRequirements: [{ id: "q", text: "kubernetes experience", must_have: true, category: "c" }] }],
  ]),
};

const call = (over: Partial<RecordedCall> = {}): RecordedCall => ({
  step: "extraction",
  replayed: false,
  stage: "extraction",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  latencyMs: 1000,
  inputTokens: 1000,
  outputTokens: 500,
  attempt: 0,
  maxTokens: 16000,
  truncated: false,
  retry: false,
  refusal: false,
  ...over,
});

let seq = 0;
function flow(variant: string, resume: string, units: object[] | null, over: Partial<FlowRecord> = {}): FlowRecord {
  seq += 1;
  return {
    schemaVersion: 1,
    invocationId: "inv-a",
    variant,
    stages: { extraction: { model: "m" } } as never,
    embeddingModel: "text-embedding-3-small",
    resumeId: resume,
    jdId: "j1",
    cell: `${resume}__j1`,
    sampleIndex: seq,
    startedAt: `2026-10-28T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    finishedAt: "2026-10-28T00:01:00.000Z",
    latencyMs: 1,
    ok: true,
    error: null,
    extractionAccuracy: 0,
    matchAccuracy: 0.5,
    extractedUnitCount: units?.length ?? null,
    parsedRequirementCount: 1,
    parsedMustHaveCount: 1,
    matchCount: 1,
    cacheHits: 0,
    cacheMisses: 4,
    stepCacheHits: {},
    calls: [call()],
    failures: null,
    units: units as FlowRecord["units"],
    requirements: [{ normalized_requirement: "kubernetes experience", must_have: true }],
    costUsd: 0,
    modeledCostUsd: 0.01,
    ...over,
  };
}

function corpus(): FlowRecord[] {
  seq = 0;
  return [
    // Incumbent: r1 three flows at 1.0, r2 one flow at 0 → equal-cell mean 0.5.
    flow("inc", "r1", [GOOD]),
    flow("inc", "r1", [GOOD], { invocationId: "inv-b" }),
    flow("inc", "r1", [GOOD], {
      calls: [call({ attempt: 1, retry: true, latencyMs: 3000 }), call({ replayed: true, attempt: 2, retry: true, latencyMs: 99_999 })],
    }),
    flow("inc", "r2", [BAD]),
    flow("inc", "r2", null, {
      ok: false,
      error: { kind: "refusal", name: "ExtractionError", message: "declined", step: "extraction" },
      calls: [call({ refusal: true })],
    }),
    // Candidate: r1 at 0.6 (behind), r2 at 1.0 (ahead).
    flow("cand", "r1", [MID], { invocationId: "inv-c" }),
    flow("cand", "r1", [MID], { invocationId: "inv-c" }),
    flow("cand", "r2", [GOOD], {
      invocationId: "inv-c",
      calls: [call({ outputTokens: 16000, truncated: true }), call({ step: "unit_embedding", stage: "embedding", provider: "openai", model: "not-a-priced-model", latencyMs: 50 })],
    }),
    flow("cand", "r2", [GOOD], { invocationId: "inv-c" }),
  ];
}

describe("analyzeRecords", () => {
  const result = analyzeRecords(corpus(), { task: "extraction", incumbent: "inc", labels: LABELS, resamples: 2000 });
  const inc = result.arms[0]!;
  const cand = result.arms[1]!;

  it("pools an arm across invocations and counts failures and refusals", () => {
    expect(result.candidates).toEqual(["cand"]);
    expect(inc).toMatchObject({ label: "inc", flows: 5, failedFlows: 1, refusals: 1, errorKinds: { refusal: 1 } });
    expect(inc.invocations).toEqual(["inv-a", "inv-b"]);
    expect(result.invocations).toEqual(["inv-a", "inv-b", "inv-c"]);
  });

  it("counts retries, truncations and refusals over live records only", () => {
    // inc live records: 1 + 1 + 1 (retry) + 1 + 1 (refusal) = 5; one replayed.
    expect(inc).toMatchObject({ records: 5, replayedRecords: 1, truncations: 0, refusalRecords: 1 });
    expect(inc.retryShare).toBeCloseTo(1 / 5, 12);
    expect(cand).toMatchObject({ records: 5, truncations: 1, retryShare: 0 });
  });

  it("weights cells equally and keeps per-cell spread", () => {
    expect(inc.aggregate.extraction_accuracy).toBeCloseTo(0.5, 12);
    const r1 = inc.cells.find((c) => c.cell === "r1__j1")!;
    expect(r1.metrics.extraction_accuracy).toEqual({ n: 3, mean: 1, sd: 0, min: 1, max: 1 });
    const r2 = inc.cells.find((c) => c.cell === "r2__j1")!;
    expect(r2).toMatchObject({ flows: 2, successful: 1 });
    expect(r2.metrics.extraction_accuracy).toMatchObject({ n: 1, mean: 0, sd: null });
    expect(cand.aggregate.extraction_accuracy).toBeCloseTo(0.8, 12);
    expect(inc.aggregate.grounding_share).toBeCloseTo(0.5, 12); // r1 grounded, r2 not
  });

  it("reports latency from live calls and stage cost per flow at list price", () => {
    const extraction = inc.latency.find((l) => l.step === "extraction")!;
    expect(extraction).toEqual({ step: "extraction", calls: 5, p50Ms: 1000, maxMs: 3000 });
    const price = priceUsage(call() as UsageRecord).costUsd;
    const cost = inc.stageCost.find((s) => s.step === "extraction")!;
    // 6 records (replayed included: the modeled cost of the flow) over 5 flows.
    expect(cost.perFlowUsd).toBeCloseTo((6 * price) / 5, 12);
    expect(cand.stageCost.find((s) => s.step === "unit_embedding")).toMatchObject({ unpricedRecords: 1 });
  });

  it("compares against the incumbent per cell and overall", () => {
    const c = result.comparisons.find((x) => x.metric === "extraction_accuracy")!;
    expect(c.commonCells).toBe(2);
    expect(c.diff).toBeCloseTo(((0.6 - 1) + (1 - 0)) / 2, 12);
    expect(c.cellDiffs.map((d) => d.cell)).toEqual(["r1__j1", "r2__j1"]);
    expect(c.cellsAhead).toBe(1);
    expect(c.ci95!.lo).toBeLessThanOrEqual(c.diff!);
    expect(c.ci95!.hi).toBeGreaterThanOrEqual(c.diff!);
    // The incumbent holds one successful r2 flow, so r2's variance is
    // undefined and the stratified Welch test of this difference is too.
    expect(c.welchP).toBeNull();
  });

  it("pins the Welch p-value to the printed difference when the cell mix differs between arms", () => {
    seq = 0;
    const at = (variant: string, resume: string, values: number[]): FlowRecord[] =>
      values.map((v) => flow(variant, resume, [GOOD], { matchAccuracy: v }));
    const unbalanced = [
      ...at("inc", "r1", [0.97, 0.98, 0.99, 1, 1, 1]),
      ...at("inc", "r2", [0, 0.02]),
      ...at("cand", "r1", [0.985, 0.999]),
      ...at("cand", "r2", [0, 0.01, 0.02, 0, 0.01, 0.02]),
    ];
    const r = analyzeRecords(unbalanced, { task: "extraction", incumbent: "inc", labels: LABELS, resamples: 2000 });
    const c = r.comparisons.find((x) => x.metric === "match_accuracy")!;
    expect(c.diff).toBeCloseTo(0.001, 12);
    expect(c.ci95!.lo).toBeLessThan(0);
    expect(c.ci95!.hi).toBeGreaterThan(0);
    // The pooled flow-level Welch test gave p < 0.05 for a ~−49-point gap here.
    expect(c.welchP).toBeGreaterThan(0.5);
  });

  it("runs the power check on the incumbent's pooled within-cell SD", () => {
    const p = result.power.find((x) => x.metric === "extraction_accuracy")!;
    // r1 has SD 0 (2 df); r2 has one value (no df) → s = 0.
    expect(p).toMatchObject({ available: true, s: 0, cells: 2, nForTarget: 1 });
    expect(result.power.find((x) => x.metric === "summary_tokens")).toMatchObject({ nForTarget: null });
  });

  it("is deterministic and independent of record order", () => {
    const again = analyzeRecords([...corpus()].reverse(), { task: "extraction", incumbent: "inc", labels: LABELS, resamples: 2000 });
    expect(JSON.parse(JSON.stringify(again))).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it("refuses a missing incumbent or candidate", () => {
    expect(() => analyzeRecords(corpus(), { task: "extraction", incumbent: "nope", labels: LABELS })).toThrow(/incumbent "nope" has no recorded flows/);
    expect(() =>
      analyzeRecords(corpus(), { task: "extraction", incumbent: "inc", candidates: ["ghost"], labels: LABELS }),
    ).toThrow(/candidate "ghost"/);
    expect(() =>
      analyzeRecords(corpus(), { task: "extraction", incumbent: "inc", candidates: ["inc"], labels: LABELS }),
    ).toThrow(/also the incumbent/);
  });

  it("warns when one label pools different configurations or cells differ", () => {
    const flows = [...corpus(), flow("cand", "r1", [MID], { stages: { extraction: { model: "other" } } as never })];
    flows.push(flow("cand", "r3", [GOOD]));
    const labels: AnalysisLabels = {
      units: new Map([...LABELS.units!, ["r3", LABELS.units!.get("r1")!]]),
    };
    const r = analyzeRecords(flows, { task: "extraction", incumbent: "inc", labels, resamples: 200 });
    expect(r.warnings.join("\n")).toMatch(/cand: 2 different stage configurations/);
    expect(r.warnings.join("\n")).toMatch(/common cells only; r3__j1/);
  });

  it("scores the task stage's output even when a later stage failed, and match accuracy only on success", () => {
    seq = 0;
    const flows = [
      flow("inc", "r1", [GOOD], { matchAccuracy: 0.5 }),
      flow("inc", "r1", [GOOD], { matchAccuracy: 0.7 }),
      // Extraction returned; the embedding call after it failed.
      flow("inc", "r1", [MID], {
        ok: false,
        matchAccuracy: null,
        error: { kind: "APIError", name: "APIError", message: "embedding outage", step: "unit_embedding" },
      }),
      // Extraction itself failed: nothing to score.
      flow("inc", "r1", null, {
        ok: false,
        matchAccuracy: null,
        requirements: null,
        error: { kind: "schema_error", name: "ExtractionError", message: "bad", step: "extraction" },
      }),
    ];
    const r = analyzeRecords(flows, { task: "extraction", incumbent: "inc", labels: LABELS, resamples: 200 });
    const arm = r.arms[0]!;
    expect(arm).toMatchObject({ flows: 4, failedFlows: 2, taskStepFailures: 1, taskOutputFlows: 3 });
    const cell = arm.cells[0]!;
    expect(cell).toMatchObject({ flows: 4, successful: 2, scored: 3 });
    expect(cell.metrics.extraction_accuracy).toMatchObject({ n: 3, mean: (1 + 1 + 0.6) / 3 });
    expect(cell.metrics.match_accuracy).toMatchObject({ n: 2, mean: 0.6 });
    // The JD task gates on Requirements instead: the extraction failure has none.
    const jd = analyzeRecords(flows, { task: "jd", incumbent: "inc", labels: LABELS, resamples: 200 });
    expect(jd.arms[0]).toMatchObject({ taskOutputFlows: 3, taskStepFailures: 0 });
  });

  it("leaves out replays that repeat a counted sample's output, and warns", () => {
    seq = 0;
    const replay = { stepCacheHits: { extraction: true } };
    const flows = [
      // r1: two invocations replayed the same cached Units; one counts.
      flow("inc", "r1", [MID], { invocationId: "inv-1", ...replay }),
      flow("inc", "r1", [MID], { invocationId: "inv-2", ...replay }),
      // r2: a live flow and a replay of the same output; the live one counts.
      flow("inc", "r2", [GOOD], { invocationId: "inv-2", ...replay }),
      flow("inc", "r2", [GOOD], { invocationId: "inv-1" }),
      // r2: a replay with an output no counted flow has keeps its value.
      flow("inc", "r2", [BAD], { invocationId: "inv-3", ...replay }),
    ];
    const r = analyzeRecords(flows, { task: "extraction", incumbent: "inc", labels: LABELS, resamples: 200 });
    const arm = r.arms[0]!;
    expect(arm).toMatchObject({ replayedTaskFlows: 4, repeatedReplays: 2 });
    const r1 = arm.cells.find((c) => c.cell === "r1__j1")!;
    expect(r1.metrics.extraction_accuracy).toMatchObject({ n: 1, mean: 0.6 });
    // Match accuracy is a whole-flow value and stays.
    expect(r1.metrics.match_accuracy).toMatchObject({ n: 2 });
    const r2 = arm.cells.find((c) => c.cell === "r2__j1")!;
    expect(r2.metrics.extraction_accuracy).toMatchObject({ n: 2, mean: 0.5 });
    expect(r2.scored).toBe(2);
    expect(r.warnings.join("\n")).toMatch(
      /inc: 4 flow\(s\) replayed the extraction output from the stage cache; 2 repeat an earlier sample's output/,
    );
  });

  it("counts a token-source difference under one label as a separate configuration", () => {
    seq = 0;
    const flows = [
      flow("inc", "r1", [GOOD], { tokenSource: "api" }),
      flow("inc", "r1", [GOOD], { tokenSource: "claude-cli" }),
    ];
    const r = analyzeRecords(flows, { task: "extraction", incumbent: "inc", labels: LABELS, resamples: 200 });
    expect(r.arms[0]!.configs).toBe(2);
    expect(r.warnings.join("\n")).toMatch(/inc: 2 different stage configurations \(or token sources\)/);
  });

  it("scores the JD task from saved Requirements", () => {
    const r = analyzeRecords(corpus(), { task: "jd", incumbent: "inc", labels: LABELS, resamples: 200 });
    expect(r.arms[0]!.aggregate).toMatchObject({ requirement_set_accuracy: 1, must_have_agreement: 1, parsed_must_have_count: 1 });
  });

  it("prints every arm and section as Markdown, and no Unit text", () => {
    const md = formatAnalysisMarkdown(result);
    for (const heading of ["## Arms", "## Metrics", "## Versus incumbent", "## Latency per step", "## Modeled cost per flow", "## Power check"]) {
      expect(md).toContain(heading);
    }
    // flows, failed, failed in the task step, refusals, error kinds.
    expect(md).toMatch(/\| inc \| 5 \| 1 \| 1 \| 1 \| refusal 1 \|/);
    expect(md).toMatch(/\| cand \| extraction accuracy \| \+30\.0 \|/);
    expect(md).not.toContain("SECRET-UNIT-TEXT");
  });
});
