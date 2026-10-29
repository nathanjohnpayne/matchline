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
import { zodToToolSchema } from "../llm/zodToolSchema.ts";
import { clearPromptVersionOverrides, loadPromptText, setPromptVersionOverrides } from "../prompts/loader.ts";
import { JdParsingResponseV1Schema } from "../prompts/parsing/jd.v1.schema.ts";

import { JdParsingError } from "./errors.ts";
import { attemptFailureNotice, parseJobRequirements, type JdAttemptFailureNotice } from "./jd.ts";

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
      const reqs = await parseJobRequirements("JD text", CTX, {
        client,
        record,
        generateId: () => "id-stub",
      });

      expect(reqs).toHaveLength(2);
      expect(record).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      const warnPayload = warn.mock.calls[0]![1] as Record<string, unknown>;
      expect(warnPayload).not.toHaveProperty("ownerUid");
      expect(warnPayload).toMatchObject({
        stage: "requirement_parsing",
        error: "Firestore unavailable",
      });
    } finally {
      warn.mockRestore();
    }
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

  it("surfaces stop_reason: max_tokens as a max_tokens_exceeded failure (mirror of extraction)", async () => {
    // Long JDs blow the same wall as long resumes — Google's SPM
    // listing carries ~25 Requirements once each is fully labeled.
    // See extraction/resume.test.ts for the parallel test + the
    // full rationale.
    const truncated = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [
        {
          type: "tool_use",
          id: "toolu_test",
          name: "record_job_requirements",
          input: {},
        },
      ],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 2500, output_tokens: 4096 },
    } as unknown as Anthropic.Messages.Message;
    const client = mockClient([truncated, truncated, truncated]);
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);

    await expect(
      parseJobRequirements("JD", CTX, { client, record, generateId: () => "x" }),
    ).rejects.toMatchObject({
      name: "JdParsingError",
      failures: [
        { attempt: 0, kind: "max_tokens_exceeded" },
        { attempt: 1, kind: "max_tokens_exceeded" },
        { attempt: 2, kind: "max_tokens_exceeded" },
      ],
    });
    expect(record).toHaveBeenCalledTimes(3);
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

  it("keys the retry reminder by the previous attempt's actual failure kind, not attempt index (#334)", async () => {
    // Attempt 0 fails with no_tool_use — attempt 1 must get the
    // no-tool-use reminder, NOT the schema-validation reminder that
    // a pure attempt-index lookup would have produced.
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

    await parseJobRequirements("JD text", CTX, {
      client,
      record,
      generateId: () => "id-stub",
    });

    const create = client.messages.create as unknown as ReturnType<typeof vi.fn>;
    expect(create).toHaveBeenCalledTimes(2);
    const secondCallArgs = create.mock.calls[1]![0] as { system: string };
    expect(secondCallArgs.system).toContain("did not call the tool");
    expect(secondCallArgs.system).not.toContain("failed schema validation");
  });

  it("gives no reminder text after a transport_error, since a retry can't correct it via prompt (#334)", async () => {
    vi.useFakeTimers();
    try {
      const record = vi.fn<typeof RecordUsage>(async () => 0.005);
      let callCount = 0;
      const client = {
        messages: {
          create: vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) throw new Error("ETIMEDOUT");
            return mockMessage(VALID_RESPONSE);
          }),
        },
      } as unknown as Anthropic;

      const resultPromise = parseJobRequirements("JD text", CTX, {
        client,
        record,
        generateId: () => "id-stub",
      });
      await vi.runAllTimersAsync();
      const reqs = await resultPromise;

      expect(reqs).toHaveLength(2);
      const create = client.messages.create as unknown as ReturnType<typeof vi.fn>;
      const secondCallArgs = create.mock.calls[1]![0] as { system: string };
      // No reminder appended: the second call's system prompt should
      // be exactly the base prompt (no added reminder suffix).
      expect(secondCallArgs.system).not.toContain("failed schema validation");
      expect(secondCallArgs.system).not.toContain("did not call the tool");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records transport_error without calling record (no token counts available)", async () => {
    // Fake timers (per #115): without them the retry-helper's
    // backoff sleeps cost ~1.8s of CI per run. Mirror the
    // backoff-test pattern (vi.useFakeTimers + runAllTimersAsync)
    // so the test settles in <50ms while still exercising the
    // full 3-attempt retry path.
    vi.useFakeTimers();
    try {
      const client = {
        messages: {
          create: vi.fn(async () => {
            throw new Error("ETIMEDOUT");
          }),
        },
      } as unknown as Anthropic;
      const record = vi.fn<typeof RecordUsage>(async () => 0.005);

      const promise = parseJobRequirements("JD text", CTX, { client, record });
      // Attach the rejection assertion BEFORE draining timers so
      // vitest doesn't flag the brief unhandled-rejection window
      // between the function settling and the explicit `await`.
      const rejection = expect(promise).rejects.toBeInstanceOf(JdParsingError);
      await vi.runAllTimersAsync();
      await rejection;
      expect(record).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
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

  it("backs off (non-zero setTimeout delay) before retrying after a transport error", async () => {
    // Pin: backoff is wired between transport-error retries. See
    // functions/src/llm/retry.ts — shared schedule across the four
    // LLM call sites, with longer waits on 429/503.
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const record = vi.fn<typeof RecordUsage>(async () => 0.005);
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

      const promise = parseJobRequirements("JD text", CTX, {
        client,
        record,
        generateId: () => "id-stub",
      });

      await vi.runAllTimersAsync();
      const reqs = await promise;

      expect(reqs.length).toBeGreaterThan(0);
      const nonZeroDelays = setTimeoutSpy.mock.calls
        .map((call) => Number(call[1]))
        .filter((d) => Number.isFinite(d) && d > 0);
      expect(nonZeroDelays.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseJobRequirements — Claude 5.5 request shape (#495)", () => {
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
    setModelOverrides({ requirement_parsing: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    const client = mockClient([thinkingThenTool(mockMessage(VALID_RESPONSE))]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    await parseJobRequirements("text", CTX, { client, record });

    const create = vi.mocked(client.messages.create);
    const [body, options] = create.mock.calls[0]! as unknown as [
      Anthropic.Messages.MessageCreateParamsNonStreaming,
      { timeout: number } | undefined,
    ];
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(32_768);
    expect(String(body.system)).toContain("`record_job_requirements`");
    expect(options?.timeout).toBeGreaterThan(10 * 60 * 1000);
    // A thinking block ahead of the tool call is skipped, not treated as the answer.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-5-5", effort: "high", maxTokens: 32_768 }),
    );
  });

  it("sends an effort override and records it", async () => {
    setModelOverrides({ requirement_parsing: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    setEffortOverrides({ requirement_parsing: "low" });
    const client = mockClient([thinkingThenTool(mockMessage(VALID_RESPONSE))]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    await parseJobRequirements("text", CTX, { client, record });

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

    const err = await parseJobRequirements("text", CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JdParsingError);
    expect((err as Error).message).toMatch(/declined by the model/);
    expect((err as Error).message).not.toMatch(/after 3 attempts/);
    // Logged as a refusal, not as an exhausted retry budget.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("model declined the request"),
      expect.objectContaining({ detail: expect.stringContaining("cyber") }),
    );
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    expect(vi.mocked(client.messages.create)).toHaveBeenCalledTimes(1);
    expect((JdParsingFailures(err))).toEqual([
      expect.objectContaining({ attempt: 0, kind: "refusal", message: expect.stringContaining("cyber") }),
    ]);
  });
});

describe("parseJobRequirements — prompt version selection (#656)", () => {
  afterEach(() => clearPromptVersionOverrides());

  type Body = Anthropic.Messages.MessageCreateParamsNonStreaming;
  const bodies = (client: Anthropic): Body[] =>
    vi.mocked(client.messages.create).mock.calls.map((c) => c[0] as unknown as Body);

  function systemsOf(): { v1: string; v2: string } {
    setPromptVersionOverrides({ "parsing/jd": "v1" });
    const v1 = loadPromptText("parsing", "jd").system;
    setPromptVersionOverrides({ "parsing/jd": "v2" });
    const v2 = loadPromptText("parsing", "jd").system;
    clearPromptVersionOverrides();
    return { v1, v2 };
  }

  it("sends v1 with no override: production is unchanged", async () => {
    const { v1, v2 } = systemsOf();
    const client = mockClient([mockMessage(VALID_RESPONSE)]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    await parseJobRequirements("JD text", CTX, { client, record });

    const [body] = bodies(client);
    expect(String(body!.system).startsWith(v1)).toBe(true);
    expect(String(body!.system).startsWith(v2)).toBe(false);
    expect(body!.tools![0]).toMatchObject({ input_schema: zodToToolSchema(JdParsingResponseV1Schema) });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: "parsing/jd.v1" }));
  });

  it("sends the v2 System under a parsing/jd=v2 override, with the same tool schema and few-shot", async () => {
    const { v2 } = systemsOf();
    const v1Client = mockClient([mockMessage(VALID_RESPONSE)]);
    await parseJobRequirements("JD text", CTX, { client: v1Client, record: vi.fn<typeof RecordUsage>(async () => 0) });

    setPromptVersionOverrides({ "parsing/jd": "v2" });
    const client = mockClient([mockMessage(VALID_RESPONSE)]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const reqs = await parseJobRequirements("JD text", CTX, { client, record, generateId: () => "id" });

    expect(reqs).toHaveLength(2);
    const [body] = bodies(client);
    const [v1Body] = bodies(v1Client);
    expect(String(body!.system).startsWith(v2)).toBe(true);
    expect(body!.tools).toEqual(v1Body!.tools);
    expect(body!.messages).toEqual(v1Body!.messages);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: "parsing/jd.v2" }));
  });

  it("validates under v2 and retries a schema failure with the same reminder as v1", async () => {
    setPromptVersionOverrides({ "parsing/jd": "v2" });
    const outOfEnum = {
      requirements: [{ ...VALID_RESPONSE.requirements[0], category: "education" }],
    };
    const client = mockClient([mockMessage(outOfEnum), mockMessage(VALID_RESPONSE)]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    const reqs = await parseJobRequirements("JD text", CTX, { client, record, generateId: () => "id" });

    expect(reqs).toHaveLength(2);
    const [first, second] = bodies(client);
    expect(String(first!.system)).not.toContain("failed schema validation");
    expect(String(second!.system)).toContain("Your previous response failed schema validation.");
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ promptVersion: "parsing/jd.v2", attempt: 1 }));
  });

  it("refuses an override to a version with no prompt file before any request is sent", async () => {
    setPromptVersionOverrides({ "parsing/jd": "v9" });
    const client = mockClient([mockMessage(VALID_RESPONSE)]);

    await expect(
      parseJobRequirements("JD text", CTX, { client, record: vi.fn<typeof RecordUsage>(async () => 0) }),
    ).rejects.toThrow(/Prompt file not found/);
    expect(vi.mocked(client.messages.create)).not.toHaveBeenCalled();
  });

  it("refuses a version whose prompt file loads but has no registered schema, before any request", async () => {
    // A prompt jd.v3.md that exists on disk but was never added to
    // jdResponseSchema.ts. The loader is swapped for this test only.
    vi.resetModules();
    vi.doMock("../prompts/loader.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../prompts/loader.ts")>()),
      loadPromptText: () => ({ version: "v3", system: "System v3.", userFewShot: "Few-shot v3." }),
    }));
    try {
      const { parseJobRequirements: parseWithV3 } = await import("./jd.ts");
      const client = mockClient([mockMessage(VALID_RESPONSE)]);
      const record = vi.fn<typeof RecordUsage>(async () => 0);

      await expect(parseWithV3("JD text", CTX, { client, record })).rejects.toThrow(
        /No JD parsing schema registered for version "v3"/,
      );
      expect(vi.mocked(client.messages.create)).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../prompts/loader.ts");
      vi.resetModules();
    }
  });
});

describe("parseJobRequirements onAttemptFailure (#656)", () => {
  afterEach(() => {
    clearPromptVersionOverrides();
  });

  const missingKey = {
    requirements: [{ ...VALID_RESPONSE.requirements[0], category: "education", must_have: "yes" }],
  };

  it("reports a recovered schema failure's attempt, kind and issue codes and paths", async () => {
    const notices: JdAttemptFailureNotice[] = [];
    const client = mockClient([mockMessage(missingKey), mockMessage(VALID_RESPONSE)]);

    const reqs = await parseJobRequirements("JD text", CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      generateId: () => "id",
      onAttemptFailure: (n) => notices.push(n),
    });

    expect(reqs).toHaveLength(2);
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    expect(notice).toMatchObject({ attempt: 0, kind: "schema_error" });
    const issues = [...(notice!.issues ?? [])].sort((x, y) => x.path.join(".").localeCompare(y.path.join(".")));
    expect(issues).toEqual([
      { code: "invalid_value", path: ["requirements", 0, "category"] },
      { code: "invalid_type", path: ["requirements", 0, "must_have"] },
    ]);
    // Codes and paths only: no message, expected value or model output.
    for (const issue of issues) expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    expect(JSON.stringify(notices)).not.toContain("education");
  });

  it("reports every failed attempt of an exhausted run, in order, with the same kinds as .failures", async () => {
    const notices: JdAttemptFailureNotice[] = [];
    const noTool = { ...mockMessage(VALID_RESPONSE), content: [{ type: "text", text: "no", citations: null }] } as Anthropic.Messages.Message;
    const client = mockClient([mockMessage(missingKey), noTool, mockMessage(missingKey)]);

    const err = await parseJobRequirements("JD text", CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      onAttemptFailure: (n) => notices.push(n),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JdParsingError);
    expect(notices.map((n) => [n.attempt, n.kind])).toEqual([
      [0, "schema_error"],
      [1, "no_tool_use"],
      [2, "schema_error"],
    ]);
    expect(notices.map((n) => n.kind)).toEqual(JdParsingFailures(err).map((f) => f.kind));
    expect(notices[1]!.issues).toBeUndefined();
  });

  it("sends the same requests and returns the same result with or without the hook", async () => {
    const withoutHook = mockClient([mockMessage(missingKey), mockMessage(VALID_RESPONSE)]);
    const withHook = mockClient([mockMessage(missingKey), mockMessage(VALID_RESPONSE)]);
    const a = await parseJobRequirements("JD text", CTX, {
      client: withoutHook,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      generateId: () => "id",
    });
    const b = await parseJobRequirements("JD text", CTX, {
      client: withHook,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      generateId: () => "id",
      onAttemptFailure: () => undefined,
    });

    expect(b).toEqual(a);
    expect(vi.mocked(withHook.messages.create).mock.calls).toEqual(vi.mocked(withoutHook.messages.create).mock.calls);
  });

  it("ignores a hook that throws, so the parse outcome is unchanged", async () => {
    const client = mockClient([mockMessage(missingKey), mockMessage(VALID_RESPONSE)]);

    const reqs = await parseJobRequirements("JD text", CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      generateId: () => "id",
      onAttemptFailure: () => {
        throw new Error("sink broke");
      },
    });

    expect(reqs).toHaveLength(2);
    expect(vi.mocked(client.messages.create)).toHaveBeenCalledTimes(2);
  });
});

describe("attemptFailureNotice", () => {
  it("keeps attempt, kind and each issue's code and path, and nothing else", () => {
    expect(
      attemptFailureNotice({
        attempt: 1,
        kind: "schema_error",
        message: "model output here",
        zodIssues: [
          { code: "invalid_value", path: ["requirements", 3, "category"], message: "bad", values: ["tool"], input: "education" },
        ],
      }),
    ).toEqual({ attempt: 1, kind: "schema_error", issues: [{ code: "invalid_value", path: ["requirements", 3, "category"] }] });
  });

  it("omits issues for a failure without Zod issues, or with an empty list", () => {
    expect(attemptFailureNotice({ attempt: 0, kind: "transport_error", message: "x" })).toEqual({ attempt: 0, kind: "transport_error" });
    expect(attemptFailureNotice({ attempt: 2, kind: "schema_error", message: "x", zodIssues: [] })).toEqual({ attempt: 2, kind: "schema_error" });
  });

  it("skips malformed issues and stringifies a symbol path segment", () => {
    const sym = Symbol("k");
    expect(
      attemptFailureNotice({
        attempt: 0,
        kind: "schema_error",
        message: "x",
        zodIssues: [null, "str", { path: ["a"] }, { code: 7, path: [] }, { code: "custom" }, { code: "custom", path: ["a", sym, 0] }],
      }).issues,
    ).toEqual([
      { code: "custom", path: [] },
      { code: "custom", path: ["a", "Symbol(k)", 0] },
    ]);
  });
});

function JdParsingFailures(err: unknown): readonly { kind: string }[] {
  return (err as { failures: readonly { kind: string }[] }).failures;
}
