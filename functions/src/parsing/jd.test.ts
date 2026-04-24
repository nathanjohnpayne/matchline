import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";

import { JdParsingError } from "./errors.ts";
import { parseJobRequirements } from "./jd.ts";

function mockMessage(
  toolInput: unknown,
  usage = { input_tokens: 80, output_tokens: 40 },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "record_job_requirements",
        input: toolInput,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
  } as Anthropic.Messages.Message;
}

function mockClient(responses: Anthropic.Messages.Message[]): Anthropic {
  const queue = [...responses];
  return {
    messages: {
      create: vi.fn(async () => {
        const next = queue.shift();
        if (!next) throw new Error("mock client: no more queued responses");
        return next;
      }),
    },
  } as unknown as Anthropic;
}

const VALID_RESPONSE = {
  requirements: [
    {
      raw_text: "5+ years PM experience.",
      normalized_requirement: "5+ years product management experience.",
      category: "experience_level",
      keywords: ["5+ years", "product management"],
      tools: [],
      domains: [],
      priority: "high",
      must_have: true,
      extracted_from: "qualifications",
    },
    {
      raw_text: "Experience with HLS.",
      normalized_requirement: "HLS streaming protocol experience.",
      category: "tool",
      keywords: [],
      tools: ["HLS"],
      domains: ["streaming video infrastructure"],
      priority: "high",
      must_have: true,
      extracted_from: "qualifications",
      seniority_level: "senior",
    },
  ],
};

const CTX = { ownerUid: "user-alice", roleId: "role-1" };

describe("parseJobRequirements", () => {
  it("stamps server-side fields and returns JobRequirementUnits on first-attempt success", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const ids = ["id-1", "id-2"];
    const client = mockClient([mockMessage(VALID_RESPONSE)]);

    const reqs = await parseJobRequirements("JD text", CTX, {
      client,
      record,
      generateId: () => ids.shift() ?? "fallback",
    });

    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.id).toBe("id-1");
    expect(reqs[0]!.owner_uid).toBe("user-alice");
    expect(reqs[0]!.role_id).toBe("role-1");
    expect(reqs[0]!.must_have).toBe(true);
    expect(reqs[0]!.category).toBe("experience_level");

    // seniority_level only stamped when present — first req should
    // not have it, second should.
    expect(reqs[0]!.seniority_level).toBeUndefined();
    expect(reqs[1]!.seniority_level).toBe("senior");

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "requirement_parsing",
        provider: "anthropic",
        inputTokens: 80,
        outputTokens: 40,
        ownerUid: "user-alice",
      }),
    );
  });

  it("retries once on schema failure and succeeds on the second attempt", async () => {
    const malformed = { requirements: [{ wrong_shape: true }] };
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const client = mockClient([
      mockMessage(malformed),
      mockMessage(VALID_RESPONSE),
    ]);

    const reqs = await parseJobRequirements("JD text", CTX, {
      client,
      record,
      generateId: () => "id-stub",
    });

    expect(reqs).toHaveLength(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("throws JdParsingError after 3 consecutive schema failures", async () => {
    const malformed = { requirements: [{ wrong_shape: true }] };
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const client = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(malformed),
    ]);

    await expect(
      parseJobRequirements("JD text", CTX, { client, record }),
    ).rejects.toBeInstanceOf(JdParsingError);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("JdParsingError carries per-attempt failure log", async () => {
    const malformed = { requirements: [{ wrong_shape: true }] };
    const client = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(malformed),
    ]);
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);

    try {
      await parseJobRequirements("JD text", CTX, { client, record });
      expect.fail("expected JdParsingError");
    } catch (err) {
      expect(err).toBeInstanceOf(JdParsingError);
      const pe = err as JdParsingError;
      expect(pe.failures).toHaveLength(3);
      expect(pe.failures.every((f) => f.kind === "schema_error")).toBe(true);
    }
  });

  it("retries on missing tool_use response", async () => {
    const noToolUse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "I can't help with that." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 10 },
    } as unknown as Anthropic.Messages.Message;
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const client = mockClient([noToolUse, mockMessage(VALID_RESPONSE)]);

    const reqs = await parseJobRequirements("JD text", CTX, {
      client,
      record,
      generateId: () => "id-stub",
    });

    expect(reqs).toHaveLength(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("records transport_error without calling record (no token counts available)", async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("ETIMEDOUT");
        }),
      },
    } as unknown as Anthropic;
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);

    await expect(
      parseJobRequirements("JD text", CTX, { client, record }),
    ).rejects.toBeInstanceOf(JdParsingError);
    expect(record).toHaveBeenCalledTimes(0);
  });

  it("stamps role_id from ctx on every returned Unit", async () => {
    const client = mockClient([mockMessage(VALID_RESPONSE)]);
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);

    const reqs = await parseJobRequirements("JD text", {
      ownerUid: "user-alice",
      roleId: "role-xyz",
    }, {
      client,
      record,
      generateId: () => "id-stub",
    });

    expect(reqs.every((r) => r.role_id === "role-xyz")).toBe(true);
  });
});
