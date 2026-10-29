import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenAIClient as OpenAI } from "../../../functions/src/llm/openai.ts";

import {
  cacheLinesFor,
  embeddingTokenBound,
  EmbeddingCache,
  EmbeddingRefusal,
  estimateEmbeddingTokens,
  priceEmbeddingTokens,
  textHash,
} from "./embeddingCache.ts";
import { gitRepo, mockOpenAi, textVector } from "./testSupport.ts";

let base: string;
let root: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "matchline-embcache-"));
  root = gitRepo(join(base, "repo"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("EmbeddingCache", () => {
  it("keys on model + sha256 of the text and stores no text", async () => {
    const path = join(base, "c", "e.jsonl");
    const cache = EmbeddingCache.load(path, { root });
    const client = mockOpenAi();
    await cache.fill(["alpha text", "beta text"], { client, maxUsd: 1 });
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.sha256)).toEqual([textHash("alpha text"), textHash("beta text")]);
    expect(lines[0]).toMatchObject({ v: 1, model: "text-embedding-3-small", dims: 64 });
    expect(readFileSync(path, "utf8")).not.toContain("alpha");
    expect(cache.get("alpha text")).toEqual(textVector("alpha text"));
  });

  it("a second run over the same texts makes zero requests", async () => {
    const path = join(base, "e.jsonl");
    const client = mockOpenAi();
    const texts = ["one thing", "two things", "one thing"];
    const first = await EmbeddingCache.load(path, { root }).fill(texts, { client, maxUsd: 1 });
    expect(first.requests).toBe(1);
    // Identical texts are embedded once.
    expect(client.embeddings.create).toHaveBeenCalledWith({ model: "text-embedding-3-small", input: ["one thing", "two things"] });
    const reloaded = EmbeddingCache.load(path, { root });
    expect(reloaded.plan(texts).uncached).toEqual([]);
    const second = await reloaded.fill(texts, { client, maxUsd: 1 });
    expect(second).toEqual({ requests: 0, embedded: 0, inputTokens: 0, usd: 0 });
    expect(client.embeddings.create).toHaveBeenCalledTimes(1);
  });

  it("a model change is a miss", () => {
    const path = join(base, "e.jsonl");
    writeFileSync(path, cacheLinesFor([{ text: "x y z", vector: [1, 0] }]));
    expect(EmbeddingCache.load(path, { root }).has("x y z")).toBe(true);
    expect(EmbeddingCache.load(path, { root, model: "text-embedding-3-large" }).has("x y z")).toBe(false);
  });

  it("first line wins on a duplicate key", () => {
    const path = join(base, "e.jsonl");
    writeFileSync(path, cacheLinesFor([{ text: "dup", vector: [1, 2] }, { text: "dup", vector: [3, 4] }]));
    expect(EmbeddingCache.load(path, { root }).get("dup")).toEqual([1, 2]);
  });

  it("keeps vectors aligned with their texts across chunks", async () => {
    const path = join(base, "e.jsonl");
    const texts = Array.from({ length: 7 }, (_, i) => `text number ${i} word${i}`);
    const cache = EmbeddingCache.load(path, { root });
    const result = await cache.fill(texts, { client: mockOpenAi(), maxUsd: 1, chunkSize: 3 });
    expect(result.requests).toBe(3);
    for (const t of texts) expect(EmbeddingCache.load(path, { root }).get(t)).toEqual(textVector(t));
  });

  it("refuses a malformed line with path:line, and a dims mismatch", () => {
    const path = join(base, "e.jsonl");
    writeFileSync(path, `${cacheLinesFor([{ text: "a", vector: [1] }])}not json\n`);
    expect(() => EmbeddingCache.load(path, { root })).toThrow(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2: not valid JSON`));
    writeFileSync(path, `${JSON.stringify({ v: 1, model: "m", sha256: textHash("a"), dims: 3, vector: [1, 2] })}\n`);
    expect(() => EmbeddingCache.load(path, { root })).toThrow(/:1: dims 3 disagrees/);
  });

  it("appends each chunk as it returns, so a failure keeps what was paid for", async () => {
    const path = join(base, "e.jsonl");
    const ok = mockOpenAi();
    let calls = 0;
    const flaky = {
      embeddings: {
        create: vi.fn(async (params: { model: string; input: string[] }) => {
          calls += 1;
          if (calls === 2) throw new Error("network down");
          return ok.embeddings.create(params);
        }),
      },
    } as unknown as OpenAI;
    const texts = ["a one", "b two", "c three", "d four"];
    await expect(EmbeddingCache.load(path, { root }).fill(texts, { client: flaky, maxUsd: 1, chunkSize: 2 })).rejects.toThrow(/network down/);
    const reloaded = EmbeddingCache.load(path, { root });
    expect(reloaded.plan(texts).uncached).toEqual(["c three", "d four"]);
  });

  it("refuses the next chunk when it would pass the bound", async () => {
    const path = join(base, "e.jsonl");
    const texts = ["x".repeat(4000), "y".repeat(4000)];
    const oneChunk = priceEmbeddingTokens(embeddingTokenBound(texts[0]!));
    const client = mockOpenAi();
    // The first request bills a quarter of its bound; the second chunk's full bound no longer fits.
    const err = await EmbeddingCache.load(path, { root })
      .fill(texts, { client, maxUsd: oneChunk * 1.1, chunkSize: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingRefusal);
    expect(String(err)).toMatch(/1 of 2 texts were embedded/);
    expect(client.embeddings.create).toHaveBeenCalledTimes(1);
  });

  it("never counts a request it cannot price as free: falls back to the bound and warns", async () => {
    const path = join(base, "e.jsonl");
    const texts = ["x".repeat(4000), "y".repeat(4000), "z".repeat(4000)];
    const oneChunk = priceEmbeddingTokens(embeddingTokenBound(texts[0]!));
    const warnings: string[] = [];
    const unpriceable = (): number => {
      throw new Error("no rate card for text-embedding-3-small-2099");
    };
    // --max-usd fits two chunks' bounds, not three: the fallback must carry the spend forward.
    const err = await EmbeddingCache.load(path, { root })
      .fill(texts, { client: mockOpenAi(), maxUsd: oneChunk * 2.5, chunkSize: 1, priceUsage: unpriceable, warn: (m) => warnings.push(m) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingRefusal);
    expect(String(err)).toMatch(/2 of 3 texts were embedded/);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/could not price embedding usage .*no rate card/);
    const ok = await EmbeddingCache.load(join(base, "f.jsonl"), { root }).fill(texts.slice(0, 1), {
      client: mockOpenAi(),
      maxUsd: 1,
      priceUsage: unpriceable,
      warn: () => undefined,
    });
    expect(ok.usd).toBeGreaterThanOrEqual(oneChunk);
  });

  it("plans distinct and uncached texts with a priced estimate", () => {
    const path = join(base, "e.jsonl");
    writeFileSync(path, cacheLinesFor([{ text: "cached", vector: [1] }]));
    const plan = EmbeddingCache.load(path, { root }).plan(["cached", "fresh words", "fresh words"]);
    expect(plan).toMatchObject({ uniqueTexts: 2, cachedTexts: 1, uncached: ["fresh words"] });
    expect(plan.estimatedTokens).toBe(estimateEmbeddingTokens("fresh words"));
    expect(plan.estimatedUsd).toBeCloseTo((plan.estimatedTokens / 1e6) * 0.02, 12);
    expect(plan.boundTokens).toBe("fresh words".length);
    expect(plan.boundUsd).toBeCloseTo((plan.boundTokens / 1e6) * 0.02, 12);
  });

  it("guards on the UTF-8 byte length, which bounds CJK text the chars/4 estimate undercounts", async () => {
    // 14 CJK characters, 42 UTF-8 bytes. cl100k_base spends roughly a token per
    // character on such text, more than twice the chars/4 × 1.35 estimate of 6.
    const cjk = "日本語の埋め込みテキストです";
    expect(cjk.length).toBe(14);
    expect(embeddingTokenBound(cjk)).toBe(42);
    expect(estimateEmbeddingTokens(cjk)).toBe(6);
    expect(embeddingTokenBound(cjk)).toBeGreaterThan(cjk.length); // above even one token per character
    expect(embeddingTokenBound("😀")).toBe(4);
    const path = join(base, "e.jsonl");
    const cache = EmbeddingCache.load(path, { root });
    const plan = cache.plan([cjk]);
    expect(plan).toMatchObject({ estimatedTokens: 6, boundTokens: 42 });
    // A --max-usd the estimate fits but the bound does not: refused before any request.
    const maxUsd = (priceEmbeddingTokens(6) + priceEmbeddingTokens(42)) / 2;
    expect(plan.estimatedUsd).toBeLessThan(maxUsd);
    expect(plan.boundUsd).toBeGreaterThan(maxUsd);
    const client = mockOpenAi();
    const err = await cache.fill([cjk], { client, maxUsd }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingRefusal);
    expect(String(err)).toMatch(/UTF-8 bytes as tokens/);
    expect(client.embeddings.create).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    // At the bound itself it embeds.
    const ok = await cache.fill([cjk], { client, maxUsd: plan.boundUsd });
    expect(ok.embedded).toBe(1);
  });

  it("refuses a path inside the repository and accepts one outside it", () => {
    expect(() => EmbeddingCache.load(join(root, "cache.jsonl"), { root })).toThrow(/--embeddings-cache .* inside this repository/);
    expect(() => EmbeddingCache.load(join(base, "elsewhere", "cache.jsonl"), { root })).not.toThrow();
    expect(existsSync(join(base, "elsewhere"))).toBe(false);
    appendFileSync(join(base, "empty.jsonl"), "\n\n");
    expect(EmbeddingCache.load(join(base, "empty.jsonl"), { root }).size).toBe(0);
  });
});
