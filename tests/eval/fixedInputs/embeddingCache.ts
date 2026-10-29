/**
 * Per-text embedding cache for `eval:fixed-inputs` (#648).
 *
 * An append-only JSONL file outside the repository. Each line is one
 * vector:
 *
 *   {"v":1,"model":"text-embedding-3-small","sha256":"<hex>","dims":1536,"vector":[...]}
 *
 * keyed by (model, sha256 of the UTF-8 text). The text itself is not
 * stored. The same text across flows, arms and runs is embedded once, so
 * a repeated run re-spends nothing and a changed correction re-embeds
 * only the texts that changed.
 *
 * On a duplicate key the FIRST line wins: the embeddings API returns
 * slightly different vectors for the same text in different batches,
 * and first-wins is what reproduces a seeded run exactly.
 *
 * `fill` embeds the uncached texts with the production `embedMany`, in
 * chunks, appending each chunk's vectors as soon as it returns so an
 * interrupted run keeps what it paid for. Before each chunk it refuses
 * when the spend so far plus that chunk's bound would pass `maxUsd`.
 * `load` accepts a file whose last line has no trailing newline (a
 * seeded cache, say), so an append to a non-empty file that does not end
 * in `\n` writes one first; otherwise the first new entry would join the
 * last line and every later load would refuse the file.
 *
 * The guard prices tokens at the UTF-8 byte length of each text
 * (`embeddingTokenBound`), a strict upper bound for a byte-level BPE:
 * every token covers at least one byte. The chars/4 × 1.35 estimate
 * (`estimateEmbeddingTokens`) is closer to the bill for English prose
 * but is not a bound for CJK, emoji or digit runs, so it is displayed
 * only.
 *
 * Usage is priced with `priceUsage` and never written to Firestore. When
 * the served usage cannot be priced (no rate card for the model string),
 * the request is charged at the larger of its served tokens at the
 * embedding rate and the chunk's bound, with a warning, so the spend the
 * guard accumulates never drops below the bound it checked.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { EMBEDDING_MODEL } from "../../../functions/src/llm/config.ts";
import { priceFor, priceUsage, type UsageRecord } from "../../../functions/src/llm/cost.ts";
import { embedMany } from "../../../functions/src/llm/embeddings.ts";
import type { OpenAIClient as OpenAI } from "../../../functions/src/llm/openai.ts";

import { assertRecordDirOutsideRepo } from "../recorder.ts";
import { INPUT_ESTIMATE_FACTOR } from "../subtasks/budget.ts";
import { estimateTokens } from "../tokenSource.ts";

export const EMBEDDING_CACHE_VERSION = 1;
/** Inputs per `embeddings.create` request (the API allows 2048). */
export const EMBED_CHUNK_SIZE = 256;

export function defaultEmbeddingCachePath(): string {
  return join(homedir(), ".matchline", "eval-embeddings", "embeddings.jsonl");
}

export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Displayed token estimate for one embedding input (chars/4 × 1.35). NOT
 * an upper bound: a CJK character, an emoji or a run of digits can take
 * a token or more per character. The spend guard uses
 * `embeddingTokenBound`.
 */
export function estimateEmbeddingTokens(text: string): number {
  return Math.ceil(INPUT_ESTIMATE_FACTOR * estimateTokens(text));
}

/**
 * Upper bound on the tokens one embedding input can bill: its UTF-8 byte
 * length. `text-embedding-3-small` tokenizes with a byte-level BPE
 * (cl100k_base), in which every token covers at least one byte, so no
 * text can bill more tokens than it has bytes.
 */
export function embeddingTokenBound(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function priceEmbeddingTokens(tokens: number, model: string = EMBEDDING_MODEL): number {
  return priceFor(model, { inputTokens: tokens, outputTokens: 0 });
}

/** A run refused before (or between) requests: over budget or without a key. */
export class EmbeddingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingRefusal";
  }
}

export interface EmbeddingPlan {
  readonly model: string;
  /** Distinct texts the run embeds. */
  readonly uniqueTexts: number;
  readonly cachedTexts: number;
  /** Distinct texts not in the cache, in first-seen order. */
  readonly uncached: readonly string[];
  /** Estimated input tokens for the uncached texts (chars/4 × 1.35; displayed, not a bound). */
  readonly estimatedTokens: number;
  readonly estimatedUsd: number;
  /** Upper bound on their input tokens (UTF-8 bytes): what the spend guard checks. */
  readonly boundTokens: number;
  readonly boundUsd: number;
}

export interface FillResult {
  readonly requests: number;
  readonly embedded: number;
  readonly inputTokens: number;
  readonly usd: number;
}

interface CacheLine {
  readonly v: number;
  readonly model: string;
  readonly sha256: string;
  readonly dims: number;
  readonly vector: readonly number[];
}

function parseLine(raw: unknown, where: string): CacheLine {
  if (typeof raw !== "object" || raw === null) throw new Error(`${where}: not a cache entry`);
  const r = raw as Record<string, unknown>;
  if (r.v !== EMBEDDING_CACHE_VERSION) throw new Error(`${where}: unsupported cache version ${String(r.v)}`);
  if (typeof r.model !== "string" || r.model === "") throw new Error(`${where}: missing model`);
  if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(r.sha256)) throw new Error(`${where}: bad sha256`);
  if (typeof r.dims !== "number" || !Number.isInteger(r.dims) || r.dims <= 0) throw new Error(`${where}: bad dims`);
  if (!Array.isArray(r.vector) || !r.vector.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error(`${where}: vector is not an array of finite numbers`);
  }
  if (r.vector.length !== r.dims) {
    throw new Error(`${where}: dims ${r.dims} disagrees with a vector of length ${r.vector.length}`);
  }
  return { v: r.v, model: r.model, sha256: r.sha256, dims: r.dims, vector: r.vector as number[] };
}

/** Whether `path` is a non-empty file whose last byte is not `\n` (so an append must start a new line). */
function lacksFinalNewline(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

export class EmbeddingCache {
  readonly path: string;
  readonly model: string;
  private readonly vectors = new Map<string, readonly number[]>();

  private constructor(path: string, model: string) {
    this.path = path;
    this.model = model;
  }

  /**
   * Load (or start) the cache at `path`. Refuses a path inside the
   * repository, its main checkout or any of its worktrees. A missing
   * file is an empty cache; a malformed line throws with `<path>:<line>`.
   */
  static load(path: string, options: { readonly model?: string; readonly root?: string } = {}): EmbeddingCache {
    assertRecordDirOutsideRepo(path, "--embeddings-cache", options.root);
    const abs = resolve(path);
    const cache = new EmbeddingCache(abs, options.model ?? EMBEDDING_MODEL);
    if (!existsSync(abs)) return cache;
    const lines = readFileSync(abs, "utf8").split(/\r?\n/u);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (err) {
        throw new Error(`${abs}:${i + 1}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
      }
      const entry = parseLine(raw, `${abs}:${i + 1}`);
      const key = `${entry.model}\u0000${entry.sha256}`;
      if (!cache.vectors.has(key)) cache.vectors.set(key, entry.vector);
    }
    return cache;
  }

  /** Number of entries for every model. */
  get size(): number {
    return this.vectors.size;
  }

  private key(text: string): string {
    return `${this.model}\u0000${textHash(text)}`;
  }

  get(text: string): readonly number[] | undefined {
    return this.vectors.get(this.key(text));
  }

  has(text: string): boolean {
    return this.vectors.has(this.key(text));
  }

  /** What embedding `texts` would cost: distinct, cached, uncached, estimated and bounded tokens and USD. */
  plan(texts: readonly string[]): EmbeddingPlan {
    const unique = [...new Set(texts)];
    const uncached = unique.filter((t) => !this.has(t));
    const estimatedTokens = uncached.reduce((a, t) => a + estimateEmbeddingTokens(t), 0);
    const boundTokens = uncached.reduce((a, t) => a + embeddingTokenBound(t), 0);
    return {
      model: this.model,
      uniqueTexts: unique.length,
      cachedTexts: unique.length - uncached.length,
      uncached,
      estimatedTokens,
      estimatedUsd: priceEmbeddingTokens(estimatedTokens, this.model),
      boundTokens,
      boundUsd: priceEmbeddingTokens(boundTokens, this.model),
    };
  }

  /**
   * Embed every uncached text in `texts` with `embedMany` and append the
   * vectors. Refuses (EmbeddingRefusal) before a chunk whose byte-length
   * bound would take the run's spend past `maxUsd`.
   */
  async fill(
    texts: readonly string[],
    options: {
      readonly client: OpenAI;
      readonly maxUsd: number;
      readonly chunkSize?: number;
      /** Prices a served usage record; defaults to `priceUsage` (tests inject a failing one). */
      readonly priceUsage?: (usage: UsageRecord) => number;
      /** Receives pricing-fallback warnings; defaults to stderr. */
      readonly warn?: (message: string) => void;
    },
  ): Promise<FillResult> {
    if (this.model !== EMBEDDING_MODEL) {
      throw new Error(`embedMany embeds with ${EMBEDDING_MODEL}; this cache is keyed for ${this.model}`);
    }
    const uncached = this.plan(texts).uncached;
    const chunkSize = options.chunkSize ?? EMBED_CHUNK_SIZE;
    let usd = 0;
    let inputTokens = 0;
    let requests = 0;
    let embedded = 0;
    const price = options.priceUsage ?? ((usage: UsageRecord): number => priceUsage(usage).costUsd);
    const warn = options.warn ?? ((message: string): void => void process.stderr.write(`${message}\n`));
    let chunkBound = 0;
    const record = async (usage: UsageRecord): Promise<number> => {
      let cost: number;
      try {
        cost = price(usage);
      } catch (err) {
        // Never count a billed request as free: the guard's running total
        // must not fall below the bound it checked for this chunk.
        cost = Math.max(priceEmbeddingTokens(usage.inputTokens, this.model), chunkBound);
        warn(
          `warning: could not price embedding usage for ${usage.servedModel ?? usage.model} ` +
            `(${err instanceof Error ? err.message : String(err)}); counting $${cost.toFixed(6)} ` +
            `(the larger of ${usage.inputTokens} served tokens at the ${this.model} rate and the chunk's byte-length bound).`,
        );
      }
      usd += cost;
      inputTokens += usage.inputTokens;
      return cost;
    };
    for (let start = 0; start < uncached.length; start += chunkSize) {
      const chunk = uncached.slice(start, start + chunkSize);
      chunkBound = priceEmbeddingTokens(
        chunk.reduce((a, t) => a + embeddingTokenBound(t), 0),
        this.model,
      );
      if (usd + chunkBound > options.maxUsd) {
        throw new EmbeddingRefusal(
          `Refusing the next embedding request: $${usd.toFixed(6)} spent so far plus at most ` +
            `$${chunkBound.toFixed(6)} (UTF-8 bytes as tokens) would pass --max-usd $${options.maxUsd}. ` +
            `${embedded} of ${uncached.length} texts were embedded and cached.`,
        );
      }
      requests += 1;
      const vectors = await embedMany([...chunk], { client: options.client, record, ownerUid: "eval-user" });
      const lines: string[] = [];
      chunk.forEach((text, i) => {
        const vector = vectors[i]!;
        const sha256 = textHash(text);
        this.vectors.set(`${this.model}\u0000${sha256}`, vector);
        const entry: CacheLine = { v: EMBEDDING_CACHE_VERSION, model: this.model, sha256, dims: vector.length, vector };
        lines.push(JSON.stringify(entry));
      });
      mkdirSync(dirname(this.path), { recursive: true });
      const separator = lacksFinalNewline(this.path) ? "\n" : "";
      appendFileSync(this.path, `${separator}${lines.join("\n")}\n`, "utf8");
      embedded += chunk.length;
    }
    return { requests, embedded, inputTokens, usd };
  }
}

/** Write vectors for `texts` as cache lines (first-wins on load), e.g. to seed a cache from saved vectors. */
export function cacheLinesFor(
  entries: readonly { readonly text: string; readonly vector: readonly number[] }[],
  model: string = EMBEDDING_MODEL,
): string {
  return entries
    .map(({ text, vector }) =>
      JSON.stringify({ v: EMBEDDING_CACHE_VERSION, model, sha256: textHash(text), dims: vector.length, vector }),
    )
    .map((l) => `${l}\n`)
    .join("");
}
