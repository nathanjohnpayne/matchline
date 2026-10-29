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
import { ClaimExtractionResponseV1Schema } from "../prompts/validation/claimExtraction.v1.schema.ts";

import { extractClaims } from "./claimExtraction.ts";
import { ClaimExtractionError } from "./errors.ts";

/**
 * Per-stage model configuration for `claim_extraction` (#489): the request on
 * the production pin, a 5.5 override's shape and usage record, effort
 * refusal on 4.x pins, and isolation from the other validation stages.
 * Kept apart from `claimExtraction.test.ts` so the module's behavioural tests and
 * these configuration tests change independently. Mocked Anthropic
 * client; no I/O.
 */

function mockMessage(
  toolInput: unknown,
  usage = { input_tokens: 100, output_tokens: 50 },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    // Loosely mirrors `modelFor("claim_extraction")`. Pin via the
    // production-config import would couple unit tests to the
    // config module; instead we keep this string aligned by
    // inspection (CodeRabbit Trivial on PR #110).
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "record_claims",
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

const CTX = {
  ownerUid: "user-alice",
  assetId: "asset-1",
  bulletId: "bullet-1",
};

const VALID_RESPONSE = {
  claims: [
    {
      text: "The user led a 64-bit NCP migration project.",
      raw_span: "Led 64-bit NCP migration",
    },
    {
      text: "The user worked on the Disney+ playback stack.",
      raw_span: "Disney+ playback stack",
    },
    {
      text: "The user achieved a 30% reduction in memory footprint.",
      raw_span: "reduced memory footprint 30%",
    },
  ],
};

describe("claim_extraction: separately configurable model stage (#489)", () => {
  afterEach(() => {
    clearModelOverrides();
    clearEffortOverrides();
  });

  const HAIKU_45 = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" };
  const SONNET_55 = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };
  const SUFFIX =
    "Respond only by calling the `record_claims` tool, exactly once, with your complete answer. Do not reply in text.";

  function expectedTools(): unknown[] {
    return [
      {
        name: "record_claims",
        description: "Record atomic claims extracted from a generated resume bullet.",
        input_schema: zodToToolSchema(ClaimExtractionResponseV1Schema),
      },
    ];
  }

  const BULLET = "Led 64-bit NCP migration on Disney+ playback stack (reduced memory 30%).";
  const runWith = (client: Anthropic, record: typeof RecordUsage) =>
    extractClaims({ text: BULLET, source_unit_ids: ["unit-1"] }, CTX, { client, record });

  it("baseline request is byte-identical to the pre-#489 shape", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(VALID_RESPONSE)]);
    await extractClaims({ text: BULLET, source_unit_ids: ["unit-1"] }, CTX, { client, record, generateId: () => "c" });
    const prompt = loadPromptText("validation", "claimExtraction");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toStrictEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: prompt.system,
      tools: expectedTools(),
      tool_choice: { type: "tool", name: "record_claims" },
      messages: [{ role: "user", content: `${prompt.userFewShot}\n\nBullet to decompose:\n\n${BULLET}` }],
      stream: false,
    });
    expect(create.mock.calls[0]![1]).toStrictEqual({ signal: undefined });
  });

  it("passes the caller's signal and nothing else as request options", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(VALID_RESPONSE)]);
    const controller = new AbortController();
    await extractClaims({ text: BULLET, source_unit_ids: ["unit-1"] }, { ...CTX, signal: controller.signal }, { client, record, generateId: () => "c" });
    expect(create.mock.calls[0]![1]).toStrictEqual({ signal: controller.signal });
  });

  it("a Sonnet 5.5 override with medium effort sends auto tool choice, the suffix, effort and a doubled cap", async () => {
    setModelOverrides({ claim_extraction: SONNET_55 });
    setEffortOverrides({ claim_extraction: "medium" });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(VALID_RESPONSE)]);
    await extractClaims({ text: BULLET, source_unit_ids: ["unit-1"] }, CTX, { client, record, generateId: () => "c" });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.max_tokens).toBe(2048 * 2);
    expect(String(body.system).endsWith(SUFFIX)).toBe(true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "validation",
        subtask: "claim_extraction",
        model: "claude-sonnet-5-5",
        maxTokens: 2048 * 2,
        effort: "medium",
      }),
    );
  });

  it("a Sonnet 5.5 override with no effort sends and records the profile default", async () => {
    setModelOverrides({ claim_extraction: SONNET_55 });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(VALID_RESPONSE)]);
    await extractClaims({ text: BULLET, source_unit_ids: ["unit-1"] }, CTX, { client, record, generateId: () => "c" });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: "high" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("refuses an effort on a 4.x pin before any request", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    setEffortOverrides({ claim_extraction: "low" });
    const first = mockClient([mockMessage(VALID_RESPONSE)]);
    await expect(runWith(first.client, record)).rejects.toThrow(/does not accept an effort setting/);
    expect(first.create).not.toHaveBeenCalled();

    setModelOverrides({ claim_extraction: HAIKU_45 });
    const second = mockClient([mockMessage(VALID_RESPONSE)]);
    await expect(runWith(second.client, record)).rejects.toThrow(/does not accept an effort setting/);
    expect(second.create).not.toHaveBeenCalled();
  });

  it("an override on another validation stage leaves this one on its default", async () => {
    setModelOverrides({ traceability: HAIKU_45 });
    setEffortOverrides({ traceability: "low" });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(VALID_RESPONSE)]);
    await extractClaims({ text: BULLET, source_unit_ids: ["unit-1"] }, CTX, { client, record, generateId: () => "c" });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body).not.toHaveProperty("output_config");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ subtask: "claim_extraction", model: "claude-sonnet-4-6", maxTokens: 2048 }));
    expect(record.mock.calls[0]![0]).not.toHaveProperty("effort");
  });

  it("still rejects an empty bullet before resolving the request shape", async () => {
    setEffortOverrides({ claim_extraction: "low" });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);
    await expect(
      extractClaims({ text: "   ", source_unit_ids: [] }, CTX, { client, record }),
    ).rejects.toBeInstanceOf(ClaimExtractionError);
    expect(create).not.toHaveBeenCalled();
  });
});
