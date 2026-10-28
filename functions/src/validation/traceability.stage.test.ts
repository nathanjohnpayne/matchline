import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";
import {
  clearEffortOverrides,
  clearModelOverrides,
  setEffortOverrides,
  setModelOverrides,
} from "../llm/config.ts";
import { zodToToolSchema } from "../llm/zodToolSchema.ts";
import { loadPromptText } from "../prompts/loader.ts";
import { TraceabilityResponseV1Schema } from "../prompts/validation/traceability.v1.schema.ts";
import type { ExperienceUnit } from "../types/capability.ts";

import type { Claim } from "./claimExtraction.ts";
import { EMPTY_UNITS_RATIONALE, checkTraceability } from "./traceability.ts";
import { formatUnit, quote } from "./unitPromptText.ts";

/**
 * Per-stage model configuration for `traceability` (#489): the request on
 * the production pin, a 5.5 override's shape and usage record, effort
 * refusal on 4.x pins, and isolation from the other validation stages.
 * Kept apart from `traceability.test.ts` so the module's behavioural tests and
 * these configuration tests change independently. Mocked Anthropic
 * client; no I/O.
 */

// The baseline test rebuilds the pre-#489 user content with `formatUnit`.
// #485 changes traceability's input (a `Today:` line and `formatUnitBlock`,
// via an exported `renderTraceabilityInput`); whichever of #485 and #489
// merges second switches that expectation to the active renderer.

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

describe("traceability: separately configurable model stage (#489)", () => {
  afterEach(() => {
    clearModelOverrides();
    clearEffortOverrides();
  });

  const HAIKU_45 = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" };
  const SONNET_55 = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };
  const SUFFIX =
    "Respond only by calling the `record_traceability` tool, exactly once, with your complete answer. Do not reply in text.";

  function expectedTools(): unknown[] {
    return [
      {
        name: "record_traceability",
        description: "Record the traceability verdict for one claim against the candidate Experience Units.",
        input_schema: zodToToolSchema(TraceabilityResponseV1Schema),
      },
    ];
  }

  const SUPPORTED = {
    supports: true,
    supporting_unit_id: "unit-a",
    rationale: "Unit unit-a states the 30% memory reduction.",
  };
  const runWith = (client: Anthropic, record: typeof RecordUsage) =>
    checkTraceability(CLAIM, [makeUnit()], CTX, { client, record });

  it("baseline request is byte-identical to the pre-#489 shape", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SUPPORTED)]);
    await checkTraceability(CLAIM, [makeUnit()], CTX, { client, record });
    const prompt = loadPromptText("validation", "traceability");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toStrictEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: prompt.system,
      tools: expectedTools(),
      tool_choice: { type: "tool", name: "record_traceability" },
      messages: [{ role: "user", content: `${prompt.userFewShot}\n\nClaim: ${quote(CLAIM.text)}\n\nCandidate Experience Units:\n\n${formatUnit(makeUnit())}` }],
      stream: false,
    });
    expect(create.mock.calls[0]![1]).toStrictEqual({ signal: undefined });
  });

  it("passes the caller's signal and nothing else as request options", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SUPPORTED)]);
    const controller = new AbortController();
    await checkTraceability(CLAIM, [makeUnit()], { ...CTX, signal: controller.signal }, { client, record });
    expect(create.mock.calls[0]![1]).toStrictEqual({ signal: controller.signal });
  });

  it("a Sonnet 5.5 override with medium effort sends auto tool choice, the suffix, effort and a doubled cap", async () => {
    setModelOverrides({ traceability: SONNET_55 });
    setEffortOverrides({ traceability: "medium" });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SUPPORTED)]);
    await checkTraceability(CLAIM, [makeUnit()], CTX, { client, record });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.max_tokens).toBe(1024 * 2);
    expect(String(body.system).endsWith(SUFFIX)).toBe(true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "validation",
        subtask: "traceability",
        model: "claude-sonnet-5-5",
        maxTokens: 1024 * 2,
        effort: "medium",
      }),
    );
  });

  it("a Sonnet 5.5 override with no effort sends and records the profile default", async () => {
    setModelOverrides({ traceability: SONNET_55 });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SUPPORTED)]);
    await checkTraceability(CLAIM, [makeUnit()], CTX, { client, record });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: "high" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("refuses an effort on a 4.x pin before any request", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    setEffortOverrides({ traceability: "low" });
    const first = mockClient([mockMessage(SUPPORTED)]);
    await expect(runWith(first.client, record)).rejects.toThrow(/does not accept an effort setting/);
    expect(first.create).not.toHaveBeenCalled();

    setModelOverrides({ traceability: HAIKU_45 });
    const second = mockClient([mockMessage(SUPPORTED)]);
    await expect(runWith(second.client, record)).rejects.toThrow(/does not accept an effort setting/);
    expect(second.create).not.toHaveBeenCalled();
  });

  it("an override on another validation stage leaves this one on its default", async () => {
    setModelOverrides({ claim_extraction: HAIKU_45 });
    setEffortOverrides({ claim_extraction: "low" });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SUPPORTED)]);
    await checkTraceability(CLAIM, [makeUnit()], CTX, { client, record });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body).not.toHaveProperty("output_config");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ subtask: "traceability", model: "claude-sonnet-4-6", maxTokens: 1024 }));
    expect(record.mock.calls[0]![0]).not.toHaveProperty("effort");
  });

  it("still short-circuits empty candidate Units with no request, even under an invalid effort override", async () => {
    setEffortOverrides({ traceability: "low" });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);
    const result = await checkTraceability(CLAIM, [], CTX, { client, record });
    expect(result).toEqual({ supports: false, rationale: EMPTY_UNITS_RATIONALE });
    expect(create).not.toHaveBeenCalled();
  });
});
