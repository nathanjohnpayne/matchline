import { describe, expect, it } from "vitest";

import type { UsageRecord } from "../../functions/src/llm/cost.ts";

import { buildFlowRecord, deriveCall, parseFlowsJsonl, type FlowContext } from "./flowRecord.ts";
import { newFlowTrace } from "./flowTrace.ts";
import type { RunForFixtureResult } from "./runForFixture.ts";

const usage = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  stage: "extraction",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  servedModel: "claude-sonnet-4-6-20260101",
  latencyMs: 1200,
  inputTokens: 1000,
  outputTokens: 400,
  cacheReadInputTokens: 10,
  attempt: 0,
  maxTokens: 16000,
  effort: "medium",
  promptVersion: "extraction/resume.v1",
  ...over,
});

const CTX: FlowContext = {
  invocationId: "inv-1",
  variant: "haiku",
  stages: {
    extraction: {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      effortRequested: null,
      effortSent: null,
      promptVersion: "v1",
      promptFingerprint: "v1:0123456789abcdef",
    },
  },
  embeddingModel: "text-embedding-3-small",
  resumeId: "r1",
  jdId: "j1",
  sampleIndex: 2,
  startedAt: "2026-10-28T10:00:00.000Z",
  finishedAt: "2026-10-28T10:00:05.000Z",
};

const RESULT: RunForFixtureResult = {
  resumeFixtureId: "r1",
  jdFixtureId: "j1",
  extractionAccuracy: 0.7,
  matchAccuracy: 0.6,
  latencyMs: 5000,
  costUsd: 0.01,
  modeledCostUsd: 0.02,
  cacheHits: 1,
  cacheMisses: 3,
  extractedUnitCount: 2,
  parsedRequirementCount: 3,
  matchCount: 6,
  ok: true,
  error: null,
};

describe("deriveCall", () => {
  it("flags truncation at outputTokens >= maxTokens and a retry at attempt > 0", () => {
    expect(deriveCall({ step: "extraction", replayed: false, usage: usage({ outputTokens: 16000 }) }, undefined, undefined)).toMatchObject({
      truncated: true,
      retry: false,
      refusal: false,
    });
    expect(deriveCall({ step: "extraction", replayed: false, usage: usage({ attempt: 2 }) }, undefined, undefined)).toMatchObject({
      truncated: false,
      retry: true,
    });
  });

  it("never flags an embedding record, which carries no max_tokens or attempt", () => {
    const emb: UsageRecord = { stage: "embedding", provider: "openai", model: "text-embedding-3-small", latencyMs: 5, inputTokens: 50, outputTokens: 0 };
    expect(deriveCall({ step: "unit_embedding", replayed: false, usage: emb }, undefined, undefined)).toMatchObject({
      truncated: false,
      retry: false,
      refusal: false,
    });
  });

  it("takes refusal and truncation from the failing step's failures at the same attempt only", () => {
    const failures = [
      { attempt: 0, kind: "max_tokens_exceeded" },
      { attempt: 1, kind: "refusal" },
    ];
    const at = (attempt: number, step = "requirement_parsing", replayed = false) =>
      deriveCall({ step, replayed, usage: usage({ attempt, outputTokens: 10 }) }, "requirement_parsing", failures);
    expect(at(0)).toMatchObject({ truncated: true, refusal: false });
    expect(at(1)).toMatchObject({ truncated: false, refusal: true });
    expect(at(1, "extraction")).toMatchObject({ refusal: false });
    expect(at(1, "requirement_parsing", true)).toMatchObject({ refusal: false });
  });
});

describe("deriveCall attempt failures (#656)", () => {
  const parsing = (attempt: number) => usage({ stage: "requirement_parsing", attempt, promptVersion: "parsing/jd.v2" });
  const reported = [
    { step: "requirement_parsing", attempt: 0, kind: "schema_error", issues: [{ code: "invalid_value", path: ["requirements", 2, "category"] }] },
    { step: "requirement_parsing", attempt: 1, kind: "no_tool_use" },
  ] as const;

  it("adds the reported kind and issues to the live call of the same step and attempt", () => {
    expect(deriveCall({ step: "requirement_parsing", replayed: false, usage: parsing(0) }, undefined, undefined, reported)).toMatchObject({
      failureKind: "schema_error",
      issues: [{ code: "invalid_value", path: ["requirements", 2, "category"] }],
      retry: false,
    });
    const second = deriveCall({ step: "requirement_parsing", replayed: false, usage: parsing(1) }, undefined, undefined, reported);
    expect(second.failureKind).toBe("no_tool_use");
    expect(second).not.toHaveProperty("issues");
  });

  it("leaves a call untagged when the attempt, the step or the replay flag does not match", () => {
    for (const call of [
      { step: "requirement_parsing", replayed: false, usage: parsing(2) },
      { step: "extraction", replayed: false, usage: usage({ attempt: 0 }) },
      { step: "requirement_parsing", replayed: true, usage: parsing(0) },
    ] as const) {
      const rec = deriveCall(call, undefined, undefined, reported);
      expect(rec).not.toHaveProperty("failureKind");
      expect(rec).not.toHaveProperty("issues");
    }
    expect(deriveCall({ step: "requirement_parsing", replayed: false, usage: parsing(0) }, undefined, undefined)).not.toHaveProperty("failureKind");
  });

  it("round-trips the tags through a flows.jsonl line", () => {
    const trace = newFlowTrace();
    trace.calls.push({ step: "requirement_parsing", replayed: false, usage: parsing(0) });
    trace.calls.push({ step: "requirement_parsing", replayed: false, usage: parsing(1) });
    trace.attemptFailures!.push(reported[0]);
    trace.requirements = [];
    const [flow] = parseFlowsJsonl(JSON.stringify(buildFlowRecord(CTX, RESULT, trace)), "f.jsonl");
    expect(flow!.calls.map((c) => c.failureKind ?? null)).toEqual(["schema_error", null]);
    expect(flow!.calls[0]!.issues).toEqual([{ code: "invalid_value", path: ["requirements", 2, "category"] }]);
  });
});

describe("buildFlowRecord", () => {
  it("carries context, every usage field, full Units and Requirements, counts and costs", () => {
    const trace = newFlowTrace();
    trace.calls.push({ step: "extraction", replayed: false, usage: usage() });
    trace.calls.push({ step: "unit_embedding", replayed: true, usage: usage({ stage: "embedding", provider: "openai", model: "text-embedding-3-small" }) });
    trace.units = [
      { raw_text: "a", normalized_summary: "A", skills: ["x"], embedding: [0.1, 0.2] },
      { raw_text: "b", normalized_summary: "B", skills: [] },
    ];
    trace.requirements = [
      { normalized_requirement: "r1", must_have: true },
      { normalized_requirement: "r2", must_have: false },
      { normalized_requirement: "r3", must_have: true },
    ];
    trace.stepCacheHits.extraction = false;
    const rec = buildFlowRecord(CTX, RESULT, trace);
    expect(rec).toMatchObject({
      schemaVersion: 1,
      invocationId: "inv-1",
      variant: "haiku",
      cell: "r1__j1",
      sampleIndex: 2,
      startedAt: CTX.startedAt,
      finishedAt: CTX.finishedAt,
      ok: true,
      error: null,
      extractionAccuracy: 0.7,
      matchAccuracy: 0.6,
      extractedUnitCount: 2,
      parsedRequirementCount: 3,
      parsedMustHaveCount: 2,
      matchCount: 6,
      costUsd: 0.01,
      modeledCostUsd: 0.02,
      stages: CTX.stages,
      stepCacheHits: { extraction: false },
      failures: null,
    });
    expect(rec.calls[0]).toEqual({
      step: "extraction",
      replayed: false,
      ...usage(),
      truncated: false,
      retry: false,
      refusal: false,
    });
    expect(rec.calls[1]!.replayed).toBe(true);
    // Everything but an embedding vector is kept.
    expect(rec.units).toEqual([
      { raw_text: "a", normalized_summary: "A", skills: ["x"] },
      { raw_text: "b", normalized_summary: "B", skills: [] },
    ]);
    expect(rec.requirements).toHaveLength(3);
  });

  it("reports a failed flow's error and null accuracies rather than the result's zeros", () => {
    const trace = newFlowTrace();
    trace.failedStep = "extraction";
    trace.errorKind = "max_tokens_exceeded";
    trace.errorName = "ExtractionError";
    trace.failures = [{ attempt: 0, kind: "max_tokens_exceeded", message: "m" }];
    const rec = buildFlowRecord(CTX, { ...RESULT, ok: false, error: "Extraction failed", extractionAccuracy: 0, matchAccuracy: 0 }, trace);
    expect(rec).toMatchObject({
      ok: false,
      error: { kind: "max_tokens_exceeded", name: "ExtractionError", message: "Extraction failed", step: "extraction" },
      extractionAccuracy: null,
      matchAccuracy: null,
      matchCount: null,
      extractedUnitCount: null,
      units: null,
      requirements: null,
    });
    expect(rec.failures).toHaveLength(1);
  });
});

describe("parseFlowsJsonl", () => {
  const line = (): string => {
    const trace = newFlowTrace();
    trace.calls.push({ step: "extraction", replayed: false, usage: usage() });
    trace.units = [{ raw_text: "a" }];
    trace.requirements = [];
    return JSON.stringify(buildFlowRecord(CTX, RESULT, trace));
  };

  it("round-trips records and skips blank lines", () => {
    const flows = parseFlowsJsonl(`${line()}\n\n${line()}\n`, "f.jsonl");
    expect(flows).toHaveLength(2);
    expect(flows[0]!.calls[0]!.servedModel).toBe("claude-sonnet-4-6-20260101");
  });

  it("names the file and line of a malformed record", () => {
    expect(() => parseFlowsJsonl(`${line()}\n{not json`, "f.jsonl")).toThrow(/^f\.jsonl:2: not valid JSON/);
    const bad = JSON.parse(line());
    delete bad.variant;
    expect(() => parseFlowsJsonl(JSON.stringify(bad), "f.jsonl")).toThrow(/^f\.jsonl:1: not a flow record \(variant/);
    expect(() => parseFlowsJsonl(JSON.stringify({ ...JSON.parse(line()), schemaVersion: 99 }), "f.jsonl")).toThrow(/schemaVersion/);
  });
});
