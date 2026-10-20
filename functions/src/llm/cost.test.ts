import { logger } from "firebase-functions";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAdminDb } from "../firestore/admin.js";
import {
  anthropicUsageFields,
  priceFor,
  priceUsage,
  pricedModelFor,
  promptVersionLabel,
  recordUsage,
  safeRecordUsage,
  USAGE_SCHEMA_VERSION,
  type UsageRecord,
} from "./cost.js";

// `recordUsage` writes to Firestore fire-and-forget through the
// `getAdminDb()` choke point (firestore/admin.ts). Mock that module so
// the persistence path is observable without a live Firestore, and so
// a synchronous throw from init can be simulated.
vi.mock("../firestore/admin.js", () => ({
  getAdminDb: vi.fn(),
}));

/** Build a mock Firestore db whose `add` resolves, capturing the doc. */
function mockDb() {
  const add = vi.fn(async () => ({ id: "doc-1" }));
  const collection = vi.fn(() => ({ add }));
  return { db: { collection }, add, collection };
}

const SAMPLE_USAGE: UsageRecord = {
  stage: "extraction",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  inputTokens: 100,
  outputTokens: 200,
  latencyMs: 50,
};

describe("priceFor", () => {
  it("computes Sonnet cost from published rates", () => {
    // 1000 input @ $0.003/1k + 1000 output @ $0.015/1k = $0.003 + $0.015 = $0.018
    const cost = priceFor("claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.018, 6);
  });

  it("computes Haiku cost from published rates", () => {
    // 10000 input @ $0.001/1k + 2000 output @ $0.005/1k = $0.01 + $0.01 = $0.02
    const cost = priceFor("claude-haiku-4-5-20251001", {
      inputTokens: 10000,
      outputTokens: 2000,
    });
    expect(cost).toBeCloseTo(0.02, 6);
  });

  it("treats embeddings as input-only (output rate is zero)", () => {
    // 10000 input @ $0.00002/1k = $0.0002; output multiplier ignored
    const cost = priceFor("text-embedding-3-small", {
      inputTokens: 10000,
      outputTokens: 9999999, // nonsense on purpose — should not affect cost
    });
    expect(cost).toBeCloseTo(0.0002, 9);
  });

  it("returns 0 for zero-token calls", () => {
    expect(priceFor("claude-sonnet-4-6", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("scales linearly with token count", () => {
    const small = priceFor("claude-sonnet-4-6", { inputTokens: 500, outputTokens: 500 });
    const large = priceFor("claude-sonnet-4-6", { inputTokens: 50000, outputTokens: 50000 });
    expect(large).toBeCloseTo(small * 100, 6);
  });

  it("throws on unregistered model rather than silently costing $0", () => {
    expect(() =>
      priceFor("claude-unknown", { inputTokens: 1000, outputTokens: 1000 }),
    ).toThrow(/No rate registered/);
  });

  it("rejects negative token counts", () => {
    expect(() =>
      priceFor("claude-sonnet-4-6", { inputTokens: -1, outputTokens: 0 }),
    ).toThrow(/Token counts must be finite, non-negative/);
    expect(() =>
      priceFor("claude-sonnet-4-6", { inputTokens: 0, outputTokens: -1 }),
    ).toThrow(/Token counts must be finite, non-negative/);
  });

  it("rejects NaN token counts", () => {
    expect(() =>
      priceFor("claude-sonnet-4-6", { inputTokens: Number.NaN, outputTokens: 0 }),
    ).toThrow(/Token counts must be finite, non-negative/);
  });

  it("rejects Infinity token counts", () => {
    expect(() =>
      priceFor("claude-sonnet-4-6", {
        inputTokens: Number.POSITIVE_INFINITY,
        outputTokens: 0,
      }),
    ).toThrow(/Token counts must be finite, non-negative/);
  });
});

// CodeRabbit Nitpick on PR #118: centralize the telemetry guard
// shape every LLM pipeline previously hand-rolled. These tests pin
// the contract — record errors must never propagate; success returns
// the propagated cost.
//
// Codex P2 on PR #220: the helper takes a `() => UsageRecord` thunk
// (not a value) so that constructing the payload — e.g., reading
// `response.usage.input_tokens` on a malformed Anthropic response —
// happens INSIDE the protected try block. A value-arg shape would
// throw before the helper could swallow it.
describe("safeRecordUsage", () => {
  it("returns the cost when record resolves", async () => {
    const record = vi.fn(async () => 0.42);
    const result = await safeRecordUsage(
      record,
      () => SAMPLE_USAGE,
      "extraction.resume",
    );
    expect(result).toBe(0.42);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(SAMPLE_USAGE);
  });

  it("returns 0 and swallows the error when record rejects", async () => {
    const record = vi.fn(async () => {
      throw new Error("synthetic telemetry failure");
    });
    // Critical contract: caller must observe no thrown error and a
    // 0-cost reading. Without this, a flaky Firestore write could
    // kill a successful LLM verdict — the prior PR-#113 regression
    // this helper prevents from recurring.
    await expect(
      safeRecordUsage(record, () => SAMPLE_USAGE, "extraction.resume"),
    ).resolves.toBe(0);
  });

  it("returns 0 when record throws synchronously (defense-in-depth)", async () => {
    const record = vi.fn(() => {
      throw new Error("non-async throw");
    });
    await expect(
      safeRecordUsage(record, () => SAMPLE_USAGE, "validation.specificity"),
    ).resolves.toBe(0);
  });

  it("returns 0 when the build-usage thunk itself throws (e.g., malformed response.usage)", async () => {
    // Codex P2 pin on PR #220: the thunk must run inside the
    // helper's try/catch. A value-arg shape would evaluate the
    // payload eagerly before the helper was invoked — a malformed
    // `response.usage.input_tokens` access would throw past the
    // helper and kill the caller's success path.
    const record = vi.fn(async () => 0.42);
    const buildUsage = (): UsageRecord => {
      const malformed = undefined as unknown as {
        usage: { input_tokens: number };
      };
      return { ...SAMPLE_USAGE, inputTokens: malformed.usage.input_tokens };
    };
    await expect(
      safeRecordUsage(record, buildUsage, "extraction.resume"),
    ).resolves.toBe(0);
    // The record fn never got called — the thunk threw first.
    expect(record).not.toHaveBeenCalled();
  });
});

// `recordUsage` persists an `llm_calls` doc fire-and-forget through
// `getAdminDb()`. These tests pin two contracts:
//   - #325: latencyMs is validated before it reaches the doc, so a
//     NaN/Infinity/negative value can't pollute latency rollups.
//   - #326: a synchronous throw from `getAdminDb()` is swallowed, so
//     the "telemetry never throws into the caller" invariant holds
//     end-to-end (the `.catch` alone only covers async rejections).
describe("recordUsage persistence", () => {
  const getAdminDbMock = vi.mocked(getAdminDb);

  beforeEach(() => {
    getAdminDbMock.mockReset();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });

  it("persists a well-formed latencyMs unchanged", async () => {
    const { db, add } = mockDb();
    getAdminDbMock.mockReturnValue(db as never);
    await recordUsage({ ...SAMPLE_USAGE, latencyMs: 123 });
    // Let the fire-and-forget microtask settle.
    await Promise.resolve();
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toMatchObject({ latencyMs: 123 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -5])(
    "coerces invalid latencyMs (%s) to 0 in the persisted doc",
    async (bad) => {
      const { db, add } = mockDb();
      getAdminDbMock.mockReturnValue(db as never);
      await recordUsage({ ...SAMPLE_USAGE, latencyMs: bad });
      await Promise.resolve();
      expect(add).toHaveBeenCalledTimes(1);
      expect(add.mock.calls[0]![0]).toMatchObject({ latencyMs: 0 });
    },
  );

  it("returns the cost and never throws when getAdminDb throws synchronously", async () => {
    getAdminDbMock.mockImplementation(() => {
      throw new Error("Firebase app not initialized");
    });
    // The caller must observe the cost, not the telemetry-init throw.
    await expect(
      recordUsage({ ...SAMPLE_USAGE, inputTokens: 1000, outputTokens: 1000 }),
    ).resolves.toBeGreaterThan(0);
  });
});

// #483: cache-token categories, long-prompt rate cards, and
// requested-versus-served model attribution.
describe("priceFor — cache and long-prompt pricing (#483)", () => {
  it("prices cache writes and reads on their own rates", () => {
    // Sonnet 4.6: 1000 in @ $3 + 1000 out @ $15 + 1000 write @ $3.75
    // + 1000 read @ $0.30, all per MTok.
    const cost = priceFor("claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 1000,
    });
    expect(cost).toBeCloseTo((3 + 15 + 3.75 + 0.3) / 1000, 9);
  });

  it("treats unreported cache fields as no cache traffic", () => {
    expect(priceFor("claude-sonnet-4-6", { inputTokens: 1000, outputTokens: 0 })).toBeCloseTo(
      0.003,
      9,
    );
  });

  it("throws on cache tokens for a model with no cache rate", () => {
    expect(() =>
      priceFor("text-embedding-3-small", {
        inputTokens: 10,
        outputTokens: 0,
        cacheReadInputTokens: 5,
      }),
    ).toThrow(/No cache-read rate registered/);
  });

  it("rejects negative or non-finite cache token counts", () => {
    expect(() =>
      priceFor("claude-sonnet-4-6", {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: -1,
      }),
    ).toThrow(/finite, non-negative/);
    expect(() =>
      priceFor("claude-sonnet-4-6", {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: Number.NaN,
      }),
    ).toThrow(/finite, non-negative/);
  });

  it("prices a Haiku 5.5 prompt of exactly 100,000 tokens on the short card", () => {
    const cost = priceFor("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 1000 });
    // 100K in @ $0.10 + 1K out @ $0.50 per MTok.
    expect(cost).toBeCloseTo(0.01 + 0.0005, 9);
  });

  it("prices a Haiku 5.5 prompt over 100,000 tokens — cache reads included — on the long card", () => {
    const cost = priceFor("claude-haiku-5-5", {
      inputTokens: 90_000,
      outputTokens: 1000,
      cacheReadInputTokens: 10_001,
    });
    // 90K in @ $0.50 + 1K out @ $2.50 + 10,001 read @ $0.05 per MTok.
    expect(cost).toBeCloseTo(0.045 + 0.0025 + 10_001 * 0.05e-6, 9);
  });
});

describe("pricedModelFor / priceUsage (#483)", () => {
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });

  it("prices the requested model when no served model is reported", () => {
    expect(pricedModelFor({ model: "claude-sonnet-4-6" })).toBe("claude-sonnet-4-6");
  });

  it("prices the served model when it differs and has a rate", () => {
    const usage: UsageRecord = {
      ...SAMPLE_USAGE,
      model: "claude-sonnet-4-6",
      servedModel: "claude-haiku-4-5-20251001",
      inputTokens: 1000,
      outputTokens: 1000,
    };
    expect(priceUsage(usage)).toEqual({
      costUsd: priceFor("claude-haiku-4-5-20251001", usage),
      pricedModel: "claude-haiku-4-5-20251001",
    });
  });

  it("falls back to the requested model, and warns, when the served model has no rate", () => {
    const warn = vi.mocked(logger.warn);
    expect(
      pricedModelFor({ model: "claude-sonnet-4-6", servedModel: "claude-sonnet-4-6-snapshot" }),
    ).toBe("claude-sonnet-4-6");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("served model has no rate"),
      expect.objectContaining({ servedModel: "claude-sonnet-4-6-snapshot" }),
    );
  });

  it("throws when neither model has a rate", () => {
    expect(() =>
      priceUsage({ ...SAMPLE_USAGE, model: "nope", servedModel: "also-nope" }),
    ).toThrow(/No rate registered for model: nope/);
  });
});

describe("anthropicUsageFields (#483)", () => {
  it("keeps reported cache counts — including a reported 0 — and the served model", () => {
    expect(
      anthropicUsageFields({
        model: "claude-haiku-4-5-20251001",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 7,
        } as never,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 7,
      servedModel: "claude-haiku-4-5-20251001",
    });
  });

  it("leaves cache counts the API returned as null unreported, not zero", () => {
    const fields = anthropicUsageFields({
      model: "claude-haiku-4-5-20251001",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      } as never,
    });
    expect(fields).not.toHaveProperty("cacheCreationInputTokens");
    expect(fields).not.toHaveProperty("cacheReadInputTokens");
  });
});

describe("promptVersionLabel (#483)", () => {
  it("formats stage/name.version", () => {
    expect(promptVersionLabel({ stage: "validation", name: "traceability", version: "v1" })).toBe(
      "validation/traceability.v1",
    );
  });
});

describe("recordUsage — versioned records (#483)", () => {
  const getAdminDbMock = vi.mocked(getAdminDb);

  beforeEach(() => {
    getAdminDbMock.mockReset();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
  });

  it("persists metadata, the schema version, and the priced model", async () => {
    const { db, add } = mockDb();
    getAdminDbMock.mockReturnValue(db as never);
    const cost = await recordUsage({
      ...SAMPLE_USAGE,
      stage: "validation",
      subtask: "traceability",
      servedModel: "claude-sonnet-4-6",
      cacheReadInputTokens: 0,
      promptVersion: "validation/traceability.v1",
      attempt: 1,
      maxTokens: 1024,
      applicationId: "app-1",
    });
    await Promise.resolve();
    expect(cost).toBeGreaterThan(0);
    const doc = add.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc).toMatchObject({
      usageSchemaVersion: USAGE_SCHEMA_VERSION,
      costStatus: "priced",
      costUsd: cost,
      pricedModel: "claude-sonnet-4-6",
      subtask: "traceability",
      cacheReadInputTokens: 0,
      promptVersion: "validation/traceability.v1",
      attempt: 1,
      maxTokens: 1024,
      applicationId: "app-1",
    });
    // Firestore rejects undefined values; absent optionals stay absent.
    expect(Object.values(doc)).not.toContain(undefined);
    expect(doc).not.toHaveProperty("cacheCreationInputTokens");
  });

  it("persists an unknown-rate call as unpriced, without a costUsd, and logs an error", async () => {
    const { db, add } = mockDb();
    getAdminDbMock.mockReturnValue(db as never);
    const cost = await recordUsage({ ...SAMPLE_USAGE, model: "claude-unregistered" });
    await Promise.resolve();
    expect(cost).toBe(0);
    expect(add).toHaveBeenCalledTimes(1);
    const doc = add.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc).toMatchObject({ costStatus: "unpriced", inputTokens: 100, outputTokens: 200 });
    expect(doc).not.toHaveProperty("costUsd");
    expect(doc).not.toHaveProperty("pricedModel");
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining("pricing failed"),
      expect.objectContaining({ model: "claude-unregistered" }),
    );
  });

  it("drops a call with malformed token counts instead of persisting it", async () => {
    const { db, add } = mockDb();
    getAdminDbMock.mockReturnValue(db as never);
    await expect(recordUsage({ ...SAMPLE_USAGE, outputTokens: -1 })).resolves.toBe(0);
    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();
  });
});
