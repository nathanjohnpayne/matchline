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

describe("checkSpecificity: deny-list as LLM hint (Codex P1 round 1 on #113)", () => {
  // The deny-list is now a HINT to the LLM, not a hard veto.
  // Every deny-list match produces an LLM call with the matched
  // pattern as context; the LLM decides specific=true/false
  // based on whether the rest of the claim has anchors that
  // override the trope.
  //
  // The result.matched_pattern still surfaces when a deny-list
  // hit occurred — the orchestrator uses it for the
  // "trope detected, LLM decided X" UX.

  it("EVERY deny-list entry triggers an LLM call with the matched pattern as context", async () => {
    // Pin: deny-list match → LLM call. The matched_pattern is
    // surfaced in the result so the orchestrator can display
    // both signals.
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);

    for (const entry of SPECIFICITY_DENY_LIST) {
      const { client, create } = mockClient([
        mockMessage({
          specific: false,
          rationale: "Vague — no concrete anchors override the trope.",
        }),
      ]);
      const claim = makeClaim(`The user ${entry.pattern} on the project.`);
      const result = await checkSpecificity(claim, CTX, { client, record });

      expect(result.specific).toBe(false);
      expect(result.matched_pattern).toBe(entry.pattern);
      expect(create).toHaveBeenCalledTimes(1);

      // The LLM-call user content includes the deny-list hint.
      const callArgs = create.mock.calls[0]![0] as {
        messages: { content: string }[];
      };
      expect(callArgs.messages[0]!.content).toContain(
        `contains the phrase ${JSON.stringify(entry.pattern)}`,
      );
    }
  });

  it("LLM can OVERRIDE a deny-list match: trope + concrete anchors → specific=true", async () => {
    // The load-bearing fix for Codex P1 round 1. A claim like
    // "drove results — shipped a 30% revenue lift" trips the
    // deny-list AND has concrete anchors. The LLM gets the trope
    // as a hint but sees the rest of the claim and rules
    // specific=true.
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      mockMessage({
        specific: true,
        rationale:
          "Despite the 'drove results' phrasing, the claim names a specific metric (30%) and a surface (revenue) — verifiable.",
      }),
    ]);

    const result = await checkSpecificity(
      makeClaim("The user drove results — shipped a 30% revenue lift."),
      CTX,
      { client, record },
    );

    // LLM overrode the trope.
    expect(result.specific).toBe(true);
    // matched_pattern STILL surfaces — the deny-list hit happened.
    expect(result.matched_pattern).toBe("drove results");
    // The rationale comes from the LLM, not the deny-list curator.
    expect(result.rationale).toContain("30%");
  });

  it("matches case-insensitively (claim text might be uppercase)", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client, create } = mockClient([
      mockMessage({
        specific: false,
        rationale: "No concrete anchors override the trope.",
      }),
    ]);
    const claim = makeClaim(
      "The user COLLABORATED CROSS-FUNCTIONALLY across teams.",
    );
    const result = await checkSpecificity(claim, CTX, { client, record });
    expect(result.matched_pattern).toBe("collaborated cross-functionally");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns the FIRST matching pattern (exact-pin) when a claim contains multiple deny-list phrases", async () => {
    // CR Major on PR #113: pin the first-hit ordering EXACTLY,
    // not "either is acceptable". The contract is
    // "deny-list-order; earlier entries win". `drove results`
    // appears at index 2 in SPECIFICITY_DENY_LIST; `leveraged
    // data` appears at index 4. So `drove results` wins.
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      mockMessage({
        specific: false,
        rationale: "Vague — no anchors.",
      }),
    ]);
    const claim = makeClaim(
      "The user drove results and leveraged data on the migration.",
    );
    const result = await checkSpecificity(claim, CTX, { client, record });

    expect(result.matched_pattern).toBe("drove results");
  });

  it("normalizes a deps-injected deny-list with mixed-case patterns (CodeRabbit Minor on PR #113)", async () => {
    // The matcher lowercases BOTH the claim text AND the
    // deny-list entry's pattern. A custom deny-list passed via
    // DI with mixed-case patterns still matches.
    const customDenyList = [
      { pattern: "Did STUFF", reason: "Way too vague." },
    ];
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      mockMessage({
        specific: false,
        rationale: "No anchors.",
      }),
    ]);

    const result = await checkSpecificity(
      makeClaim("The user did stuff on the team."),
      CTX,
      { client, record, denyList: customDenyList },
    );

    // The deny-list entry's pattern is preserved as-given (the
    // matched_pattern field returns the curator's original
    // casing); the comparison itself is case-insensitive.
    expect(result.matched_pattern).toBe("Did STUFF");
  });

  it("accepts a custom deny-list via dep injection (testability pin)", async () => {
    const customDenyList = [
      {
        pattern: "did stuff",
        reason: "Way too vague.",
      },
    ];
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([
      mockMessage({
        specific: false,
        rationale: "Vague.",
      }),
    ]);

    const result = await checkSpecificity(
      makeClaim("The user did stuff on the team."),
      CTX,
      { client, record, denyList: customDenyList },
    );

    expect(result.matched_pattern).toBe("did stuff");
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

  it("recordUsage rejection is swallowed; the LLM verdict still ships (CodeRabbit on #113)", async () => {
    // Pin: cost telemetry is observability infrastructure. A
    // Firestore 503 (or any other recordUsage failure) must NOT
    // discard an otherwise-successful specificity verdict. The
    // try/catch around `await record(...)` enforces this.
    const record = vi.fn<typeof RecordUsage>(async () => {
      throw new Error("Firestore unavailable");
    });
    const { client } = mockClient([
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
    expect(record).toHaveBeenCalledTimes(1);
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
