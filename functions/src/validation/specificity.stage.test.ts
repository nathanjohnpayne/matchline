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
import { SpecificityResponseV1Schema } from "../prompts/validation/specificity.v1.schema.ts";

import type { Claim } from "./claimExtraction.ts";
import { checkSpecificity } from "./specificity.ts";

/**
 * Per-stage model configuration for `specificity` (#489): the request on
 * the production pin, a 5.5 override's shape and usage record, effort
 * refusal on 4.x pins, and isolation from the other validation stages.
 * Kept apart from `specificity.test.ts` so the module's behavioural tests and
 * these configuration tests change independently. Mocked Anthropic
 * client; no I/O.
 */

function mockMessage(
  toolInput: unknown,
  usage = { input_tokens: 80, output_tokens: 40 },
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
        name: "record_specificity",
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

function makeClaim(text: string): Claim {
  return { id: "claim-1", bullet_id: "bullet-1", text };
}

// -- Layer 1: deny-list ------------------------------------------------------

describe("specificity: separately configurable model stage (#489)", () => {
  afterEach(() => {
    clearModelOverrides();
    clearEffortOverrides();
  });

  const HAIKU_45 = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" };
  const SONNET_55 = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };
  const SUFFIX =
    "Respond only by calling the `record_specificity` tool, exactly once, with your complete answer. Do not reply in text.";

  function expectedTools(): unknown[] {
    return [
      {
        name: "record_specificity",
        description: "Record the specificity verdict for one claim — is it specific enough to fact-check?",
        input_schema: zodToToolSchema(SpecificityResponseV1Schema),
      },
    ];
  }

  const TEXT = "The user cut p99 job latency 60% by replacing Sidekiq with Postgres LISTEN/NOTIFY.";
  const SPECIFIC = { specific: true, rationale: "Names the system and a measured result." };
  const runWith = (client: Anthropic, record: typeof RecordUsage) =>
    checkSpecificity(makeClaim(TEXT), CTX, { client, record, denyList: [] });

  it("baseline request is byte-identical to the pre-#489 shape", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SPECIFIC)]);
    await checkSpecificity(makeClaim(TEXT), CTX, { client, record, denyList: [] });
    const prompt = loadPromptText("validation", "specificity");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toStrictEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: prompt.system,
      tools: expectedTools(),
      tool_choice: { type: "tool", name: "record_specificity" },
      messages: [{ role: "user", content: `${prompt.userFewShot}\n\nClaim: ${JSON.stringify(TEXT)}` }],
      stream: false,
    });
    expect(create.mock.calls[0]![1]).toStrictEqual({ signal: undefined });
  });

  it("passes the caller's signal and nothing else as request options", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SPECIFIC)]);
    const controller = new AbortController();
    await checkSpecificity(makeClaim(TEXT), { ...CTX, signal: controller.signal }, { client, record, denyList: [] });
    expect(create.mock.calls[0]![1]).toStrictEqual({ signal: controller.signal });
  });

  it("a Sonnet 5.5 override with medium effort sends auto tool choice, the suffix, effort and a doubled cap", async () => {
    setModelOverrides({ specificity: SONNET_55 });
    setEffortOverrides({ specificity: "medium" });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SPECIFIC)]);
    await checkSpecificity(makeClaim(TEXT), CTX, { client, record, denyList: [] });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.max_tokens).toBe(512 * 2);
    expect(String(body.system).endsWith(SUFFIX)).toBe(true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "validation",
        subtask: "specificity",
        model: "claude-sonnet-5-5",
        maxTokens: 512 * 2,
        effort: "medium",
      }),
    );
  });

  it("a Sonnet 5.5 override with no effort sends and records the profile default", async () => {
    setModelOverrides({ specificity: SONNET_55 });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SPECIFIC)]);
    await checkSpecificity(makeClaim(TEXT), CTX, { client, record, denyList: [] });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.output_config).toEqual({ effort: "high" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });

  it("refuses an effort on a 4.x pin before any request", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    setEffortOverrides({ specificity: "low" });
    const first = mockClient([mockMessage(SPECIFIC)]);
    await expect(runWith(first.client, record)).rejects.toThrow(/does not accept an effort setting/);
    expect(first.create).not.toHaveBeenCalled();

    setModelOverrides({ specificity: HAIKU_45 });
    const second = mockClient([mockMessage(SPECIFIC)]);
    await expect(runWith(second.client, record)).rejects.toThrow(/does not accept an effort setting/);
    expect(second.create).not.toHaveBeenCalled();
  });

  it("an override on another validation stage leaves this one on its default", async () => {
    setModelOverrides({ traceability: HAIKU_45 });
    setEffortOverrides({ traceability: "low" });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SPECIFIC)]);
    await checkSpecificity(makeClaim(TEXT), CTX, { client, record, denyList: [] });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body).not.toHaveProperty("output_config");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ subtask: "specificity", model: "claude-sonnet-4-6", maxTokens: 512 }));
    expect(record.mock.calls[0]![0]).not.toHaveProperty("effort");
  });

  it("a deny-list hit is still a hint: the model is called once on the overridden stage", async () => {
    setModelOverrides({ specificity: HAIKU_45 });
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([mockMessage(SPECIFIC)]);
    await checkSpecificity(makeClaim("Drove results across the org."), CTX, {
      client,
      record,
      denyList: [{ pattern: "drove results", reason: "empty trope" }],
    });
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]![0] as { model: string; messages: { content: string }[] };
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.messages[0]!.content).toContain("drove results");
  });
});
