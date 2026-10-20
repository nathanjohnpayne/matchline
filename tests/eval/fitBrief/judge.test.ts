import { describe, expect, it, vi } from "vitest";

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";
import type { recordUsage as RecordUsage } from "../../../functions/src/llm/cost.ts";

import { judgeBrief, type JudgeResult } from "./judge.ts";

const JUDGEMENT: JudgeResult = {
  reference_points: [{ kind: "strength", jd_clause: "c", point: "p", coverage: "partial" }],
  generated_points: [{ kind: "exposure", point: "g", matches_reference: false }],
  unsupported_candidate_claims: [{ quote: "Ran a twelve-team platform.", reason: "not in sources" }],
  claim_rule_violations: [],
  reference_verdict: "hold",
};

function reply(input: unknown, extra: Record<string, unknown> = {}) {
  return {
    model: "claude-opus-5-5",
    content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t", name: "record_judgement", input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  };
}

function client(...responses: unknown[]): Anthropic {
  const queue = [...responses];
  return { messages: { create: vi.fn(async () => queue.shift()) } } as unknown as Anthropic;
}

const INPUT = {
  jdText: "JD",
  referenceText: "Reference brief",
  generated: {
    bottom_line: "b",
    strengths: [{ jd_clause: "c", evidence: ["e"], argument: "a" }],
    exposures: [],
    positioning: "p",
    homework: [],
    questions_to_ask: [],
    does_not_claim: [],
    verdict: "apply" as const,
  },
  sourcesText: "Résumé",
  claimRulesText: "Never claim PCI certification.",
};

describe("judgeBrief", () => {
  it("returns the parsed judgement and records judge usage", async () => {
    const c = client(reply(JUDGEMENT));
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    expect(await judgeBrief(INPUT, { client: c, model: "claude-opus-5-5", effort: "high", record })).toEqual(JUDGEMENT);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "fit_brief_judge", model: "claude-opus-5-5", effort: "high" }),
    );
    const body = vi.mocked(c.messages.create).mock.calls[0]![0] as { tool_choice: unknown; messages: { content: string }[] };
    // Opus 5.5 rejects forced tool choice.
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.messages[0]!.content).toContain("Never claim PCI certification.");
    expect(body.messages[0]!.content).toContain("Reference brief");
  });

  it("retries a malformed judgement", async () => {
    const c = client(reply({ nope: true }), reply(JUDGEMENT));
    await expect(
      judgeBrief(INPUT, { client: c, model: "claude-opus-5-5", record: vi.fn<typeof RecordUsage>(async () => 0) }),
    ).resolves.toEqual(JUDGEMENT);
  });

  it("stops on truncation instead of retrying at the same budget (Codex P1, #581)", async () => {
    const c = client(reply(JUDGEMENT, { stop_reason: "max_tokens" }), reply(JUDGEMENT));
    await expect(
      judgeBrief(INPUT, { client: c, model: "claude-opus-5-5", record: vi.fn<typeof RecordUsage>(async () => 0) }),
    ).rejects.toThrow(/truncated/);
    expect(vi.mocked(c.messages.create)).toHaveBeenCalledTimes(1);
  });

  it("throws on a refusal rather than scoring nothing", async () => {
    const c = client(reply(JUDGEMENT, { content: [], stop_reason: "refusal" }));
    await expect(
      judgeBrief(INPUT, { client: c, model: "claude-opus-5-5", record: vi.fn<typeof RecordUsage>(async () => 0) }),
    ).rejects.toThrow(/declined/);
  });
});
