import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";

import { FitBriefError, fitBriefRequestFingerprint, generateFitBrief } from "./fitBrief.ts";

const BRIEF = {
  bottom_line: "Strong platform fit.",
  strengths: [
    {
      jd_clause: "platform products",
      evidence: ["Owned the checkout API used by four storefront teams."],
      argument: "Internal teams were the customers.",
    },
  ],
  exposures: [],
  positioning: "Lead with the API.",
  homework: [],
  questions_to_ask: [],
  does_not_claim: [],
  verdict: "apply",
};

function message(
  input: unknown,
  overrides: Partial<Anthropic.Messages.Message> = {},
): Anthropic.Messages.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: "t", name: "record_fit_brief", input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 500 },
    ...overrides,
  } as Anthropic.Messages.Message;
}

function client(responses: Anthropic.Messages.Message[]): Anthropic {
  const queue = [...responses];
  return {
    messages: {
      create: vi.fn(async () => {
        const next = queue.shift();
        if (!next) throw new Error("no more responses");
        return next;
      }),
    },
  } as unknown as Anthropic;
}

const INPUT = {
  jdText: "Senior PM, Payments Platform.",
  resumeText: "- Owned the checkout API used by four storefront teams.",
  claimRulesText: "Never claim PCI certification.",
};

describe("generateFitBrief", () => {
  it("returns the validated brief and records fit_brief usage", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const c = client([message(BRIEF)]);

    const result = await generateFitBrief(INPUT, { model: "claude-sonnet-4-6", client: c, record, runId: "r1" });

    expect(result.brief.verdict).toBe("apply");
    expect(result.inputTokens).toBe(1000);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "fit_brief",
        model: "claude-sonnet-4-6",
        promptVersion: "generation/fitBrief.v1",
        attempt: 0,
        runId: "r1",
      }),
    );
    const body = vi.mocked(c.messages.create).mock.calls[0]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
    const user = String(body.messages[0]!.content);
    expect(user).toContain("Senior PM, Payments Platform.");
    expect(user).toContain("Never claim PCI certification.");
  });

  it("retries once on a schema failure, with a reminder", async () => {
    const c = client([message({ ...BRIEF, verdict: "maybe" }), message(BRIEF)]);
    const result = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    });
    expect(result.brief.verdict).toBe("apply");
    const second = vi.mocked(c.messages.create).mock.calls[1]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
    expect(String(second.system)).toMatch(/failed schema validation/);
    // The model is told which field failed (CodeRabbit, #581).
    expect(String(second.system)).toMatch(/Validation errors:[\s\S]*verdict/);
  });

  it("asks Sonnet 5.5 for the tool with tool_choice auto and an effort", async () => {
    const c = client([message(BRIEF, { model: "claude-sonnet-5-5" })]);
    await generateFitBrief(INPUT, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    });
    const body = vi.mocked(c.messages.create).mock.calls[0]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it("stops on a refusal and says so", async () => {
    const c = client([
      message(BRIEF, { content: [], stop_reason: "refusal" } as Partial<Anthropic.Messages.Message>),
      message(BRIEF),
    ]);
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FitBriefError);
    expect((err as FitBriefError).message).toMatch(/declined by the model/);
    expect(vi.mocked(c.messages.create)).toHaveBeenCalledTimes(1);
  });

  it("stops on truncation instead of paying for retries that truncate the same way", async () => {
    const c = client([
      message(BRIEF, { stop_reason: "max_tokens" } as Partial<Anthropic.Messages.Message>),
      message(BRIEF),
    ]);
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    }).catch((e: unknown) => e);
    expect((err as FitBriefError).message).toMatch(/truncated/);
    expect(vi.mocked(c.messages.create)).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable API error (CodeRabbit, #581)", async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error("invalid_request_error"), { status: 400 });
    });
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: { messages: { create } } as unknown as Anthropic,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FitBriefError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 429 that reports the spend limit (CodeRabbit, #581)", async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error("429"), {
        status: 429,
        error: { type: "error", error: { type: "rate_limit_error", details: { error_code: "enforced_spend_limit_reached" } } },
      });
    });
    await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: { messages: { create } } as unknown as Anthropic,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      sleep: async () => {},
    }).catch(() => undefined);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit", async () => {
    let calls = 0;
    const create = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate_limit"), { status: 429 });
      return message(BRIEF);
    });
    const result = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: { messages: { create } } as unknown as Anthropic,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      sleep: async () => {},
    });
    expect(result.brief.verdict).toBe("apply");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fails after three attempts without a tool call", async () => {
    const text = message(BRIEF, { content: [{ type: "text", text: "no" }] } as Partial<Anthropic.Messages.Message>);
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: client([text, text, text]),
      record: vi.fn<typeof RecordUsage>(async () => 0),
    }).catch((e: unknown) => e);
    expect((err as FitBriefError).failures.map((f) => f.kind)).toEqual([
      "no_tool_use",
      "no_tool_use",
      "no_tool_use",
    ]);
  });
});

describe("fitBriefRequestFingerprint", () => {
  it("is a stable short hash of the request template (Codex P2, #581)", () => {
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).toBe(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium"));
    // The resolved per-model request shape is part of it.
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).not.toBe(fitBriefRequestFingerprint("claude-sonnet-4-6"));
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).not.toBe(fitBriefRequestFingerprint("claude-sonnet-5-5", "high"));
  });
});
