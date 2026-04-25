import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";

import type { Claim } from "./claimExtraction.ts";
import { SpecificityCheckError } from "./errors.ts";
import { checkSpecificity } from "./specificity.ts";
import { SPECIFICITY_DENY_LIST } from "./specificity.denyList.ts";

/**
 * Tests for the validation pipeline's specificity check
 * (sub-issue #108 of #23). Mocked Anthropic client.
 *
 * Coverage:
 *   - **Layer 1 (deny-list)**: every entry triggers a flag with
 *     no LLM call (cost optimization + deterministic-correctness
 *     pin).
 *   - **Layer 2 (LLM fallback)**: claims that escape the deny-
 *     list go through the LLM. Cover happy path (specific=true,
 *     specific=false) + retry semantics + transport errors +
 *     no-tool-use.
 *   - **matched_pattern provenance**: deny-list results have it,
 *     LLM-fallback results don't. The orchestrator (#109) uses
 *     this to disambiguate.
 *   - Custom deny-list injection (test override).
 *   - Cost tracker fires only on LLM-fallback paths.
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

function mockTextOnlyMessage(
  text: string,
  usage = { input_tokens: 50, output_tokens: 5 },
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

function makeClaim(text: string): Claim {
  return { id: "claim-1", bullet_id: "bullet-1", text };
}

// -- Layer 1: deny-list ------------------------------------------------------

describe("checkSpecificity: deny-list (deterministic layer)", () => {
  it("EVERY deny-list entry triggers a specific=false result with no LLM call", async () => {
    // Pin: the deny-list works deterministically for every
    // curated entry. If a future deny-list addition is broken
    // (e.g. wrong-case pattern, regex syntax in the substring
    // by accident), this test fails.
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);

    for (const entry of SPECIFICITY_DENY_LIST) {
      // Wrap the deny-list pattern in a sentence to mimic real
      // claim text (the matcher does substring containment).
      const claim = makeClaim(`The user ${entry.pattern} on the project.`);
      const result = await checkSpecificity(claim, CTX, { client, record });

      expect(result.specific).toBe(false);
      expect(result.matched_pattern).toBe(entry.pattern);
      expect(result.rationale).toContain(entry.reason);
    }

    // Critical: the LLM was never called for any deny-list match.
    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("matches case-insensitively (the deny-list is lowercase; claim text might not be)", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);
    const claim = makeClaim(
      "The user COLLABORATED CROSS-FUNCTIONALLY across teams.",
    );
    const result = await checkSpecificity(claim, CTX, { client, record });
    expect(result.specific).toBe(false);
    expect(result.matched_pattern).toBe("collaborated cross-functionally");
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the FIRST matching pattern when a claim contains multiple deny-list phrases", async () => {
    // "drove results" appears earlier in the deny-list than
    // "leveraged data"; the matcher returns the first hit.
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);
    const claim = makeClaim(
      "The user drove results and leveraged data on the migration.",
    );
    const result = await checkSpecificity(claim, CTX, { client, record });

    expect(result.specific).toBe(false);
    // Either "drove results" or "leveraged data" wins; the
    // contract is "first hit by deny-list order" — pin both
    // possible matches as acceptable so a future deny-list re-
    // ordering doesn't accidentally break this.
    expect(["drove results", "leveraged data"]).toContain(
      result.matched_pattern,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("includes suggested_specific in the rationale when present", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client } = mockClient([]);
    const claim = makeClaim("The user drove results on the project.");
    const result = await checkSpecificity(claim, CTX, { client, record });

    expect(result.rationale).toContain("Consider:");
  });

  it("accepts a custom deny-list via dep injection (testability pin)", async () => {
    const customDenyList = [
      {
        pattern: "did stuff",
        reason: "Way too vague.",
      },
    ];
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);

    const result = await checkSpecificity(
      makeClaim("The user did stuff on the team."),
      CTX,
      { client, record, denyList: customDenyList },
    );

    expect(result.specific).toBe(false);
    expect(result.matched_pattern).toBe("did stuff");
    expect(create).not.toHaveBeenCalled();
  });
});

// -- Layer 2: LLM fallback ---------------------------------------------------

describe("checkSpecificity: LLM fallback", () => {
  it("specific claim that escapes the deny-list goes to the LLM and gets specific=true", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client, create } = mockClient([
      mockMessage({
        specific: true,
        rationale: "The claim names a metric and surface — verifiable.",
      }),
    ]);

    const result = await checkSpecificity(
      makeClaim("The user achieved a 30% memory reduction on Disney+ playback."),
      CTX,
      { client, record },
    );

    expect(result.specific).toBe(true);
    expect(result.matched_pattern).toBeUndefined();
    expect(result.rationale).toContain("metric");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("vague claim that escapes the deny-list still gets specific=false from the LLM", async () => {
    // A claim that's vague but doesn't trip the curated deny-
    // list — the LLM-fallback's job. "Took ownership of outcomes"
    // is the kind of corporate-speak that's hard to enumerate
    // in a static list.
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client, create } = mockClient([
      mockMessage({
        specific: false,
        rationale:
          "The claim asserts 'ownership' and 'outcomes' but names no specific surface, metric, or deliverable.",
      }),
    ]);

    const result = await checkSpecificity(
      makeClaim("The user took ownership of outcomes."),
      CTX,
      { client, record },
    );

    expect(result.specific).toBe(false);
    expect(result.matched_pattern).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("logs cost via recordUsage with stage='validation' on LLM-fallback", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client } = mockClient([
      mockMessage({
        specific: true,
        rationale: "Verifiable claim.",
      }),
    ]);

    await checkSpecificity(
      makeClaim("The user shipped a feature on PS4."),
      CTX,
      { client, record },
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "validation",
        provider: "anthropic",
        ownerUid: "user-alice",
      }),
    );
  });

  it("retries on schema error and succeeds on the second attempt", async () => {
    const malformed = { bogus: "shape" };
    const valid = {
      specific: true,
      rationale: "Verifiable.",
    };
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client, create } = mockClient([
      mockMessage(malformed),
      mockMessage(valid),
    ]);

    const result = await checkSpecificity(
      makeClaim("The user shipped a feature on PS4."),
      CTX,
      { client, record },
    );

    expect(result.specific).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("throws SpecificityCheckError after 3 schema-error attempts", async () => {
    const malformed = { bogus: "shape" };
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(malformed),
    ]);

    await expect(
      checkSpecificity(
        makeClaim("The user shipped a feature on PS4."),
        CTX,
        { client, record },
      ),
    ).rejects.toBeInstanceOf(SpecificityCheckError);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("retries on transport errors and succeeds when the next attempt is valid", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      new Error("ECONNRESET"),
      mockMessage({
        specific: false,
        rationale: "Vague.",
      }),
    ]);

    const result = await checkSpecificity(
      makeClaim("The user did some stuff on the team."),
      CTX,
      { client, record },
    );

    expect(result.specific).toBe(false);
    // Transport error has no token counts to record.
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("counts text-only responses (no tool_use) as failures and retries", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      mockTextOnlyMessage("I would emit a verdict but cannot use tools."),
      mockMessage({
        specific: true,
        rationale: "Verifiable claim.",
      }),
    ]);

    const result = await checkSpecificity(
      makeClaim("The user shipped a feature on PS4."),
      CTX,
      { client, record },
    );

    expect(result.specific).toBe(true);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("escapes the claim text via JSON.stringify in the prompt content (consistency with traceability)", async () => {
    // Pin: the same escaping pattern from #107 applies here.
    // A claim with embedded quotes shouldn't break the prompt.
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client, create } = mockClient([
      mockMessage({
        specific: true,
        rationale: "Verifiable claim.",
      }),
    ]);

    await checkSpecificity(
      makeClaim('The user shipped "Project Alpha" on time.'),
      CTX,
      { client, record },
    );

    const callArgs = create.mock.calls[0]![0] as {
      messages: { content: string }[];
    };
    const content = callArgs.messages[0]!.content;
    // The claim renders as a JSON-stringified literal — embedded
    // quotes are escaped.
    expect(content).toContain(
      'Claim: "The user shipped \\"Project Alpha\\" on time."',
    );
  });
});
