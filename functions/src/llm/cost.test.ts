import { describe, expect, it, vi } from "vitest";

import { priceFor, safeRecordUsage, type UsageRecord } from "./cost.js";

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
