import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";

import { extractClaims } from "./claimExtraction.ts";
import { ClaimExtractionError } from "./errors.ts";

/**
 * Tests for the validation pipeline's claim-extraction stage
 * (sub-issue #106 of #23). Mocked Anthropic client; no I/O.
 *
 * Coverage:
 *   - Happy path: valid LLM response → stamped Claim[] returned
 *   - Schema-error retry: malformed once → succeeds on retry
 *   - Schema-error retry exhaustion: 3× malformed → ClaimExtractionError
 *   - Transport-error retry: throw once → succeeds on retry
 *   - no_tool_use response: text-only response → counted as failure
 *   - Empty bullet input → throws synchronously without LLM call
 *   - Server-stamped fields: id from generateId, bullet_id from ctx
 *   - raw_span optional: present when LLM emits it, absent otherwise
 *   - Cost tracker fires on every successful response (including
 *     retries that succeeded), per the "never silently undercount"
 *     contract from the parsing/jd.ts pattern
 *   - Section title threading: ctx.sectionTitle reaches the prompt
 */

function mockMessage(
  toolInput: unknown,
  usage = { input_tokens: 100, output_tokens: 50 },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    // Loosely mirrors `modelFor("validation")`. Pin via the
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

function mockTextOnlyMessage(
  text: string,
  usage = { input_tokens: 100, output_tokens: 10 },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    // Loosely mirrors `modelFor("validation")`. Pin via the
    // production-config import would couple unit tests to the
    // config module; instead we keep this string aligned by
    // inspection (CodeRabbit Trivial on PR #110).
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

describe("extractClaims", () => {
  it("stamps server-side fields and returns Claims on first-attempt success", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const ids = ["c1", "c2", "c3"];
    const { client } = mockClient([mockMessage(VALID_RESPONSE)]);

    const claims = await extractClaims(
      {
        text: "Led 64-bit NCP migration on Disney+ playback stack (reduced memory 30%).",
        source_unit_ids: ["unit-1"],
      },
      CTX,
      {
        client,
        record,
        generateId: () => ids.shift() ?? "fallback",
      },
    );

    expect(claims).toHaveLength(3);
    expect(claims[0]!.id).toBe("c1");
    expect(claims[0]!.bullet_id).toBe("bullet-1");
    expect(claims[0]!.text).toContain("64-bit NCP migration");
    expect(claims[0]!.raw_span).toBe("Led 64-bit NCP migration");
  });

  it("logs cost via recordUsage with stage='validation' and the right model+tokens", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client } = mockClient([mockMessage(VALID_RESPONSE)]);

    await extractClaims(
      { text: "Led migration.", source_unit_ids: [] },
      CTX,
      { client, record, generateId: () => "c1" },
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "validation",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 50,
        ownerUid: "user-alice",
      }),
    );
  });

  it("recordUsage rejection is swallowed; the LLM verdict still ships (CodeRabbit on #113)", async () => {
    // Pin: cost telemetry is observability infrastructure. A
    // Firestore 503 (or any other recordUsage failure) must NOT
    // discard an otherwise-successful claim extraction. The
    // try/catch around `await record(...)` enforces this.
    const record = vi.fn<typeof RecordUsage>(async () => {
      throw new Error("Firestore unavailable");
    });
    const { client } = mockClient([mockMessage(VALID_RESPONSE)]);

    const claims = await extractClaims(
      { text: "Led migration.", source_unit_ids: [] },
      CTX,
      { client, record, generateId: () => "c1" },
    );

    expect(claims).toHaveLength(3);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("retries once on schema failure and succeeds on the second attempt", async () => {
    // Malformed first attempt: wrong shape (claims is an object, not array).
    const malformed = { claims: { wrong_shape: true } };
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client, create } = mockClient([
      mockMessage(malformed),
      mockMessage(VALID_RESPONSE),
    ]);

    const claims = await extractClaims(
      { text: "x", source_unit_ids: [] },
      CTX,
      { client, record, generateId: () => "c1" },
    );

    expect(claims).toHaveLength(3);
    expect(create).toHaveBeenCalledTimes(2);
    // Cost recorded for BOTH responses — the retry contract.
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("throws ClaimExtractionError after 3 schema-failure attempts", async () => {
    const malformed = { claims: { wrong: true } };
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client } = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(malformed),
    ]);

    await expect(
      extractClaims({ text: "x", source_unit_ids: [] }, CTX, {
        client,
        record,
        generateId: () => "c1",
      }),
    ).rejects.toBeInstanceOf(ClaimExtractionError);

    // All 3 attempts are still cost-tracked.
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("retries on transport errors and succeeds when the next attempt returns valid", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client } = mockClient([
      new Error("ECONNRESET"),
      mockMessage(VALID_RESPONSE),
    ]);

    const claims = await extractClaims(
      { text: "x", source_unit_ids: [] },
      CTX,
      { client, record, generateId: () => "c1" },
    );

    expect(claims).toHaveLength(3);
    // Transport errors don't have token counts → no cost recorded
    // for the failing attempt; the successful attempt records once.
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("counts text-only responses (no tool_use) as failures and retries", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.005);
    const { client } = mockClient([
      mockTextOnlyMessage("I would emit claims here but cannot use tools."),
      mockMessage(VALID_RESPONSE),
    ]);

    const claims = await extractClaims(
      { text: "x", source_unit_ids: [] },
      CTX,
      { client, record, generateId: () => "c1" },
    );

    expect(claims).toHaveLength(3);
    // Both responses are cost-tracked (the no-tool-use response
    // still produced tokens; we record what the API returned).
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("throws synchronously on empty bullet text without calling the client", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);

    await expect(
      extractClaims({ text: "   ", source_unit_ids: [] }, CTX, {
        client,
        record,
        generateId: () => "c1",
      }),
    ).rejects.toBeInstanceOf(ClaimExtractionError);

    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("emits a Claim without raw_span when the LLM omits it", async () => {
    const noSpan = {
      claims: [
        { text: "The user collaborated cross-functionally." },
        { text: "The user drove results through this collaboration." },
      ],
    };
    const { client } = mockClient([mockMessage(noSpan)]);
    const ids = ["c1", "c2"];

    const claims = await extractClaims(
      { text: "Collaborated cross-functionally to drive results.", source_unit_ids: [] },
      CTX,
      {
        client,
        record: vi.fn<typeof RecordUsage>(async () => 0.001),
        generateId: () => ids.shift() ?? "fallback",
      },
    );

    expect(claims).toHaveLength(2);
    expect(claims[0]!.raw_span).toBeUndefined();
    // Pin: when raw_span is absent on the LLM side, the field
    // is OMITTED from the stamped Claim (Firestore rejects
    // undefined values on writes — same conditional-spread
    // pattern as parsing/jd.ts).
    expect(Object.prototype.hasOwnProperty.call(claims[0]!, "raw_span")).toBe(
      false,
    );
  });

  it("threads sectionTitle into the user content (prompt context)", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client, create } = mockClient([mockMessage(VALID_RESPONSE)]);

    await extractClaims(
      { text: "Led migration.", source_unit_ids: [] },
      { ...CTX, sectionTitle: "experience" },
      { client, record, generateId: () => "c1" },
    );

    const callArgs = create.mock.calls[0]![0] as {
      messages: { content: string }[];
    };
    expect(callArgs.messages[0]!.content).toContain("Section: experience");
    expect(callArgs.messages[0]!.content).toContain("Led migration.");
  });

  it("default generateId produces STABLE ids when the LLM emits claims in the same order (CR Major round 1 on #110)", async () => {
    // Pin: the default id generator is content+index-based
    // (SHA-256 of bulletId::index::claimText). Two extractions
    // of the same bullet that yield the same claim texts in the
    // same order produce identical claim ids — the cross-run
    // stability we want for re-validation.
    //
    // The index dependency means a re-ordered LLM emission
    // produces different ids; this is a deliberate trade-off
    // (Codex P1 round 2 on #110) — within-bullet uniqueness is
    // load-bearing, cross-run stability under re-ordering is
    // nice-to-have. The orchestrator (#109) handles re-validation
    // by replacing the flag set wholesale, mirroring the
    // replace-by-(role,owner) pattern from #99.
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client: client1 } = mockClient([mockMessage(VALID_RESPONSE)]);
    const { client: client2 } = mockClient([mockMessage(VALID_RESPONSE)]);

    // Two extraction calls — NO generateId override → uses the
    // production default (content-hash). Same bullet, same ctx
    // → same ids expected.
    const claims1 = await extractClaims(
      { text: "x", source_unit_ids: [] },
      CTX,
      { client: client1, record },
    );
    const claims2 = await extractClaims(
      { text: "x", source_unit_ids: [] },
      CTX,
      { client: client2, record },
    );

    expect(claims1.map((c) => c.id)).toEqual(claims2.map((c) => c.id));
    // And: each claim's id is unique within the bullet (no
    // collisions across the 3 distinct claim texts).
    expect(new Set(claims1.map((c) => c.id)).size).toBe(3);
    // Sanity: ids are 24-char hex (the hash prefix).
    for (const c of claims1) {
      expect(c.id).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it("default generateId yields UNIQUE ids when the LLM emits duplicate claim text within one bullet (Codex P1 round 2 on #110)", async () => {
    // Within-bullet uniqueness is load-bearing for the
    // flag-record key contract (downstream traceability +
    // specificity records key on (asset_id, bullet_id, claim_id)).
    // Codex round 2 reproduced a regression where the prior
    // `(bulletId, claimText)`-only hash collapsed duplicate-text
    // claims into one id — the second claim's flag would clobber
    // the first's. This test pins the fix: the index in the
    // hash guarantees within-bullet uniqueness even on identical
    // claim text.
    const dupResponse = {
      claims: [
        { text: "The user collaborated cross-functionally.", raw_span: "Collaborated" },
        { text: "The user collaborated cross-functionally.", raw_span: "cross-functionally" },
      ],
    };
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const { client } = mockClient([mockMessage(dupResponse)]);

    // No generateId override → uses the production default.
    const claims = await extractClaims(
      { text: "Collaborated cross-functionally.", source_unit_ids: [] },
      CTX,
      { client, record },
    );

    expect(claims).toHaveLength(2);
    // Both claims have the same text, but they MUST have
    // different ids — that's the uniqueness contract.
    expect(claims[0]!.text).toBe(claims[1]!.text);
    expect(claims[0]!.id).not.toBe(claims[1]!.id);
    expect(new Set(claims.map((c) => c.id)).size).toBe(2);
  });

  it("default generateId differs across bullets even with identical claim text (bulletId is the discriminator)", async () => {
    // Pin: two different bullets that happen to yield identical
    // claim texts produce DIFFERENT claim ids (because the hash
    // includes bulletId). Without this property, claims that
    // happen to share text across bullets would clobber each
    // other in the flag-record store.
    const record = vi.fn<typeof RecordUsage>(async () => 0.001);
    const oneClaim = {
      claims: [{ text: "The user did a thing." }],
    };
    const { client: c1 } = mockClient([mockMessage(oneClaim)]);
    const { client: c2 } = mockClient([mockMessage(oneClaim)]);

    const fromBulletA = await extractClaims(
      { text: "x", source_unit_ids: [] },
      { ...CTX, bulletId: "bullet-A" },
      { client: c1, record },
    );
    const fromBulletB = await extractClaims(
      { text: "x", source_unit_ids: [] },
      { ...CTX, bulletId: "bullet-B" },
      { client: c2, record },
    );

    expect(fromBulletA[0]!.id).not.toBe(fromBulletB[0]!.id);
  });

  it("server-stamps a fresh id per claim using the injected generateId", async () => {
    // Pin: each claim gets a UNIQUE id from generateId(), called
    // once per claim. A regression that reused one id across
    // claims would break downstream traceability flag records.
    const generated: string[] = [];
    let counter = 0;
    const generateId = () => {
      counter += 1;
      const id = `c${counter}`;
      generated.push(id);
      return id;
    };
    const { client } = mockClient([mockMessage(VALID_RESPONSE)]);

    const claims = await extractClaims(
      { text: "x", source_unit_ids: [] },
      CTX,
      {
        client,
        record: vi.fn<typeof RecordUsage>(async () => 0),
        generateId,
      },
    );

    expect(claims.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(new Set(generated).size).toBe(3);
  });

  it("backs off (non-zero setTimeout delay) before retrying after a transport error", async () => {
    // Pin: claim extraction fans out per-bullet via the
    // orchestrator (#109) — without backoff a single 429 cascades
    // fast. Helper at functions/src/llm/retry.ts.
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const record = vi.fn<typeof RecordUsage>(async () => 0.005);
      const { client } = mockClient([
        new Error("ECONNRESET"),
        mockMessage(VALID_RESPONSE),
      ]);

      const promise = extractClaims(
        { text: "x", source_unit_ids: [] },
        CTX,
        { client, record, generateId: () => "c1" },
      );

      await vi.runAllTimersAsync();
      const claims = await promise;

      expect(claims.length).toBeGreaterThan(0);
      const nonZeroDelays = setTimeoutSpy.mock.calls
        .map((call) => Number(call[1]))
        .filter((d) => Number.isFinite(d) && d > 0);
      expect(nonZeroDelays.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
