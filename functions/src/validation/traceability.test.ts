import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";
import type { ExperienceUnit } from "../types/capability.ts";

import type { Claim } from "./claimExtraction.ts";
import { TraceabilityCheckError } from "./errors.ts";
import {
  EMPTY_UNITS_RATIONALE,
  checkTraceability,
} from "./traceability.ts";

/**
 * Tests for the validation pipeline's traceability check
 * (sub-issue #107 of #23). Mocked Anthropic client; no I/O.
 *
 * Coverage:
 *   - Happy path supports=true: stamped result returned with
 *     supporting_unit_id propagated.
 *   - Happy path supports=false: no supporter id propagated.
 *   - **Adversarial fixture (load-bearing zero-fab pin)**: a
 *     fabricated claim with no matching Unit returns
 *     supports=false. This is THE invariant the validation
 *     layer exists to enforce.
 *   - **Empty-units short-circuit**: returns supports=false
 *     synchronously without calling the LLM (cost optimization
 *     + redundant guard against the LLM fabricating a yes).
 *   - **Cross-set fabrication guard**: model emits a
 *     supporting_unit_id NOT in the candidate set → downgraded
 *     to supports=false with diagnostic rationale.
 *   - Schema-error retry success / exhaustion.
 *   - Transport-error retry.
 *   - no_tool_use response handling.
 *   - Cost tracker fires per successful response (including
 *     retries that succeeded), per the parsing/jd.ts pattern.
 *   - Prompt content includes the formatted Unit list with
 *     stable shape.
 */

function mockMessage(
  toolInput: unknown,
  usage = { input_tokens: 200, output_tokens: 80 },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "record_traceability",
        input: toolInput,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
  } as Anthropic.Messages.Message;
}

function mockTextOnlyMessage(
  text: string,
  usage = { input_tokens: 100, output_tokens: 5 },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  } as Anthropic.Messages.Message;
}

interface MockClientHandle {
  client: Anthropic;
  create: ReturnType<typeof vi.fn>;
}

function mockClient(
  responses: (Anthropic.Messages.Message | Error)[],
): MockClientHandle {
  const queue = [...responses];
  const create = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock client: no more queued responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    client: { messages: { create } } as unknown as Anthropic,
    create,
  };
}

const CTX = { ownerUid: "user-alice" };

const CLAIM: Claim = {
  id: "claim-1",
  bullet_id: "bullet-1",
  text: "The user achieved a 30% reduction in memory footprint.",
};

function makeUnit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: "unit-a",
    owner_uid: "user-alice",
    source_type: "resume",
    source_ref: "ref",
    raw_text: "Led 64-bit NCP migration; reduced memory 30%.",
    normalized_summary: "Led 64-bit NCP migration, cutting memory 30%.",
    unit_type: "technical_decision",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: ["led"],
    scope_signals: [],
    business_outcomes: [],
    metrics: [
      {
        claim: "Reduced memory footprint 30%",
        value: 30,
        unit: "%",
        direction: "down",
        confidence: "high",
      },
    ],
    evidence_type: "verified",
    confidence_score: 0.95,
    user_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkTraceability", () => {
  it("supports=true response: returns supporting_unit_id and rationale", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client } = mockClient([
      mockMessage({
        supports: true,
        supporting_unit_id: "unit-a",
        rationale:
          "Unit unit-a lists \"Reduced memory footprint 30%\" with value: 30, matching the claim.",
      }),
    ]);

    const result = await checkTraceability(CLAIM, [makeUnit()], CTX, {
      client,
      record,
    });

    expect(result.supports).toBe(true);
    expect(result.supporting_unit_id).toBe("unit-a");
    expect(result.rationale).toContain("Reduced memory footprint 30%");
  });

  it("supports=false response: returns no supporting_unit_id", async () => {
    const fabricated: Claim = {
      id: "claim-fab",
      bullet_id: "bullet-1",
      text: "The user managed a team of 40 at Netflix.",
    };
    const { client } = mockClient([
      mockMessage({
        supports: false,
        rationale: "No Unit references Netflix or a team of 40.",
      }),
    ]);

    const result = await checkTraceability(fabricated, [makeUnit()], CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0.001),
    });

    expect(result.supports).toBe(false);
    expect(result.supporting_unit_id).toBeUndefined();
    expect(result.rationale).toContain("Netflix");
  });

  it("ADVERSARIAL: fabricated claim against unrelated Units returns supports=false (load-bearing zero-fab pin)", async () => {
    // The product-defining test for the validation layer.
    // A claim that mentions content NOT present in any Unit
    // MUST return supports=false. If this test ever passes
    // accidentally with supports=true, the entire zero-fab
    // thesis collapses.
    const fabricated: Claim = {
      id: "claim-fab",
      bullet_id: "bullet-1",
      text: "The user shipped Netflix's first 4K HDR encoder.",
    };
    const unrelatedUnits = [
      makeUnit({
        id: "unit-disney",
        raw_text: "Worked on Disney+ playback memory optimization.",
      }),
      makeUnit({
        id: "unit-amazon",
        raw_text: "PM for Amazon Fire TV app.",
      }),
    ];
    const { client } = mockClient([
      mockMessage({
        supports: false,
        rationale: "No Unit references Netflix or a 4K HDR encoder.",
      }),
    ]);

    const result = await checkTraceability(fabricated, unrelatedUnits, CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0.001),
    });

    expect(result.supports).toBe(false);
    expect(result.supporting_unit_id).toBeUndefined();
  });

  it("EMPTY-UNITS SHORT-CIRCUIT: returns supports=false WITHOUT calling the LLM", async () => {
    // Pin: zero candidate units → synchronous false. Two
    // properties pinned:
    //   1. The LLM client is never invoked (cost optimization).
    //   2. The result rationale is the canonical empty-units
    //      message (so the orchestrator can distinguish
    //      "no Units" from "Units present but none support").
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);

    const result = await checkTraceability(CLAIM, [], CTX, { client, record });

    expect(result.supports).toBe(false);
    expect(result.rationale).toBe(EMPTY_UNITS_RATIONALE);
    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("CROSS-SET FABRICATION GUARD: model emits unknown supporting_unit_id → downgraded to supports=false", async () => {
    // Pin: even when the schema accepts the response shape, if
    // the model invents a supporting_unit_id that isn't in the
    // candidate set, finalizeResult() catches it and downgrades
    // to supports=false with a diagnostic rationale. This is
    // the second layer of zero-fab defense (schema can't catch
    // value-level fabrications).
    const candidates = [makeUnit({ id: "unit-real" })];
    const { client } = mockClient([
      mockMessage({
        supports: true,
        supporting_unit_id: "unit-fabricated", // NOT in candidates
        rationale: "I think this Unit supports the claim.",
      }),
    ]);

    const result = await checkTraceability(CLAIM, candidates, CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0.001),
    });

    expect(result.supports).toBe(false);
    expect(result.supporting_unit_id).toBeUndefined();
    expect(result.rationale).toContain("unit-fabricated");
    expect(result.rationale).toContain("not in the candidate set");
  });

  it("logs cost via recordUsage with stage='validation'", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client } = mockClient([
      mockMessage({
        supports: false,
        rationale: "No support found.",
      }),
    ]);

    await checkTraceability(CLAIM, [makeUnit()], CTX, { client, record });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "validation",
        provider: "anthropic",
        inputTokens: 200,
        outputTokens: 80,
        ownerUid: "user-alice",
      }),
    );
  });

  it("retries on schema error and succeeds on the second attempt", async () => {
    // First response fails the refine() (supports=true with no
    // id). Second response is valid.
    const malformed = {
      supports: true,
      rationale: "Some Unit supports this.",
    };
    const valid = {
      supports: true,
      supporting_unit_id: "unit-a",
      rationale: "Unit unit-a metric matches.",
    };
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client, create } = mockClient([
      mockMessage(malformed),
      mockMessage(valid),
    ]);

    const result = await checkTraceability(CLAIM, [makeUnit()], CTX, {
      client,
      record,
    });

    expect(result.supports).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    // Cost recorded for BOTH responses.
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("throws TraceabilityCheckError after 3 schema-error attempts", async () => {
    const malformed = {
      supports: true,
      rationale: "Some Unit supports this.", // missing supporting_unit_id
    };
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(malformed),
    ]);

    await expect(
      checkTraceability(CLAIM, [makeUnit()], CTX, { client, record }),
    ).rejects.toBeInstanceOf(TraceabilityCheckError);

    expect(record).toHaveBeenCalledTimes(3);
  });

  it("retries on transport errors and succeeds when next attempt is valid", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      new Error("ECONNRESET"),
      mockMessage({
        supports: false,
        rationale: "No support found.",
      }),
    ]);

    const result = await checkTraceability(CLAIM, [makeUnit()], CTX, {
      client,
      record,
    });

    expect(result.supports).toBe(false);
    // Transport error has no tokens to record; only the
    // successful attempt records.
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("counts text-only responses (no tool_use) as failures and retries", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      mockTextOnlyMessage("I would emit a verdict but cannot use tools."),
      mockMessage({
        supports: false,
        rationale: "No support found.",
      }),
    ]);

    const result = await checkTraceability(CLAIM, [makeUnit()], CTX, {
      client,
      record,
    });

    expect(result.supports).toBe(false);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("formats Units with id, raw_text, normalized_summary, and metrics in the prompt content", async () => {
    // Pin: the prompt's user content has a stable, deterministic
    // shape. The model's response identifies Units by `id`, so
    // missing the `[Unit ${id}]` header would break the
    // model's ability to reference them.
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client, create } = mockClient([
      mockMessage({
        supports: true,
        supporting_unit_id: "unit-a",
        rationale: "Unit metric matches.",
      }),
    ]);

    await checkTraceability(CLAIM, [makeUnit()], CTX, { client, record });

    const callArgs = create.mock.calls[0]![0] as {
      messages: { content: string }[];
    };
    const content = callArgs.messages[0]!.content;
    expect(content).toContain("[Unit unit-a]");
    expect(content).toContain("raw_text:");
    expect(content).toContain("normalized_summary:");
    expect(content).toContain("metrics:");
    expect(content).toContain("Reduced memory footprint 30%");
    // The claim text appears too.
    expect(content).toContain(
      "The user achieved a 30% reduction in memory footprint.",
    );
  });

  it("handles a Unit with no metrics gracefully", async () => {
    const noMetrics = makeUnit({ id: "unit-no-metrics", metrics: [] });
    const { client, create } = mockClient([
      mockMessage({
        supports: false,
        rationale: "No metrics available to verify the claim.",
      }),
    ]);

    await checkTraceability(CLAIM, [noMetrics], CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0.001),
    });

    const callArgs = create.mock.calls[0]![0] as {
      messages: { content: string }[];
    };
    expect(callArgs.messages[0]!.content).toContain("(no metrics)");
  });
});
