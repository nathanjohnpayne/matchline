/**
 * --record hook tests: the per-flow trace `runForFixture` fills when a
 * caller passes one, and its absence when none is passed. Mocked clients
 * only; no network, no spend.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnthropicClient as Anthropic } from "../../functions/src/llm/anthropic.ts";
import { EMBEDDING_MODEL } from "../../functions/src/llm/config.ts";
import type { OpenAIClient as OpenAI } from "../../functions/src/llm/openai.ts";

import { StageCache } from "./cache.ts";
import { buildFlowRecord } from "./flowRecord.ts";
import {
  newFlowTrace,
  traceAttemptFailure,
  traceEnterStep,
  traceFailure,
  traceStepDone,
  traceStepFor,
  traceValue,
  type FlowTrace,
} from "./flowTrace.ts";
import { runForFixture } from "./runForFixture.ts";

interface Step {
  readonly input?: unknown;
  readonly stopReason?: string;
  /** Report output tokens equal to the request's max_tokens. */
  readonly hitMax?: boolean;
}

function mockAnthropic(steps: readonly Step[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async (params: { model: string; max_tokens: number }) => {
        const step = steps[i++] ?? {};
        return {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: `${params.model}-served`,
          content:
            step.input === undefined ? [] : [{ type: "tool_use", id: `toolu_${i}`, name: "tool", input: step.input }],
          stop_reason: step.stopReason ?? "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: step.hitMax ? params.max_tokens : 50 },
        };
      }),
    },
  } as unknown as Anthropic;
}

function mockOpenAi(): OpenAI {
  return {
    embeddings: {
      create: vi.fn(async ({ input }: { input: string | string[] }) => {
        const inputs = Array.isArray(input) ? input : [input];
        return {
          data: inputs.map((s, idx) => ({
            embedding: Array.from({ length: 1536 }, (_, k) => Math.sin(s.length + idx + k)),
            index: idx,
            object: "embedding",
          })),
          model: EMBEDDING_MODEL,
          object: "list",
          usage: { prompt_tokens: inputs.length * 10, total_tokens: inputs.length * 10 },
        };
      }),
    },
  } as unknown as OpenAI;
}

const UNIT = {
  raw_text: "Led Amazon Kepler launch",
  normalized_summary: "Led Amazon Kepler launch — ground-up rewrite replacing Fire TV Android stack",
  unit_type: "project",
  skills: ["platform launch"],
  tools: ["Fire TV"],
  domains: ["streaming video infrastructure"],
  seniority_signals: [],
  scope_signals: [],
  business_outcomes: [],
  metrics: [],
  evidence_type: "verified",
  confidence_score: 0.9,
};
const EXTRACTION = { units: [UNIT, { ...UNIT, raw_text: "Brought Disney+ to launch", normalized_summary: "Brought Disney+ from concept to launch" }] };
const REQ = {
  raw_text: "8 years of experience in product management",
  normalized_requirement: "8 years of product management experience",
  category: "experience_level",
  keywords: [],
  tools: [],
  domains: [],
  priority: "high",
  must_have: true,
  extracted_from: "qualifications",
};
const PARSING = { requirements: [REQ, { ...REQ, must_have: false, normalized_requirement: "Kubernetes experience" }] };
const INPUT = { resumeFixtureId: "nathan-2026", jdFixtureId: "google-compute-spm-2026" };

const CTX = {
  invocationId: "inv-1",
  variant: "default",
  stages: {},
  embeddingModel: EMBEDDING_MODEL,
  resumeId: INPUT.resumeFixtureId,
  jdId: INPUT.jdFixtureId,
  sampleIndex: 0,
  startedAt: "2026-10-28T00:00:00.000Z",
  finishedAt: "2026-10-28T00:00:01.000Z",
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("flowTrace helpers", () => {
  it("splits the two embedding calls by whether Requirements have arrived", () => {
    const t = newFlowTrace();
    expect(traceStepFor(t, "extraction")).toBe("extraction");
    traceValue(t, "extraction", []);
    expect(traceStepFor(t, "embedding")).toBe("unit_embedding");
    traceValue(t, "requirement_parsing", []);
    expect(traceStepFor(t, "embedding")).toBe("requirement_embedding");
    expect(t.currentStep).toBe("requirement_embedding");
    // A stage name the orchestrator adds later is kept as is.
    expect(traceStepFor(t, "generation")).toBe("generation");
    expect(traceStepFor(undefined, "embedding")).toBe("unit_embedding");
  });

  it("ignores values that are not the Units or Requirements", () => {
    const t = newFlowTrace();
    traceValue(t, "embedding", [[1, 2]]);
    traceValue(t, "extraction", "not an array");
    expect(t.units).toBeUndefined();
    expect(t.requirements).toBeUndefined();
  });

  it("records the failure kind from a thrown failures array, else the error name", () => {
    const a = newFlowTrace();
    traceStepFor(a, "extraction");
    traceFailure(a, Object.assign(new Error("x"), { name: "ExtractionError", failures: [{ attempt: 0, kind: "schema_error" }, { attempt: 1, kind: "refusal" }] }));
    expect(a).toMatchObject({ failedStep: "extraction", errorKind: "refusal", errorName: "ExtractionError" });
    expect(a.failures).toHaveLength(2);

    const b = newFlowTrace();
    traceFailure(b, new TypeError("boom"));
    expect(b).toMatchObject({ errorKind: "TypeError", errorName: "TypeError" });
    expect(b.failedStep).toBeUndefined();

    for (const thrown of [null, undefined, 42, "s"]) {
      const c = newFlowTrace();
      expect(() => traceFailure(c, thrown)).not.toThrow();
      expect(c.errorKind).toBe("error");
    }
    expect(() => traceFailure(undefined, new Error("x"))).not.toThrow();
  });

  it("keeps a reported attempt failure's step, attempt, kind and issue codes and paths only (#656)", () => {
    const t = newFlowTrace();
    const issue = { code: "invalid_value", path: ["requirements", 1, "category"], message: "model text" };
    traceAttemptFailure(t, "requirement_parsing", { attempt: 0, kind: "schema_error", issues: [issue] });
    traceAttemptFailure(t, "requirement_parsing", { attempt: 1, kind: "no_tool_use" });
    traceAttemptFailure(t, "requirement_parsing", { attempt: 2, kind: "schema_error", issues: [] });
    expect(t.attemptFailures).toEqual([
      { step: "requirement_parsing", attempt: 0, kind: "schema_error", issues: [{ code: "invalid_value", path: ["requirements", 1, "category"] }] },
      { step: "requirement_parsing", attempt: 1, kind: "no_tool_use" },
      { step: "requirement_parsing", attempt: 2, kind: "schema_error" },
    ]);
    // A copy: later changes to the caller's path do not reach the trace.
    issue.path.push("x");
    expect(t.attemptFailures![0]!.issues![0]!.path).toEqual(["requirements", 1, "category"]);
  });

  it("is a no-op without a trace, or on a trace built without the attempt-failure list", () => {
    expect(() => traceAttemptFailure(undefined, "requirement_parsing", { attempt: 0, kind: "schema_error" })).not.toThrow();
    const bare: FlowTrace = { calls: [], stepCacheHits: {} };
    traceAttemptFailure(bare, "requirement_parsing", { attempt: 0, kind: "schema_error" });
    expect(bare.attemptFailures).toBeUndefined();
  });
});

describe("runForFixture with a trace (--record hook)", () => {
  it("leaves the result unchanged and collects nothing without a trace", async () => {
    const plain = await runForFixture(INPUT, {
      anthropicClient: mockAnthropic([{ input: EXTRACTION }, { input: PARSING }]),
      openaiClient: mockOpenAi(),
    });
    const traced = await runForFixture(INPUT, {
      anthropicClient: mockAnthropic([{ input: EXTRACTION }, { input: PARSING }]),
      openaiClient: mockOpenAi(),
      trace: newFlowTrace(),
    });
    expect(Object.keys(traced).sort()).toEqual(Object.keys(plain).sort());
    expect(traced.ok).toBe(true);
  });

  it("tags every live call by step, in order, and keeps the full Units and Requirements", async () => {
    const trace = newFlowTrace();
    const result = await runForFixture(INPUT, {
      anthropicClient: mockAnthropic([{ input: EXTRACTION }, { input: PARSING }]),
      openaiClient: mockOpenAi(),
      trace,
    });
    expect(result.ok).toBe(true);
    expect(trace.calls.map((c) => c.step)).toEqual([
      "extraction",
      "unit_embedding",
      "requirement_parsing",
      "requirement_embedding",
    ]);
    expect(trace.calls.every((c) => !c.replayed)).toBe(true);
    expect(trace.calls[0]!.usage.servedModel).toMatch(/-served$/);
    expect(trace.units).toHaveLength(2);
    expect(trace.units![0]).toMatchObject({ raw_text: UNIT.raw_text, skills: UNIT.skills });
    expect(trace.requirements).toHaveLength(2);
    expect(trace.requirements![1]).toMatchObject({ must_have: false, normalized_requirement: "Kubernetes experience" });

    const rec = buildFlowRecord(CTX, result, trace);
    expect(rec).toMatchObject({ ok: true, extractedUnitCount: 2, parsedRequirementCount: 2, parsedMustHaveCount: 1, error: null });
    expect(rec.calls.reduce((n, c) => n + (c.retry ? 1 : 0), 0)).toBe(0);
  });

  it("derives a truncation and a retry when extraction hits max_tokens once", async () => {
    const trace = newFlowTrace();
    const result = await runForFixture(INPUT, {
      anthropicClient: mockAnthropic([
        { input: EXTRACTION, stopReason: "max_tokens", hitMax: true },
        { input: EXTRACTION },
        { input: PARSING },
      ]),
      openaiClient: mockOpenAi(),
      trace,
    });
    expect(result.ok).toBe(true);
    const rec = buildFlowRecord(CTX, result, trace);
    const extraction = rec.calls.filter((c) => c.step === "extraction");
    expect(extraction.map((c) => c.attempt)).toEqual([0, 1]);
    expect(extraction.map((c) => c.truncated)).toEqual([true, false]);
    expect(extraction.map((c) => c.retry)).toEqual([false, true]);
    // The success path drops the stage's failures array, so none is recorded.
    expect(rec.failures).toBeNull();
  });

  it("keeps the Units, the failing step and the refusal when JD parsing is declined", async () => {
    const trace = newFlowTrace();
    const result = await runForFixture(INPUT, {
      anthropicClient: mockAnthropic([{ input: EXTRACTION }, { stopReason: "refusal" }]),
      openaiClient: mockOpenAi(),
      trace,
    });
    expect(result.ok).toBe(false);
    expect(trace).toMatchObject({ failedStep: "requirement_parsing", errorKind: "refusal" });
    expect(trace.units).toHaveLength(2);
    expect(trace.requirements).toBeUndefined();
    const rec = buildFlowRecord(CTX, result, trace);
    expect(rec).toMatchObject({
      ok: false,
      extractedUnitCount: 2,
      parsedRequirementCount: null,
      parsedMustHaveCount: null,
      extractionAccuracy: null,
      matchAccuracy: null,
      error: { kind: "refusal", step: "requirement_parsing" },
    });
    expect(rec.calls.filter((c) => c.refusal).map((c) => c.step)).toEqual(["requirement_parsing"]);
    expect(rec.failures).toEqual([expect.objectContaining({ kind: "refusal", attempt: 0 })]);
  });

  it("records a recovered JD parsing schema failure's codes and paths on the call that failed (#656)", async () => {
    const trace = newFlowTrace();
    const outOfEnum = { requirements: [{ ...REQ, category: "education" }, REQ] };
    const result = await runForFixture(INPUT, {
      anthropicClient: mockAnthropic([{ input: EXTRACTION }, { input: outOfEnum }, { input: PARSING }]),
      openaiClient: mockOpenAi(),
      trace,
    });
    expect(result.ok).toBe(true);
    const rec = buildFlowRecord(CTX, result, trace);
    // The stage recovered, so nothing was thrown and no failures array kept...
    expect(rec.failures).toBeNull();
    // ...but the failed attempt's call still carries its kind, code and path.
    const parsing = rec.calls.filter((c) => c.step === "requirement_parsing");
    expect(parsing.map((c) => c.attempt)).toEqual([0, 1]);
    expect(parsing[0]).toMatchObject({
      failureKind: "schema_error",
      issues: [{ code: "invalid_value", path: ["requirements", 0, "category"] }],
    });
    expect(parsing[1]!.failureKind).toBeUndefined();
    expect(parsing[1]!.issues).toBeUndefined();
    // No other step's call is tagged, and no model output is copied.
    expect(rec.calls.filter((c) => c.failureKind !== undefined)).toHaveLength(1);
    expect(JSON.stringify(rec.calls)).not.toContain("education");
  });

  it("charges a throw in matching to matching, not to the last embedding call", async () => {
    const trace = newFlowTrace();
    const result = await runForFixture(INPUT, {
      anthropicClient: mockAnthropic([{ input: EXTRACTION }, { input: PARSING }]),
      openaiClient: mockOpenAi(),
      persistBatch: async () => {
        throw new Error("persist failed");
      },
      trace,
    });
    expect(result.ok).toBe(false);
    expect(trace.failedStep).toBe("matching");
    const rec = buildFlowRecord(CTX, result, trace);
    expect(rec.error).toMatchObject({ step: "matching", message: expect.stringContaining("persist failed") });
    // Every LLM stage finished, so no call carries the failure.
    expect(rec.calls.some((c) => c.refusal || c.truncated)).toBe(false);
  });

  it("clears the current step when a stage returns", () => {
    const trace = newFlowTrace();
    traceStepFor(trace, "extraction");
    traceStepDone(trace);
    traceFailure(trace, new Error("between stages"));
    expect(trace.failedStep).toBeUndefined();
    traceEnterStep(trace, "scoring");
    traceFailure(trace, new Error("in scoring"));
    expect(trace.failedStep).toBe("scoring");
  });

  describe("with the stage cache", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "matchline-trace-cache-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("marks replayed usage on a warm run and records each step's cache outcome", async () => {
      const run = (trace: ReturnType<typeof newFlowTrace>) =>
        runForFixture(INPUT, {
          anthropicClient: mockAnthropic([{ input: EXTRACTION }, { input: PARSING }]),
          openaiClient: mockOpenAi(),
          cache: new StageCache({ dir }),
          trace,
        });
      const cold = newFlowTrace();
      await run(cold);
      expect(cold.calls.every((c) => !c.replayed)).toBe(true);
      expect(Object.values(cold.stepCacheHits)).toEqual([false, false, false, false]);

      const warm = newFlowTrace();
      const result = await run(warm);
      expect(result.ok).toBe(true);
      expect(warm.calls).toHaveLength(4);
      expect(warm.calls.every((c) => c.replayed)).toBe(true);
      expect(warm.stepCacheHits).toEqual({
        extraction: true,
        unit_embedding: true,
        requirement_parsing: true,
        requirement_embedding: true,
      });
      expect(warm.units).toHaveLength(2);
      expect(warm.requirements).toHaveLength(2);
    });

    it("tags only the live run's failed attempt; a warm replay runs no attempt and tags nothing (#656)", async () => {
      const outOfEnum = { requirements: [{ ...REQ, category: "education" }] };
      const run = (trace: FlowTrace, steps: readonly Step[]) =>
        runForFixture(INPUT, {
          anthropicClient: mockAnthropic(steps),
          openaiClient: mockOpenAi(),
          cache: new StageCache({ dir }),
          trace,
        });
      const cold = newFlowTrace();
      await run(cold, [{ input: EXTRACTION }, { input: outOfEnum }, { input: PARSING }]);
      expect(cold.attemptFailures).toHaveLength(1);

      const warm = newFlowTrace();
      const result = await run(warm, []);
      expect(result.ok).toBe(true);
      expect(warm.attemptFailures).toEqual([]);
      const rec = buildFlowRecord(CTX, result, warm);
      expect(rec.calls.filter((c) => c.step === "requirement_parsing").map((c) => c.replayed)).toEqual([true, true]);
      expect(rec.calls.some((c) => c.failureKind !== undefined || c.issues !== undefined)).toBe(false);
    });
  });
});
