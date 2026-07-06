import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import { recordUsage } from "./cost.js";
import { embed, embedMany } from "./embeddings.js";

type CreateResult = Awaited<ReturnType<OpenAI["embeddings"]["create"]>>;

/** Build an injectable OpenAI stand-in whose create returns `result`. */
function fakeClient(result: unknown): OpenAI {
  return {
    embeddings: { create: vi.fn(async () => result as CreateResult) },
  } as unknown as OpenAI;
}

const usageBlock = { prompt_tokens: 42, total_tokens: 42 };

describe("embed usage recording", () => {
  it("records usage BEFORE the empty-data validation throws", async () => {
    // Response is billed (has usage) but returns no data — the shape
    // check must throw AFTER telemetry is recorded, so the charged
    // call is not lost from llm_calls. (#323)
    const record = vi.fn<typeof recordUsage>(async () => 0.001);
    const client = fakeClient({ data: [], usage: usageBlock });
    await expect(embed("hello", { client, record })).rejects.toThrow(
      /returned no data/,
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ inputTokens: 42 });
  });

  it("throws when prompt_tokens is missing instead of silently defaulting to 0", async () => {
    const record = vi.fn<typeof recordUsage>(async () => 0.001);
    const client = fakeClient({
      data: [{ embedding: [0.1, 0.2] }],
      usage: { total_tokens: 0 },
    });
    await expect(embed("hello", { client, record })).rejects.toThrow(
      /missing numeric prompt_tokens/,
    );
  });

  it("returns the embedding and records real token usage on the happy path", async () => {
    const record = vi.fn<typeof recordUsage>(async () => 0.001);
    const client = fakeClient({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      usage: usageBlock,
    });
    await expect(embed("hello", { client, record })).resolves.toEqual([
      0.1, 0.2, 0.3,
    ]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ inputTokens: 42 });
  });
});

describe("embedMany usage recording", () => {
  it("records usage BEFORE the count-mismatch validation throws", async () => {
    const record = vi.fn<typeof recordUsage>(async () => 0.001);
    // Two inputs but only one returned row — mismatch must throw
    // AFTER telemetry is recorded for the billed call. (#323)
    const client = fakeClient({
      data: [{ embedding: [0.1] }],
      usage: usageBlock,
    });
    await expect(embedMany(["a", "b"], { client, record })).rejects.toThrow(
      /count mismatch/,
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ inputTokens: 42 });
  });

  it("throws when prompt_tokens is missing", async () => {
    const record = vi.fn<typeof recordUsage>(async () => 0.001);
    const client = fakeClient({
      data: [{ embedding: [0.1] }],
      usage: { total_tokens: 0 },
    });
    await expect(embedMany(["a"], { client, record })).rejects.toThrow(
      /missing numeric prompt_tokens/,
    );
  });

  it("returns index-aligned embeddings on the happy path", async () => {
    const record = vi.fn<typeof recordUsage>(async () => 0.001);
    const client = fakeClient({
      data: [{ embedding: [0.1] }, { embedding: [0.2] }],
      usage: usageBlock,
    });
    await expect(embedMany(["a", "b"], { client, record })).resolves.toEqual([
      [0.1],
      [0.2],
    ]);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
