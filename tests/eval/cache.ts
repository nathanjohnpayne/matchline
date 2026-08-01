/**
 * Content-addressed stage cache for the eval harness (#389, unblocks #177).
 *
 * ## Why
 *
 * `runForFixture` calls `extractFromResume` and `parseJobRequirements`
 * inside the per-(resume × JD) loop, but extraction is a pure function
 * of the resume text and parsing is a pure function of the JD text.
 * On the 10×10 corpus #137 targets, that is 100 extractions for 10
 * distinct resumes and 100 parses for 10 distinct JDs — a 10× overpay
 * baked into the harness.
 *
 * More importantly for #177: the matching layer
 * (`functions/src/matching/`) contains **no LLM call at all** — it is
 * pure math over cached embeddings and the ontology. So once the
 * upstream stages are cached, iterating on mapping thresholds
 * (workstream A), score weights, and ontology coverage costs **$0 and
 * runs offline**. That is the difference between ~12 tuning runs a
 * month and unlimited ones.
 *
 * ## Key derivation
 *
 * `sha256` over a canonical JSON of the inputs that can change the
 * output: stage, provider, model, prompt version, the full input text,
 * and any caller-supplied discriminators. Changing the extraction
 * prompt busts only extraction entries; JD parses stay warm.
 *
 * ## Honest accounting
 *
 * A cache hit spends no tokens, so reporting the stored cost as
 * "spend" would be a lie, and reporting `$0` would hide what the
 * configuration actually costs to run. The cache therefore surfaces
 * BOTH, and callers report both:
 *
 *   - `costUsd`        — real new spend this run (0 on a hit)
 *   - `modeledCostUsd` — what this configuration costs uncached
 *
 * The model sweep ranks on `modeledCostUsd`; the projection guard in
 * `projection.ts` gates on `costUsd`.
 *
 * ## Sampling
 *
 * `--samples N` (N > 1) exists to measure run-to-run variance — #177
 * quotes per-cell variance as the reason for `--samples 3`. Serving
 * repeated samples from cache would collapse that variance to exactly
 * zero and silently invalidate the metric. `mode: "bypass"` is
 * therefore mandatory whenever samples > 1; `run.ts` enforces it and
 * `cache.test.ts` pins it.
 *
 * ## Storage
 *
 * One JSON file per entry under `tests/eval/.cache/<stage>/<sha>.json`.
 * Already gitignored via the root `.gitignore`'s `.cache/` rule.
 * Delete the directory to invalidate everything.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { priceFor, type UsageRecord } from "../../functions/src/llm/cost.ts";

/**
 * `read-write` — normal: serve hits, persist misses.
 * `bypass`     — never read, never write. Used by `--samples N > 1`.
 * `refresh`    — ignore entries written by PREVIOUS runs, but reuse a
 *                key once this run has recomputed it. Used to
 *                re-baseline a config without hand-deleting the cache
 *                directory. The within-run reuse is load-bearing: a
 *                `--refresh-cache --full` pass over a 10×10 corpus
 *                would otherwise re-extract each resume once per JD.
 */
export type StageCacheMode = "read-write" | "bypass" | "refresh";

export interface CacheKeyInput {
  /** Pipeline stage, e.g. "extraction" | "requirement_parsing" | "embedding". */
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  /** Resolved prompt version, e.g. "v1". Embeddings pass "n/a". */
  readonly promptVersion: string;
  /** The full input text the stage consumes. */
  readonly input: string;
  /**
   * Extra discriminators that change the output but aren't captured
   * above — e.g. `{ tokenSource: "cli" }` so API-produced and
   * CLI-produced entries never collide.
   */
  readonly discriminators?: Readonly<Record<string, string | number>>;
}

export interface CacheOutcome<T> {
  readonly value: T;
  /** True when served from cache (no tokens spent). */
  readonly hit: boolean;
  /**
   * Usage records for this stage — replayed from the stored entry on a
   * hit, collected live on a miss. Always populated so `modeledCostUsd`
   * is computable either way.
   */
  readonly usage: readonly UsageRecord[];
  /** The derived key, surfaced for debug output. */
  readonly key: string;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
}

interface StoredEntry<T> {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly createdAt: string;
  readonly value: T;
  readonly usage: readonly UsageRecord[];
}

/**
 * Entry-format version. Bump when the shape of `StoredEntry` changes
 * incompatibly; entries whose `schemaVersion` doesn't match are
 * treated as misses rather than deserialized into the wrong shape.
 */
const ENTRY_SCHEMA_VERSION = 1 as const;

/**
 * Fingerprint of the *stage implementations* whose output this cache
 * stores. Folded into every key, so bumping it invalidates every
 * entry at once.
 *
 * **Why (Codex P2 round 2).** Model, prompt version, and fixture text
 * can all stay identical while the code that turns them into Units
 * changes — extraction's server-side stamping, its retry behavior,
 * its Zod schema, the JD parser's categorization. Without this the
 * cache would replay pre-change results and the run would silently
 * bypass the very code being evaluated, corrupting exactly the
 * experiment comparisons this harness exists to produce.
 *
 * **Bump this when** you change `functions/src/extraction/resume.ts`,
 * `functions/src/parsing/jd.ts`, `functions/src/llm/embeddings.ts`,
 * or any Zod schema they validate against, in a way that can alter
 * output for unchanged inputs.
 *
 * A source-content hash would remove the discipline requirement, but
 * it would also invalidate on comment-only edits and needs a build
 * step to see the whole import graph. An explicit constant is the
 * same tradeoff the repo already accepts for prompt versions — with
 * the same failure mode if someone forgets, which is why
 * `--refresh-cache` and `rm -rf tests/eval/.cache` are documented.
 */
const STAGE_IMPL_VERSION = 1 as const;

const evalRoot = dirname(fileURLToPath(import.meta.url));

/** Default on-disk location: `tests/eval/.cache/`. */
export function defaultCacheDir(): string {
  return join(evalRoot, ".cache");
}

/**
 * Derive the content-addressed key. Pure — exported so tests can pin
 * the "same inputs → same key / any input change → different key"
 * invariant without touching the filesystem.
 *
 * Discriminators are sorted by key so callers can't produce two
 * different hashes for the same logical input by varying insertion
 * order.
 */
export function cacheKey(input: CacheKeyInput): string {
  const discriminators = Object.entries(input.discriminators ?? {})
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([
    ENTRY_SCHEMA_VERSION,
    STAGE_IMPL_VERSION,
    input.stage,
    input.provider,
    input.model,
    input.promptVersion,
    input.input,
    discriminators,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface StageCacheOptions {
  readonly mode?: StageCacheMode;
  /** Override the on-disk root (tests pass a tmpdir). */
  readonly dir?: string;
}

/**
 * A stage cache bound to a directory and a mode.
 *
 * Usage — the `compute` callback receives a `record` function it must
 * pass into the pipeline as its `record` dep, so the cache can capture
 * the usage that the pipeline emits:
 *
 * ```ts
 * const outcome = await cache.run(keyInput, async (record) =>
 *   extractFromResume(text, ctx, { client, record }),
 * );
 * ```
 */
export class StageCache {
  readonly mode: StageCacheMode;
  private readonly dir: string;
  private hits = 0;
  private misses = 0;
  private writes = 0;
  /**
   * Keys this run has already refreshed. Only consulted in `refresh`
   * mode, where it turns "ignore everything on disk" into "ignore
   * what PREVIOUS runs wrote" — see the read gate in `run()`.
   */
  private readonly refreshedThisRun = new Set<string>();

  constructor(options: StageCacheOptions = {}) {
    this.mode = options.mode ?? "read-write";
    this.dir = options.dir ?? defaultCacheDir();
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, writes: this.writes };
  }

  private pathFor(keyInput: CacheKeyInput, key: string): string {
    // Stage-namespaced so `rm -rf tests/eval/.cache/extraction` is a
    // meaningful operation. Stage is sanitized because it lands in a
    // path segment.
    const safeStage = keyInput.stage.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, safeStage, `${key}.json`);
  }

  /**
   * Run `compute` through the cache.
   *
   * On a hit the compute callback is never invoked — that is the whole
   * point (no network, no tokens). On a miss the callback runs, its
   * emitted usage records are captured, and both are persisted.
   *
   * A corrupt or unreadable entry is treated as a miss rather than
   * throwing: a half-written file from an interrupted run should cost
   * one recompute, not break the harness.
   *
   * Persistence failures are logged to stderr and swallowed for the
   * same reason `recordUsage` swallows Firestore failures — the cache
   * is an optimization, never a correctness dependency.
   */
  async run<T>(
    keyInput: CacheKeyInput,
    compute: (record: (usage: UsageRecord) => Promise<number>) => Promise<T>,
  ): Promise<CacheOutcome<T>> {
    const key = cacheKey(keyInput);
    const file = this.pathFor(keyInput, key);

    // `refresh` must ignore entries written by PREVIOUS runs, but it
    // must still reuse a key this run already recomputed. Codex P1:
    // without the second half, `--refresh-cache --full` on a 10×10
    // corpus re-extracts each resume once per JD and re-parses each
    // JD once per resume — 100 calls apiece instead of 10, defeating
    // the dedup this cache exists for. Worse, extraction is
    // non-deterministic, so the same resume yields different Units in
    // different cells while they all overwrite one key, making the
    // corpus internally inconsistent.
    const canRead =
      this.mode === "read-write" ||
      (this.mode === "refresh" && this.refreshedThisRun.has(key));
    if (canRead && existsSync(file)) {
      const cached = this.readEntry<T>(file);
      if (cached !== null) {
        this.hits += 1;
        return { value: cached.value, hit: true, usage: cached.usage, key };
      }
      // Corrupt entry — drop it so the rewrite below is clean.
      try {
        rmSync(file, { force: true });
      } catch {
        // Best-effort; the write path overwrites anyway.
      }
    }

    this.misses += 1;
    const collected: UsageRecord[] = [];
    const record = async (usage: UsageRecord): Promise<number> => {
      collected.push(usage);
      // Mirror production `recordUsage`'s contract: return the cost,
      // and never let a pricing failure (unknown model) throw into
      // the caller's pipeline.
      try {
        return priceFor(usage.model, usage);
      } catch {
        return 0;
      }
    };

    const value = await compute(record);

    if (this.mode !== "bypass") {
      // Mark BEFORE the write attempt would be wrong: a failed
      // persist must not make the next lookup believe a fresh entry
      // exists. `writeEntry` swallows its own errors, so gate on the
      // write counter instead.
      const writesBefore = this.writes;
      this.writeEntry(file, {
        schemaVersion: ENTRY_SCHEMA_VERSION,
        key,
        stage: keyInput.stage,
        provider: keyInput.provider,
        model: keyInput.model,
        promptVersion: keyInput.promptVersion,
        createdAt: new Date().toISOString(),
        value,
        usage: collected,
      });
      if (this.mode === "refresh" && this.writes > writesBefore) {
        this.refreshedThisRun.add(key);
      }
    }

    return { value, hit: false, usage: collected, key };
  }

  private readEntry<T>(file: string): StoredEntry<T> | null {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredEntry<T>;
      if (parsed.schemaVersion !== ENTRY_SCHEMA_VERSION) return null;
      if (!Array.isArray(parsed.usage)) return null;
      if (!("value" in parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeEntry<T>(file: string, entry: StoredEntry<T>): void {
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Write-then-rename so a crash mid-write can't leave a
      // half-parsed entry that the next run reads as valid.
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(entry), "utf8");
      renameSync(tmp, file);
      this.writes += 1;
    } catch (err) {
      process.stderr.write(
        `[eval-cache] persist failed for ${file}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }
}

/**
 * Sum `priceFor` across usage records. Shared by the actual-spend and
 * modeled-spend rollups so they can never drift apart.
 *
 * Unknown models contribute 0 rather than throwing — the harness must
 * not die because a swept model lacks a `rates.ts` entry, but the
 * sweep reports a warning so the gap is visible (see `sweep.ts`).
 */
export function sumUsageCost(usage: readonly UsageRecord[]): number {
  let total = 0;
  for (const u of usage) {
    try {
      total += priceFor(u.model, u);
    } catch {
      // Unknown model — see docstring.
    }
  }
  return total;
}

/**
 * Resolve the cache mode from CLI argv + sample count.
 *
 * Precedence (highest first):
 *   1. `--no-cache`   → bypass
 *   2. `samples > 1`  → bypass (variance measurement; see module docs)
 *   3. `--refresh-cache` → refresh
 *   4. default        → read-write
 *
 * Sampling outranks `--refresh-cache` deliberately: refresh still
 * writes, and writing N samples to the same key would leave whichever
 * sample finished last as the canonical entry.
 */
export function resolveCacheMode(
  argv: readonly string[],
  samples: number,
): StageCacheMode {
  if (argv.includes("--no-cache")) return "bypass";
  if (samples > 1) return "bypass";
  if (argv.includes("--refresh-cache")) return "refresh";
  return "read-write";
}
