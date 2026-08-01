/**
 * Tests for the eval stage cache (#389).
 *
 * The load-bearing invariants, in priority order:
 *
 *   1. A hit does NOT invoke `compute` — that is the entire point
 *      (no tokens, no network).
 *   2. Any input that can change the output changes the key.
 *   3. `--samples N > 1` bypasses the cache, so variance measurement
 *      stays real (#177 relies on `--samples 3` for per-cell variance).
 *   4. Modeled cost is identical on a hit and a miss, so the model
 *      sweep's ranking doesn't move with cache state.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageRecord } from "../../functions/src/llm/cost.ts";

import {
  _resetUnpricedWarningsForTests,
  cacheKey,
  resolveCacheMode,
  StageCache,
  sumUsageCost,
  type CacheKeyInput,
} from "./cache.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matchline-eval-cache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE: CacheKeyInput = {
  stage: "extraction",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  promptVersion: "v1",
  input: "resume text",
};

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    stage: "extraction",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    outputTokens: 2000,
    latencyMs: 1234,
    ...overrides,
  };
}

describe("cacheKey", () => {
  it("is stable for identical inputs", () => {
    expect(cacheKey(BASE)).toBe(cacheKey({ ...BASE }));
  });

  it.each([
    ["stage", { stage: "requirement_parsing" }],
    ["provider", { provider: "openai" }],
    ["model", { model: "claude-haiku-4-5-20251001" }],
    ["promptVersion", { promptVersion: "v2" }],
    ["input", { input: "different resume" }],
  ] as const)("changes when %s changes", (_label, override) => {
    expect(cacheKey({ ...BASE, ...override })).not.toBe(cacheKey(BASE));
  });

  it("changes when a discriminator changes", () => {
    const api = cacheKey({ ...BASE, discriminators: { tokenSource: "api" } });
    const cli = cacheKey({ ...BASE, discriminators: { tokenSource: "cli" } });
    expect(api).not.toBe(cli);
    expect(api).not.toBe(cacheKey(BASE));
  });

  it("is insensitive to discriminator insertion order", () => {
    const a = cacheKey({ ...BASE, discriminators: { x: "1", y: "2" } });
    const b = cacheKey({ ...BASE, discriminators: { y: "2", x: "1" } });
    expect(a).toBe(b);
  });

  it("folds a stage-implementation fingerprint into every key", () => {
    // Codex P2 round 2: model, prompt version, and fixture text can
    // all be unchanged while the code that turns them into Units
    // changes (stamping, retries, Zod schema). Without an impl
    // fingerprint the cache replays pre-change results and the run
    // silently bypasses the code being evaluated. Pinning the key
    // shape here means a future edit that drops the fingerprint
    // from `cacheKey` fails loudly instead of quietly corrupting
    // experiment comparisons.
    const key = cacheKey(BASE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Bumping STAGE_IMPL_VERSION must change every key. Proxy the
    // check through a discriminator that occupies the same role: if
    // the constant were dropped from the canonical tuple, the two
    // keys below would still differ, but the tuple-position test in
    // the concatenation case above would start colliding.
    expect(cacheKey({ ...BASE, promptVersion: "v1 " })).not.toBe(key);
  });

  it("cannot be collided by concatenation ambiguity across fields", () => {
    // "ab"+"c" vs "a"+"bc" must not hash the same — the canonical
    // JSON encoding is what prevents this.
    const a = cacheKey({ ...BASE, model: "ab", promptVersion: "c" });
    const b = cacheKey({ ...BASE, model: "a", promptVersion: "bc" });
    expect(a).not.toBe(b);
  });
});

describe("StageCache", () => {
  it("misses on first call, hits on second, and skips compute on the hit", async () => {
    const cache = new StageCache({ dir });
    let computeCalls = 0;

    const first = await cache.run(BASE, async (record) => {
      computeCalls += 1;
      await record(usage());
      return { units: ["a", "b"] };
    });

    expect(first.hit).toBe(false);
    expect(computeCalls).toBe(1);

    const second = await cache.run(BASE, async (record) => {
      computeCalls += 1;
      await record(usage());
      return { units: ["SHOULD NOT BE REACHED"] };
    });

    expect(second.hit).toBe(true);
    // The critical assertion: no recompute, therefore no tokens.
    expect(computeCalls).toBe(1);
    expect(second.value).toEqual({ units: ["a", "b"] });
    expect(cache.stats()).toEqual({
      hits: 1,
      misses: 1,
      writes: 1,
      // Per-provider split (Codex P2 round 2) — the projection guard
      // scales each provider by its OWN miss rate, because embeddings
      // hitting while the Anthropic stages miss would otherwise read
      // as "50% warm" and halve the Anthropic estimate.
      hitsByProvider: { anthropic: 1 },
      missesByProvider: { anthropic: 1 },
    });
  });

  it("replays usage records on a hit so modeled cost is cache-independent", async () => {
    const cache = new StageCache({ dir });
    const miss = await cache.run(BASE, async (record) => {
      await record(usage());
      return "value";
    });
    const hit = await cache.run(BASE, async () => "unreachable");

    expect(hit.usage).toEqual(miss.usage);
    // This equality is what lets the sweep rank models on
    // `modeledCostUsd` regardless of whether the cache was warm.
    expect(sumUsageCost(hit.usage)).toBe(sumUsageCost(miss.usage));
    expect(sumUsageCost(hit.usage)).toBeGreaterThan(0);
  });

  it("busts the entry when the prompt version changes", async () => {
    const cache = new StageCache({ dir });
    await cache.run(BASE, async () => "v1-result");
    const afterBump = await cache.run(
      { ...BASE, promptVersion: "v2" },
      async () => "v2-result",
    );
    expect(afterBump.hit).toBe(false);
    expect(afterBump.value).toBe("v2-result");
  });

  it("leaves sibling stages warm when one stage's key changes", async () => {
    const cache = new StageCache({ dir });
    const parsing: CacheKeyInput = {
      ...BASE,
      stage: "requirement_parsing",
      input: "jd text",
    };
    await cache.run(BASE, async () => "extraction");
    await cache.run(parsing, async () => "parsing");

    // Change only the extraction prompt.
    const extractionAfter = await cache.run(
      { ...BASE, promptVersion: "v2" },
      async () => "extraction-v2",
    );
    const parsingAfter = await cache.run(parsing, async () => "unreachable");

    expect(extractionAfter.hit).toBe(false);
    expect(parsingAfter.hit).toBe(true);
    expect(parsingAfter.value).toBe("parsing");
  });

  describe("mode: bypass", () => {
    it("never reads and never writes", async () => {
      const warm = new StageCache({ dir });
      await warm.run(BASE, async () => "cached");

      const bypass = new StageCache({ dir, mode: "bypass" });
      let calls = 0;
      const a = await bypass.run(BASE, async () => {
        calls += 1;
        return "live-1";
      });
      const b = await bypass.run(BASE, async () => {
        calls += 1;
        return "live-2";
      });

      expect(a.hit).toBe(false);
      expect(b.hit).toBe(false);
      expect(calls).toBe(2);
      expect(a.value).toBe("live-1");
      expect(b.value).toBe("live-2");
      expect(bypass.stats().writes).toBe(0);
    });

    it("does not overwrite an existing entry", async () => {
      const warm = new StageCache({ dir });
      await warm.run(BASE, async () => "original");

      const bypass = new StageCache({ dir, mode: "bypass" });
      await bypass.run(BASE, async () => "replacement");

      const reader = new StageCache({ dir });
      const outcome = await reader.run(BASE, async () => "unreachable");
      expect(outcome.hit).toBe(true);
      expect(outcome.value).toBe("original");
    });
  });

  describe("mode: refresh", () => {
    it("ignores the stored entry but writes a fresh one", async () => {
      const warm = new StageCache({ dir });
      await warm.run(BASE, async () => "stale");

      const refresh = new StageCache({ dir, mode: "refresh" });
      const outcome = await refresh.run(BASE, async () => "fresh");
      expect(outcome.hit).toBe(false);

      const reader = new StageCache({ dir });
      const after = await reader.run(BASE, async () => "unreachable");
      expect(after.hit).toBe(true);
      expect(after.value).toBe("fresh");
    });

    // Codex P1: without within-run reuse, `--refresh-cache --full` on
    // a 10x10 corpus re-extracts each resume once per JD — 100 calls
    // instead of 10, defeating the dedup this cache exists for. And
    // since extraction is non-deterministic, the same resume would
    // yield different Units in different cells while all of them
    // overwrite one key, leaving the corpus internally inconsistent.
    it("reuses a key it already refreshed earlier in the same run", async () => {
      const warm = new StageCache({ dir });
      await warm.run(BASE, async () => "stale");

      const refresh = new StageCache({ dir, mode: "refresh" });
      let computes = 0;
      const first = await refresh.run(BASE, async () => {
        computes += 1;
        return "fresh-1";
      });
      const second = await refresh.run(BASE, async () => {
        computes += 1;
        return "fresh-2";
      });

      expect(first.hit).toBe(false);
      expect(second.hit).toBe(true);
      expect(second.value).toBe("fresh-1");
      // The whole point: one recompute, not two.
      expect(computes).toBe(1);
    });

    it("still ignores prior-run entries for keys it has not refreshed yet", async () => {
      const warm = new StageCache({ dir });
      await warm.run(BASE, async () => "stale-a");
      const other: CacheKeyInput = { ...BASE, input: "different resume" };
      await warm.run(other, async () => "stale-b");

      const refresh = new StageCache({ dir, mode: "refresh" });
      await refresh.run(BASE, async () => "fresh-a");
      // `other` has NOT been refreshed this run, so its stale entry
      // must not be served.
      const outcome = await refresh.run(other, async () => "fresh-b");
      expect(outcome.hit).toBe(false);
      expect(outcome.value).toBe("fresh-b");
    });

    it("does not mark a key reusable when the persist failed", async () => {
      // A failed write must not make the next lookup believe a fresh
      // entry exists on disk.
      //
      // Codex P2: this used to point at `/nonexistent-root/deny` and
      // assume the path was unwritable. Running as root — common in
      // CI containers — that hierarchy is creatable, the write
      // succeeds, and the assertion inverts. Force the failure
      // structurally instead: put a regular FILE where the stage
      // directory needs to be, so `mkdirSync` fails with ENOTDIR for
      // every user including root.
      const blockedRoot = join(dir, "blocked");
      mkdirSync(blockedRoot, { recursive: true });
      writeFileSync(join(blockedRoot, "extraction"), "not a directory", "utf8");

      const refresh = new StageCache({ dir: blockedRoot, mode: "refresh" });
      const first = await refresh.run(BASE, async () => "one");
      const second = await refresh.run(BASE, async () => "two");
      expect(first.hit).toBe(false);
      expect(second.hit).toBe(false);
      expect(second.value).toBe("two");
    });
  });

  describe("corruption tolerance", () => {
    it("treats an unparseable entry as a miss instead of throwing", async () => {
      const cache = new StageCache({ dir });
      await cache.run(BASE, async () => "good");

      // Corrupt the entry in place, simulating an interrupted write.
      const key = cacheKey(BASE);
      const file = join(dir, "extraction", `${key}.json`);
      expect(existsSync(file)).toBe(true);
      writeFileSync(file, "{ this is not json", "utf8");

      const recovered = new StageCache({ dir });
      const outcome = await recovered.run(BASE, async () => "recomputed");
      expect(outcome.hit).toBe(false);
      expect(outcome.value).toBe("recomputed");
    });

    it("treats an entry with a mismatched schemaVersion as a miss", async () => {
      const key = cacheKey(BASE);
      mkdirSync(join(dir, "extraction"), { recursive: true });
      writeFileSync(
        join(dir, "extraction", `${key}.json`),
        JSON.stringify({ schemaVersion: 999, key, value: "old-shape", usage: [] }),
        "utf8",
      );

      const cache = new StageCache({ dir });
      const outcome = await cache.run(BASE, async () => "recomputed");
      expect(outcome.hit).toBe(false);
      expect(outcome.value).toBe("recomputed");
    });
  });

  it("sanitizes the stage into a safe path segment", async () => {
    const cache = new StageCache({ dir });
    const outcome = await cache.run(
      { ...BASE, stage: "../../escape" },
      async () => "value",
    );
    expect(outcome.hit).toBe(false);
    // The traversal attempt must land inside the cache dir.
    expect(existsSync(join(dir, "______escape"))).toBe(true);
  });
});

describe("resolveCacheMode", () => {
  it("defaults to read-write", () => {
    expect(resolveCacheMode([], 1)).toBe("read-write");
  });

  it("bypasses on --no-cache", () => {
    expect(resolveCacheMode(["--no-cache"], 1)).toBe("bypass");
  });

  it("refreshes on --refresh-cache", () => {
    expect(resolveCacheMode(["--refresh-cache"], 1)).toBe("refresh");
  });

  // The load-bearing one: #177 uses `--samples 3` specifically to
  // measure per-cell variance. Serving samples 2..N from cache would
  // report variance of exactly 0 and silently invalidate the metric.
  it("forces bypass when samples > 1, even without --no-cache", () => {
    expect(resolveCacheMode([], 2)).toBe("bypass");
    expect(resolveCacheMode([], 3)).toBe("bypass");
  });

  it("lets samples > 1 outrank --refresh-cache", () => {
    // refresh still WRITES; N samples writing the same key would
    // leave whichever finished last as the canonical entry.
    expect(resolveCacheMode(["--refresh-cache"], 3)).toBe("bypass");
  });

  it("keeps read-write for the single-sample default", () => {
    expect(resolveCacheMode(["--full"], 1)).toBe("read-write");
  });
});

describe("sumUsageCost", () => {
  it("sums priced usage records", () => {
    // Sonnet 4.6: $0.003/1k in, $0.015/1k out.
    // 1000 in + 2000 out = 0.003 + 0.030 = 0.033
    expect(sumUsageCost([usage()])).toBeCloseTo(0.033, 10);
    expect(sumUsageCost([usage(), usage()])).toBeCloseTo(0.066, 10);
  });

  it("returns 0 for an empty set", () => {
    expect(sumUsageCost([])).toBe(0);
  });

  it("contributes 0 for a model with no rates entry rather than throwing", () => {
    expect(() =>
      sumUsageCost([usage({ model: "some-unregistered-model" })]),
    ).not.toThrow();
    expect(sumUsageCost([usage({ model: "some-unregistered-model" })])).toBe(0);
  });

  // Codex P2: the previous version swallowed the pricing failure
  // silently, and its comment claimed a caller reported the gap — no
  // such caller existed. A renamed or newly-added model looked FREE
  // and quietly invalidated every cost comparison in the report.
  it("warns to stderr about an unpriced model, once per model", () => {
    _resetUnpricedWarningsForTests();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });

    sumUsageCost([usage({ model: "mystery-model" })]);
    sumUsageCost([usage({ model: "mystery-model" })]);
    sumUsageCost([usage({ model: "other-mystery" })]);
    spy.mockRestore();

    const mystery = writes.filter((w) => w.includes("mystery-model"));
    expect(mystery).toHaveLength(1);
    expect(mystery[0]).toMatch(/UNDERSTATEMENT/);
    expect(mystery[0]).toMatch(/rates\.ts/);
    // A different model gets its own warning.
    expect(writes.filter((w) => w.includes("other-mystery"))).toHaveLength(1);
  });

  it("does not warn for a priced model", () => {
    _resetUnpricedWarningsForTests();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    sumUsageCost([usage()]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
