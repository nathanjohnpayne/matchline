import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearEffortOverrides,
  clearModelOverrides,
  setEffortOverrides,
  setModelOverrides,
} from "../llm/config.ts";
import type { recordUsage as RecordUsage } from "../llm/cost.ts";
import { ExtractionResponseV1Schema } from "../prompts/extraction/resume.v1.schema.ts";

import { ExtractionError, type ExtractionAttemptFailure } from "./errors.ts";
import { extractFromResume, prepareToolInput } from "./resume.ts";

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

  it("surfaces stop_reason: max_tokens as a max_tokens_exceeded failure (not a misleading schema_error)", async () => {
    // Reproduces the regression observed when running the eval
    // harness against Nathan's real resume: the prior 4096-token
    // budget hit the cap mid-tool-call, the SDK returned
    // `stop_reason: "max_tokens"` with `tool_use.input = {}`, and
    // the Zod parse bounced through all 3 retries with a
    // misleading "units: required" schema error. The new code path
    // catches the truncation explicitly so debug runs see the
    // real cause.
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
    // Three identical truncations → ExtractionError with three
    // max_tokens_exceeded failures. Retries can't fix truncation.
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
      failures: [
        { attempt: 0, kind: "max_tokens_exceeded" },
        { attempt: 1, kind: "max_tokens_exceeded" },
        { attempt: 2, kind: "max_tokens_exceeded" },
      ],
    });
    // recordUsage still fires per attempt because tokens were
    // actually billed (output_tokens: 4096 each time). Cost
    // accounting must not undercount truncated retries.
    expect(record).toHaveBeenCalledTimes(3);
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

/**
 * Captured shape of the #495 failures (#650), with synthetic content:
 * `units` arrives as a string holding the JSON-encoded array, multi-Unit,
 * with the optional `date_range` and `metrics` populated.
 */
const CAPTURED_SHAPE_UNITS = [
  {
    raw_text: "Ran the payments platform team of six at Example Co.",
    normalized_summary: "Led a six-person payments platform team.",
    unit_type: "leadership",
    skills: ["team leadership"],
    tools: [],
    domains: ["payments"],
    seniority_signals: ["led"],
    scope_signals: ["team of six"],
    business_outcomes: [],
    metrics: [{ claim: "team of six", value: 6, confidence: "high" }],
    evidence_type: "verified",
    confidence_score: 0.85,
    date_range: { start: "2021-03-01", end: "2023-06-30" },
  },
  VALID_RESPONSE.units[0]!,
];

const UNITS_STRING_REMINDER_TEXT = "`units` must be a JSON array, not a string";

function systemOf(client: Anthropic, call: number): string {
  const body = vi.mocked(client.messages.create).mock.calls[call]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
  return String(body.system);
}

describe("prepareToolInput (#650)", () => {
  it("decodes a string-encoded units array into a copy and marks the recovery", () => {
    const input = { units: JSON.stringify(CAPTURED_SHAPE_UNITS) };
    const prepared = prepareToolInput(input);
    expect(prepared).toEqual({
      input: { units: CAPTURED_SHAPE_UNITS },
      unitsWasString: true,
      recovered: "units-string",
    });
    // The model's object is not mutated.
    expect(input.units).toBeTypeOf("string");
  });

  it("decodes an empty encoded array (boundary)", () => {
    expect(prepareToolInput({ units: "[]" })).toEqual({ input: { units: [] }, unitsWasString: true, recovered: "units-string" });
  });

  it("keeps other keys, unknown ones included, for the strict schema to judge", () => {
    const prepared = prepareToolInput({ units: "[]", extra: true });
    expect(prepared.input).toEqual({ units: [], extra: true });
    expect(ExtractionResponseV1Schema.safeParse(prepared.input).success).toBe(false);
  });

  it("returns an array-form input as the same object, with no recovery", () => {
    const input = { units: CAPTURED_SHAPE_UNITS };
    const prepared = prepareToolInput(input);
    expect(prepared.input).toBe(input);
    expect(prepared.unitsWasString).toBe(false);
    expect(prepared).not.toHaveProperty("recovered");
  });

  it.each([
    ["text that is not JSON", "Led migration at X."],
    ["a truncated array", '[{"raw_text": "Led'],
    ["an encoded object", JSON.stringify(VALID_RESPONSE)],
    ["an encoded number", "42"],
    ["an encoded null", "null"],
    ["an encoded string", JSON.stringify(JSON.stringify(CAPTURED_SHAPE_UNITS))],
  ])("leaves a units string holding %s unchanged and unrecovered", (_label, units) => {
    const input = { units };
    const prepared = prepareToolInput(input);
    expect(prepared.input).toBe(input);
    expect(prepared.unitsWasString).toBe(true);
    expect(prepared).not.toHaveProperty("recovered");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "{\"units\": []}"],
    ["an array", [VALID_RESPONSE]],
    ["an object without units", {}],
  ])("passes %s through untouched", (_label, input) => {
    const prepared = prepareToolInput(input);
    expect(prepared.input).toBe(input);
    expect(prepared.unitsWasString).toBe(false);
    expect(prepared).not.toHaveProperty("recovered");
  });
});

describe("extractFromResume — units returned as a JSON string (#650)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function extractWith(toolInputs: readonly unknown[]) {
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);
    const client = mockClient(toolInputs.map((input) => mockMessage(input)));
    let i = 0;
    const result = await extractFromResume(
      "Synthetic resume text",
      { ownerUid: "user-alice" },
      {
        client,
        record,
        generateId: () => `id-${++i}`,
        now: () => new Date("2026-10-29T00:00:00Z"),
      },
    ).catch((err: unknown) => err);
    return { result, record, client };
  }

  it("accepts a string-encoded valid array on the first attempt, records the recovery, and returns the same Units as the array form", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const asArray = await extractWith([{ units: CAPTURED_SHAPE_UNITS }]);
    expect(warn).not.toHaveBeenCalled();
    const asString = await extractWith([{ units: JSON.stringify(CAPTURED_SHAPE_UNITS) }]);

    expect(Array.isArray(asString.result)).toBe(true);
    expect(asString.result).toHaveLength(2);
    expect(asString.result).toEqual(asArray.result);
    // First attempt: one model call, no retry.
    expect(asString.client.messages.create).toHaveBeenCalledTimes(1);

    // The usage record carries the recovery; the array form's does not.
    expect(asString.record).toHaveBeenCalledTimes(1);
    expect(asString.record).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "extraction", attempt: 0, recovered: "units-string" }),
    );
    expect(asArray.record.mock.calls[0]![0]).not.toHaveProperty("recovered");

    // One warn line, fixed fields only: no résumé or Unit content.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, payload] = warn.mock.calls[0]! as [string, Record<string, unknown>];
    expect(message).toContain("units");
    expect(payload).toEqual({ model: "claude-sonnet-4-6", attempt: 0, recovered: "units-string" });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("Synthetic resume text");
    expect(logged).not.toContain("payments platform");

    // The request is the same whichever shape the model then returned.
    expect(vi.mocked(asString.client.messages.create).mock.calls[0]).toEqual(
      vi.mocked(asArray.client.messages.create).mock.calls[0],
    );
  });

  it.each([
    ["text that is not JSON", "Led migration at X."],
    ["an encoded object", JSON.stringify(VALID_RESPONSE)],
    ["an encoded number", "42"],
  ])("still fails a units string holding %s with the existing schema_error path and message", async (_label, units) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const input = { units };
    const expected = ExtractionResponseV1Schema.safeParse(input);
    expect(expected.success).toBe(false);

    const { result, record } = await extractWith([input, input, input]);

    expect(result).toBeInstanceOf(ExtractionError);
    const failures = (result as ExtractionError).failures;
    expect(failures).toHaveLength(3);
    for (const [attempt, f] of failures.entries()) {
      expect(f).toEqual({
        attempt,
        kind: "schema_error",
        message: expected.error!.message,
        zodIssues: expected.error!.issues,
      } satisfies ExtractionAttemptFailure);
    }
    expect(failures[0]!.zodIssues).toEqual([
      expect.objectContaining({ code: "invalid_type", expected: "array", path: ["units"] }),
    ]);
    // Nothing was recovered, so nothing says so.
    expect(record).toHaveBeenCalledTimes(3);
    for (const [usage] of record.mock.calls) expect(usage).not.toHaveProperty("recovered");
    expect(warn).not.toHaveBeenCalled();
  });

  it("validates a decoded array's contents and marks the schema_error as recovered", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const malformed = { units: JSON.stringify([{ wrong_shape: true }]) };

    const { result, record } = await extractWith([malformed, { units: CAPTURED_SHAPE_UNITS }]);

    expect(result).toHaveLength(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0]![0]).toMatchObject({ attempt: 0, recovered: "units-string" });
    expect(record.mock.calls[1]![0]).not.toHaveProperty("recovered");
  });

  it("carries the recovery on the failure log when a decoded array still fails every attempt", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const malformed = { units: JSON.stringify([{ wrong_shape: true }]) };

    const { result } = await extractWith([malformed, malformed, malformed]);

    expect(result).toBeInstanceOf(ExtractionError);
    const failures = (result as ExtractionError).failures;
    expect(failures.map((f) => [f.kind, f.recovered])).toEqual([
      ["schema_error", "units-string"],
      ["schema_error", "units-string"],
      ["schema_error", "units-string"],
    ]);
    // The issues are about the decoded Unit, not about `units` being a string.
    expect(failures[0]!.zodIssues).toContainEqual(expect.objectContaining({ path: ["units", 0] }));
  });

  it("names the shape in the retry reminder after a units string fails", async () => {
    const { result, client } = await extractWith([{ units: "Led migration at X." }, VALID_RESPONSE]);

    expect(result).toHaveLength(1);
    expect(systemOf(client, 0)).not.toContain(UNITS_STRING_REMINDER_TEXT);
    expect(systemOf(client, 1)).toContain(UNITS_STRING_REMINDER_TEXT);
    // Appended to the generic reminder, not in place of it.
    expect(systemOf(client, 1)).toContain("Your previous response failed schema validation.");
  });

  it("keeps naming the shape on the third attempt", async () => {
    const { result, client } = await extractWith([{ units: "not json" }, { units: [{ wrong_shape: true }] }, VALID_RESPONSE]);

    expect(result).toHaveLength(1);
    expect(systemOf(client, 2)).toContain(UNITS_STRING_REMINDER_TEXT);
    expect(systemOf(client, 2)).toContain("Your previous two attempts failed schema validation.");
  });

  it("names the shape in the retry reminder after a units string decoded but its contents failed", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { result, client, record } = await extractWith([
      { units: JSON.stringify([{ wrong_shape: true }]) },
      VALID_RESPONSE,
    ]);

    expect(result).toHaveLength(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ attempt: 0, recovered: "units-string" });
    expect(systemOf(client, 0)).not.toContain(UNITS_STRING_REMINDER_TEXT);
    expect(systemOf(client, 1)).toContain(UNITS_STRING_REMINDER_TEXT);
  });

  it("reads content that is not an array as no tool_use, retries it, and records usage on every attempt", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const noArray = { ...mockMessage(VALID_RESPONSE), content: undefined } as unknown as Anthropic.Messages.Message;
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);
    const client = mockClient([noArray, noArray, noArray]);

    const err = await extractFromResume("Synthetic resume text", { ownerUid: "user-alice" }, { client, record }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).failures.map((f) => [f.attempt, f.kind])).toEqual([
      [0, "no_tool_use"],
      [1, "no_tool_use"],
      [2, "no_tool_use"],
    ]);
    expect(record).toHaveBeenCalledTimes(3);
    expect(record.mock.calls.map(([usage]) => usage.attempt)).toEqual([0, 1, 2]);
  });

  it("skips a null content element instead of throwing before usage is recorded", async () => {
    const toolUse = mockMessage(VALID_RESPONSE).content[0]!;
    const onlyNull = { ...mockMessage(VALID_RESPONSE), content: [null] } as unknown as Anthropic.Messages.Message;
    const nullThenTool = { ...mockMessage(VALID_RESPONSE), content: [null, toolUse] } as unknown as Anthropic.Messages.Message;
    const record = vi.fn<typeof RecordUsage>(async () => 0.01);
    const client = mockClient([onlyNull, nullThenTool]);

    const units = await extractFromResume("Synthetic resume text", { ownerUid: "user-alice" }, {
      client,
      record,
      generateId: () => "id-1",
      now: () => new Date("2026-10-29T00:00:00Z"),
    });

    // `[null]` is no tool_use and retries; `[null, tool_use]` finds the call.
    expect(units).toHaveLength(1);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("does not add the units reminder after an unrelated schema failure", async () => {
    const { result, client } = await extractWith([{ units: [{ wrong_shape: true }] }, VALID_RESPONSE]);

    expect(result).toHaveLength(1);
    expect(systemOf(client, 1)).toContain("Your previous response failed schema validation.");
    expect(systemOf(client, 1)).not.toContain(UNITS_STRING_REMINDER_TEXT);
  });
});

describe("extractFromResume — Claude 5.5 request shape (#495)", () => {
  afterEach(() => {
    clearModelOverrides();
    clearEffortOverrides();
  });

  function thinkingThenTool(response: Anthropic.Messages.Message): Anthropic.Messages.Message {
    return {
      ...response,
      model: "claude-sonnet-5-5",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        ...response.content,
      ],
    } as Anthropic.Messages.Message;
  }

  it("asks Sonnet 5.5 for the tool without forcing it, with effort, a doubled budget and a timeout", async () => {
    setModelOverrides({ extraction: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    const client = mockClient([thinkingThenTool(mockMessage(VALID_RESPONSE))]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    await extractFromResume("text", { ownerUid: "user-alice" }, { client, record });

    const create = vi.mocked(client.messages.create);
    const [body, options] = create.mock.calls[0]! as unknown as [
      Anthropic.Messages.MessageCreateParamsNonStreaming,
      { timeout: number } | undefined,
    ];
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(32_768);
    expect(String(body.system)).toContain("`record_experience_units`");
    expect(options?.timeout).toBeGreaterThan(10 * 60 * 1000);
    // A thinking block ahead of the tool call is skipped, not treated as the answer.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-5-5", effort: "high", maxTokens: 32_768 }),
    );
  });

  it("sends an effort override and records it", async () => {
    setModelOverrides({ extraction: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    setEffortOverrides({ extraction: "low" });
    const client = mockClient([thinkingThenTool(mockMessage(VALID_RESPONSE))]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    await extractFromResume("text", { ownerUid: "user-alice" }, { client, record });

    const body = vi.mocked(client.messages.create).mock.calls[0]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
    expect(body.output_config).toEqual({ effort: "low" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ effort: "low" }));
  });

  it("stops on a refusal instead of spending the retry budget", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const refusal = {
      ...mockMessage(VALID_RESPONSE),
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    } as unknown as Anthropic.Messages.Message;
    const client = mockClient([refusal, mockMessage(VALID_RESPONSE)]);

    const err = await extractFromResume("text", { ownerUid: "user-alice" }, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as Error).message).toMatch(/declined by the model/);
    expect((err as Error).message).not.toMatch(/after 3 attempts/);
    // Logged as a refusal, not as an exhausted retry budget.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("model declined the request"),
      expect.objectContaining({ detail: expect.stringContaining("cyber") }),
    );
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    expect(vi.mocked(client.messages.create)).toHaveBeenCalledTimes(1);
    expect((ExtractionFailures(err))).toEqual([
      expect.objectContaining({ attempt: 0, kind: "refusal", message: expect.stringContaining("cyber") }),
    ]);
  });
});

function ExtractionFailures(err: unknown): readonly { kind: string }[] {
  return (err as { failures: readonly { kind: string }[] }).failures;
}
