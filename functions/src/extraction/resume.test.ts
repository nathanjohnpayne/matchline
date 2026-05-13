import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";

import { ExtractionError } from "./errors.ts";
import { extractFromResume } from "./resume.ts";

/**
 * Build a minimal Anthropic Message-shaped response that carries a
 * single tool_use block with the given input. Only the fields the
 * extraction core reads are populated.
 */
function mockMessage(
  toolInput: unknown,
  usage = { input_tokens: 100, output_tokens: 50 },
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
        name: "record_experience_units",
        input: toolInput,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
  } as Anthropic.Messages.Message;
}

/**
 * Build a mock Anthropic client whose `messages.create` returns the
 * queued responses in order. If the queue is empty, test-fails.
 */
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
  units: [
    {
      raw_text: "Led migration at X.",
      normalized_summary: "Led migration at X.",
      unit_type: "technical_decision",
      skills: ["migration"],
      tools: ["X"],
      domains: ["streaming"],
      seniority_signals: ["led"],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified",
      confidence_score: 0.9,
    },
  ],
};

describe("extractFromResume", () => {
  it("stamps server-side fields and returns typed ExperienceUnits on first-attempt success", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);
    const ids = ["id-1"];
    const now = new Date("2026-04-24T00:00:00Z");
    const client = mockClient([mockMessage(VALID_RESPONSE)]);

    const units = await extractFromResume(
      "Resume text here",
      { ownerUid: "user-alice" },
      {
        client,
        record,
        generateId: () => ids.shift() ?? "fallback",
        now: () => now,
      },
    );

    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.id).toBe("id-1");
    expect(u.owner_uid).toBe("user-alice");
    expect(u.source_type).toBe("resume");
    expect(u.source_ref).toMatch(/^resume:[0-9a-f]{16}:0$/);
    expect(u.user_approved).toBe(false);
    expect(u.created_at).toBe("2026-04-24T00:00:00.000Z");
    expect(u.updated_at).toBe("2026-04-24T00:00:00.000Z");
    expect(u.raw_text).toBe("Led migration at X.");

    // Cost recorded exactly once for the successful call.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "extraction",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 50,
        ownerUid: "user-alice",
      }),
    );
  });

  it("recordUsage rejection is swallowed; the LLM result still ships, warn logged without ownerUid (CodeRabbit on #113, #118)", async () => {
    // Pin THREE properties of the non-fatal telemetry contract:
    // result still ships, warn logged exactly once, ownerUid
    // omitted from payload. CodeRabbit Major on #116 / Trivial
    // on #118.
    const record = vi.fn<typeof RecordUsage>(async () => {
      throw new Error("Firestore unavailable");
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const client = mockClient([mockMessage(VALID_RESPONSE)]);

    try {
      const units = await extractFromResume(
        "Resume text here",
        { ownerUid: "user-alice" },
        {
          client,
          record,
          generateId: () => "id-1",
          now: () => new Date("2026-04-24T00:00:00Z"),
        },
      );

      expect(units).toHaveLength(1);
      expect(units[0]!.id).toBe("id-1");
      expect(record).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const warnPayload = warn.mock.calls[0]![1] as Record<string, unknown>;
      expect(warnPayload).not.toHaveProperty("ownerUid");
      expect(warnPayload).toMatchObject({
        stage: "extraction",
        error: "Firestore unavailable",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("retries once on schema failure and succeeds on the second attempt", async () => {
    const malformed = { units: [{ wrong_shape: true }] };
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);
    const client = mockClient([
      mockMessage(malformed),
      mockMessage(VALID_RESPONSE),
    ]);

    const units = await extractFromResume(
      "Resume text",
      { ownerUid: "user-alice" },
      {
        client,
        record,
        generateId: () => "id-1",
        now: () => new Date("2026-04-24T00:00:00Z"),
      },
    );

    expect(units).toHaveLength(1);
    // Cost recorded for BOTH attempts — retries aren't free, the
    // accounting must not undercount them.
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("retries twice on schema failure and succeeds on the third attempt", async () => {
    const malformed = { units: [{ wrong_shape: true }] };
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);
    const client = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(VALID_RESPONSE),
    ]);

    const units = await extractFromResume(
      "Resume text",
      { ownerUid: "user-alice" },
      {
        client,
        record,
        generateId: () => "id-1",
        now: () => new Date("2026-04-24T00:00:00Z"),
      },
    );

    expect(units).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("throws ExtractionError after 3 consecutive schema failures", async () => {
    const malformed = { units: [{ wrong_shape: true }] };
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);
    const client = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(malformed),
    ]);

    await expect(
      extractFromResume("Resume text", { ownerUid: "user-alice" }, { client, record }),
    ).rejects.toBeInstanceOf(ExtractionError);
    // Every attempt still logged usage.
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("ExtractionError carries a per-attempt failure log", async () => {
    const malformed = { units: [{ wrong_shape: true }] };
    const client = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(malformed),
    ]);
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);

    try {
      await extractFromResume(
        "Resume text",
        { ownerUid: "user-alice" },
        { client, record },
      );
      expect.fail("expected ExtractionError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtractionError);
      const ee = err as ExtractionError;
      expect(ee.failures).toHaveLength(3);
      expect(ee.failures.every((f) => f.kind === "schema_error")).toBe(true);
      expect(ee.failures.map((f) => f.attempt)).toEqual([0, 1, 2]);
    }
  });

  it("surfaces stop_reason: max_tokens as a max_tokens_exceeded failure and short-circuits the retry loop (#216)", async () => {
    // Reproduces the regression observed when running the eval
    // harness against Nathan's real resume: the prior 4096-token
    // budget hit the cap mid-tool-call, the SDK returned
    // `stop_reason: "max_tokens"` with `tool_use.input = {}`, and
    // the Zod parse bounced through all 3 retries with a
    // misleading "units: required" schema error. The code path
    // catches the truncation explicitly so debug runs see the
    // real cause, AND bails out after the first attempt because
    // an identical retry against the same budget cannot recover
    // (#216).
    const truncated = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: "toolu_test",
          name: "record_experience_units",
          // The wire shape we observed: empty input because
          // serialization was cut mid-stream.
          input: {},
        },
      ],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 4702, output_tokens: 4096 },
    } as unknown as Anthropic.Messages.Message;
    // Queue three truncations but expect only the first to be
    // consumed: the loop must break on the first max_tokens_exceeded.
    const client = mockClient([truncated, truncated, truncated]);
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);

    await expect(
      extractFromResume(
        "Resume",
        { ownerUid: "user-alice" },
        { client, record },
      ),
    ).rejects.toMatchObject({
      name: "ExtractionError",
      failures: [{ attempt: 0, kind: "max_tokens_exceeded" }],
    });
    // Exactly one API call and one recordUsage call — the retry
    // loop short-circuits because identical retries against the
    // same MAX_OUTPUT_TOKENS budget cannot recover. Budget
    // escalation is intentionally out of scope.
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("retries on missing tool_use (response has only text blocks)", async () => {
    const noToolUse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Sorry, I can't help with that." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 10 },
    } as unknown as Anthropic.Messages.Message;
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);
    const client = mockClient([noToolUse, mockMessage(VALID_RESPONSE)]);

    const units = await extractFromResume(
      "Resume text",
      { ownerUid: "user-alice" },
      {
        client,
        record,
        generateId: () => "id-1",
        now: () => new Date("2026-04-24T00:00:00Z"),
      },
    );

    expect(units).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("stamps deterministic source_ref per-unit index within a single input", async () => {
    // Two Units in one response should get distinct source_refs
    // differing only by index, so downstream dedup can detect
    // repeat-pastes by prefix.
    const twoUnits = {
      units: [VALID_RESPONSE.units[0]!, VALID_RESPONSE.units[0]!],
    };
    const client = mockClient([mockMessage(twoUnits)]);
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);

    let i = 0;
    const units = await extractFromResume(
      "Same input",
      { ownerUid: "user-alice" },
      {
        client,
        record,
        generateId: () => `id-${++i}`,
        now: () => new Date("2026-04-24T00:00:00Z"),
      },
    );

    expect(units).toHaveLength(2);
    expect(units[0]!.source_ref).toMatch(/:0$/);
    expect(units[1]!.source_ref).toMatch(/:1$/);
    // Prefix (hash part) is identical across units from the same input.
    const hash0 = units[0]!.source_ref.split(":")[1];
    const hash1 = units[1]!.source_ref.split(":")[1];
    expect(hash0).toBe(hash1);
  });

  it("records a transport_error failure on SDK exception", async () => {
    // Fake timers (per #115): the retry helper sleeps between
    // attempts, so on real timers this test paid ~1.7s of CI
    // tax across three attempts. Mirror the pattern from the
    // backoff test below: kick off the call, drain pending
    // timers + microtasks via runAllTimersAsync, then assert
    // the eventual rejection.
    vi.useFakeTimers();
    try {
      const client = {
        messages: {
          create: vi.fn(async () => {
            throw new Error("ETIMEDOUT");
          }),
        },
      } as unknown as Anthropic;
      const record = vi.fn<typeof RecordUsage>(async () => 0.01);

      const promise = extractFromResume(
        "Resume",
        { ownerUid: "user-alice" },
        { client, record },
      );
      // Attach the rejection assertion BEFORE draining timers so
      // the resulting unhandled-rejection window between
      // `runAllTimersAsync` settling and the explicit `await
      // expect(...).rejects` consuming the failure doesn't trigger
      // vitest's unhandled-rejection diagnostic.
      const rejection = expect(promise).rejects.toBeInstanceOf(
        ExtractionError,
      );
      await vi.runAllTimersAsync();
      await rejection;
      // No successful responses → recordUsage never called (nothing
      // to meter; no token counts available for a transport failure).
      expect(record).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off (non-zero setTimeout delay) before retrying after a transport error", async () => {
    // Pin: a transport error must not retry immediately. Without
    // backoff, a 429 produces 3 rapid retries that compound the
    // server's rate-limit window (CodeRabbit on PR #111). The
    // helper lives in functions/src/llm/retry.ts and is shared
    // across all four LLM call sites.
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const record = vi.fn<typeof RecordUsage>(async () => 0.01);
      const queue: (Anthropic.Messages.Message | Error)[] = [
        new Error("ECONNRESET"),
        mockMessage(VALID_RESPONSE),
      ];
      const client = {
        messages: {
          create: vi.fn(async () => {
            const next = queue.shift();
            if (!next) throw new Error("mock client: queue empty");
            if (next instanceof Error) throw next;
            return next;
          }),
        },
      } as unknown as Anthropic;

      const promise = extractFromResume(
        "Resume text",
        { ownerUid: "user-alice" },
        { client, record, generateId: () => "id-1" },
      );

      // Drain pending timers (the backoff sleep) + microtasks.
      await vi.runAllTimersAsync();
      const units = await promise;

      expect(units).toHaveLength(1);
      // At least one setTimeout call with a non-zero delay — that's
      // the backoff sleep between attempt 0 (transport error) and
      // attempt 1 (success). Filter for numeric delays only;
      // setTimeout can also be called by other infrastructure.
      const nonZeroDelays = setTimeoutSpy.mock.calls
        .map((call) => Number(call[1]))
        .filter((d) => Number.isFinite(d) && d > 0);
      expect(nonZeroDelays.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
