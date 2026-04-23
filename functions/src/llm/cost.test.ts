import { describe, expect, it } from "vitest";

import { priceFor } from "./cost.js";

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
