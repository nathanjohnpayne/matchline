/**
 * Per-fixture orchestrator (#136).
 *
 *   resume.txt + jd.txt + expected-units.json + expected-matches.json
 *     → extractFromResume     (Anthropic, in-memory)
 *     → embedMany on Units    (OpenAI, in-memory)
 *     → parseJobRequirements  (Anthropic, in-memory)
 *     → embedMany on Reqs     (OpenAI, in-memory)
 *     → mapUnitIds            (runtime UUID → mnemonic)
 *     → mapRequirementIds     (runtime UUID → mnemonic)
 *     → runMatchingPipeline   (in-memory; no Firestore persist)
 *     → unitSetAccuracy       (extraction score)
 *     → topKOverlap           (match score)
 *     → FixtureResult
 *
 * No Firestore reads/writes — the matching pipeline's
 * `listUnits`, `listRequirements`, and `persistBatch` deps
 * are all overridden so the orchestrator runs purely
 * in-memory. This is the eval-side flow; production reads
 * from Firestore via the same pipeline with default deps.
 *
 * The orchestrator is dep-injectable: real Anthropic +
 * OpenAI clients in the production CLI run, mocked clients
 * in `runForFixture.test.ts`.
 */

import { createHash } from "node:crypto";

import { extractFromResume } from "../../functions/src/extraction/resume.ts";
import type { AnthropicClient as Anthropic } from "../../functions/src/llm/anthropic.ts";
import { EMBEDDING_MODEL, modelFor } from "../../functions/src/llm/config.ts";
import {
  priceFor,
  type UsageRecord,
} from "../../functions/src/llm/cost.ts";
import { embedMany } from "../../functions/src/llm/embeddings.ts";
import type { OpenAIClient as OpenAI } from "../../functions/src/llm/openai.ts";
import { runMatchingPipeline } from "../../functions/src/matching/pipeline.ts";
import { parseJobRequirements } from "../../functions/src/parsing/jd.ts";
import type { PromptName, PromptStage } from "../../functions/src/prompts/config.ts";
import { loadPromptText, resolvePromptVersion } from "../../functions/src/prompts/loader.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../functions/src/types/capability.ts";

import { StageCache, sumUsageCost, type CacheKeyInput } from "./cache.ts";
import {
  loadExpectedMatches,
  loadExpectedUnits,
  loadJdText,
  loadResumeText,
  type ExpectedMatchesFile,
  type ExpectedUnitFile,
  type FixturePaths,
} from "./loadFixtures.ts";
import { compositeIdsFromMatches, mapRequirementIds, mapUnitIds } from "./mapping.ts";
import { topKOverlap, unitSetAccuracy } from "./scoring.ts";

const EVAL_OWNER_UID = "eval-user";
const EVAL_ROLE_ID = "eval-role";

export interface RunForFixtureDeps {
  /** Anthropic client used by extraction + parsing. */
  readonly anthropicClient: Anthropic;
  /** OpenAI client used by embedding. */
  readonly openaiClient: OpenAI;
  /** Override fixture root for tests. */
  readonly fixturePaths?: FixturePaths;
  /**
   * Override the matching pipeline's persistBatch (defaults
   * to a no-op that just returns the input matches — see
   * pipeline.ts's persistBatch fallback). Tests may want to
   * inspect the call.
   */
  readonly persistBatch?: (
    ctx: { ownerUid: string; roleId: string },
    matches: readonly UnitMatch[],
  ) => Promise<readonly UnitMatch[] | void>;
  /**
   * Stage cache (#389). When omitted, every stage runs live and
   * nothing is persisted — the pre-#389 behavior, which the existing
   * `runForFixture.test.ts` mocks rely on.
   *
   * When supplied, extraction / JD parsing / embeddings are served
   * from `tests/eval/.cache/` on a key hit. Matching itself contains
   * no LLM call, so a warm cache makes matching-layer tuning (#177
   * workstream A, score weights, ontology) run offline at zero cost.
   */
  readonly cache?: StageCache;
}

export interface RunForFixtureInput {
  readonly resumeFixtureId: string;
  readonly jdFixtureId: string;
}

export interface RunForFixtureResult {
  readonly resumeFixtureId: string;
  readonly jdFixtureId: string;
  /** Extraction accuracy in [0, 1] from `unitSetAccuracy`. */
  readonly extractionAccuracy: number;
  /** Match accuracy in [0, 1] from `topKOverlap` against expected. */
  readonly matchAccuracy: number;
  /** End-to-end orchestration latency. */
  readonly latencyMs: number;
  /**
   * Total cost in USD across every LLM call in this
   * fixture's run (extraction + Unit embeddings + parsing
   * + Requirement embeddings). Computed via the pure
   * `priceFor` from `functions/src/llm/cost.ts` against
   * each call's token counts; the harness binds a
   * closure-scoped recorder to the pipeline deps so cost
   * accumulates without Firestore writes.
   *
   * cursor #139 r1 caught the prior shape (always null) —
   * a no-op recordUsage dropped the cost on the floor and
   * the harness couldn't surface real per-fixture spend.
   */
  readonly costUsd: number;
  /**
   * What this configuration costs to run **uncached**, in USD (#389).
   *
   * `costUsd` above is real new spend and drops to ~0 as the stage
   * cache warms — correct for the projection guard, useless for
   * ranking models. `modeledCostUsd` prices every stage's usage
   * records (replayed from cache on a hit) through the same
   * `priceFor` production uses, so the model sweep ranks on a number
   * that doesn't move with cache state.
   *
   * On a fully cold run the two are equal.
   */
  readonly modeledCostUsd: number;
  /** Stage-cache hits/misses for this fixture (#389). */
  readonly cacheHits: number;
  readonly cacheMisses: number;
  /** Counts for the report. */
  readonly extractedUnitCount: number;
  readonly parsedRequirementCount: number;
  readonly matchCount: number;
  /** True iff the harness completed without throwing. */
  readonly ok: boolean;
  /** Error message if the run threw (null on success). */
  readonly error: string | null;
}

/**
 * Run a single (resume × JD) eval. Returns the per-fixture
 * result the harness aggregates across the corpus. Always
 * returns — errors are captured into `error` rather than
 * propagated, so one bad fixture doesn't abort the corpus
 * run. Failed fixtures contribute 0 to the corpus mean
 * (intentional — bad fixtures should drag the score down,
 * not be silently skipped).
 */
export async function runForFixture(
  input: RunForFixtureInput,
  deps: RunForFixtureDeps,
): Promise<RunForFixtureResult> {
  const start = Date.now();
  // costAccum lives in the outer scope so partial cost
  // accumulation from successful API calls surfaces even
  // when a later step throws. CR Major #139 r2 caught the
  // prior shape where the failure path zeroed cost — that
  // hid real spend during flaky runs (e.g. transport
  // failure mid-parse after extraction tokens were already
  // billed).
  let costAccum = 0;
  const recordCost = async (usage: UsageRecord): Promise<number> => {
    let cost = 0;
    try {
      cost = priceFor(usage.model, usage);
    } catch {
      // Same fallback as production `recordUsage`: pricing
      // failures (unknown model) → 0 contribution. Don't
      // throw — fixture eval shouldn't fail because of an
      // unfamiliar model name.
      cost = 0;
    }
    costAccum += cost;
    return cost;
  };

  // Modeled cost accumulates the usage of EVERY stage — live or
  // replayed from the cache — so it stays stable as the cache warms
  // (#389). `costAccum` above only counts stages that actually
  // burned tokens this run.
  const modeledUsage: UsageRecord[] = [];
  const tally: StageTally = {
    modeledUsage,
    hits: 0,
    misses: 0,
  };

  try {
    return await runForFixtureInner(
      input,
      deps,
      start,
      recordCost,
      () => costAccum,
      tally,
    );
  } catch (err) {
    return {
      resumeFixtureId: input.resumeFixtureId,
      jdFixtureId: input.jdFixtureId,
      extractionAccuracy: 0,
      matchAccuracy: 0,
      latencyMs: Date.now() - start,
      // Partial cost is REAL — earlier API calls consumed
      // real tokens before the throw. Surfacing 0 would
      // hide spend during flaky runs.
      costUsd: costAccum,
      modeledCostUsd: sumUsageCost(modeledUsage),
      cacheHits: tally.hits,
      cacheMisses: tally.misses,
      extractedUnitCount: 0,
      parsedRequirementCount: 0,
      matchCount: 0,
      ok: false,
      error: describeError(err),
    };
  }
}

/**
 * Cache-key component for a prompt: its resolved version PLUS a hash
 * of the actual prompt text.
 *
 * Codex P1 round 3: keying on the version string alone meant editing
 * a prompt file **in place** — which is exactly what prompt tuning
 * does, and what #177 workstream B is — left the key unchanged. The
 * cache then served extraction produced by the PREVIOUS prompt while
 * the report claimed to be evaluating the new one, so a tuning session
 * would draw conclusions from stale output and never notice.
 * `STAGE_IMPL_VERSION` does not help: it covers TypeScript changes,
 * not Markdown edits.
 *
 * Hashing `system` + `userFewShot` — the two sections the loader
 * actually feeds the model — means any edit that can change output
 * changes the key, and edits to the file's commentary preamble (which
 * the loader discards) correctly do not.
 */
export function promptFingerprint<S extends PromptStage, N extends PromptName<S>>(
  stage: S,
  name: N,
): string {
  const version = resolvePromptVersion(stage, name);
  const prompt = loadPromptText(stage, name);
  const hash = createHash("sha256")
    .update(prompt.system)
    .update("\u0000")
    .update(prompt.userFewShot)
    .digest("hex")
    .slice(0, 16);
  return `${version}:${hash}`;
}

/**
 * Render a pipeline error into something an operator can act on.
 *
 * `ExtractionError` / `JdParsingError` summarize as "failed after 3
 * attempts. See .failures for per-attempt detail" — which is useless
 * in a report, because `.failures` is exactly where the actual cause
 * lives. This appends the first attempt's message.
 *
 * It matters most for the credential-free offline path (#389): a cache
 * miss there surfaces as a retry-loop failure, and without this the
 * operator sees "Extraction failed after 3 attempts" with no hint that
 * the real cause is a cold cache entry and an unset API key.
 *
 * Duck-typed on the `failures` array rather than importing the error
 * classes, so it degrades gracefully for any pipeline that adopts the
 * same shape.
 */
export function describeError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  // Codex P2: `null` and `undefined` are legal throw values, and a
  // bare property access on either raises a fresh TypeError — which
  // would escape `runForFixture`'s catch and abort the whole corpus,
  // breaking its documented always-return contract. Narrow first.
  if (typeof err !== "object" || err === null) return base;
  const failures = (err as { failures?: unknown }).failures;
  if (!Array.isArray(failures) || failures.length === 0) return base;
  const first = failures[0] as { kind?: unknown; message?: unknown };
  if (typeof first?.message !== "string") return base;
  const kind = typeof first.kind === "string" ? `${first.kind}: ` : "";
  return `${base} First attempt — ${kind}${first.message}`;
}

/**
 * Mutable per-fixture rollup threaded into the inner orchestrator.
 * Lives in the outer scope so a mid-run throw still surfaces the
 * cache stats and modeled cost accumulated up to that point — same
 * rationale as `costAccum` (CR Major #139 r2).
 */
interface StageTally {
  readonly modeledUsage: UsageRecord[];
  hits: number;
  misses: number;
}

/**
 * Run one LLM stage through the cache when one is supplied, or live
 * when it isn't.
 *
 * Both paths feed `tally.modeledUsage`, so `modeledCostUsd` is
 * identical whether the value came from cache or the wire — that
 * equality is what makes the sweep's cost ranking cache-independent,
 * and `cache.test.ts` pins it.
 *
 * The no-cache path is the pre-#389 behavior and is what the existing
 * `runForFixture.test.ts` mocks exercise.
 */
async function runStage<T>(
  tally: StageTally,
  cache: StageCache | undefined,
  keyInput: CacheKeyInput,
  liveRecord: (usage: UsageRecord) => Promise<number>,
  compute: (record: (usage: UsageRecord) => Promise<number>) => Promise<T>,
): Promise<T> {
  if (cache === undefined) {
    // No cache: the live recorder both prices into `costAccum` and
    // needs to land in `modeledUsage`. Wrap it.
    return compute(async (usage) => {
      tally.modeledUsage.push(usage);
      return liveRecord(usage);
    });
  }

  // Codex P2 round 1: modeled usage used to be copied out of
  // `outcome.usage` only AFTER `cache.run` resolved. If a stage
  // recorded a billed response and then threw — repeated
  // schema-invalid LLM responses, an embedding-count mismatch — the
  // rejection skipped that copy, so the failure result reported zero
  // modeled cost and no cache miss for a stage that had really
  // spent tokens. `costUsd` still counted it, so the two diverged
  // and sweep comparisons underpriced partially-failing variants.
  //
  // Recording into `tally` as each usage arrives makes the miss path
  // throw-safe. The hit path can't double-count because `compute` is
  // never invoked on a hit — its usage is appended from
  // `outcome.usage` below instead.
  try {
    const outcome = await cache.run(
      keyInput,
      // On a miss the cache hands us its own collector; chain the live
      // recorder so real spend still lands in `costAccum`.
      (cacheRecord) =>
        compute(async (usage) => {
          tally.modeledUsage.push(usage);
          await cacheRecord(usage);
          return liveRecord(usage);
        }),
    );

    if (outcome.hit) {
      tally.hits += 1;
      tally.modeledUsage.push(...outcome.usage);
    } else {
      tally.misses += 1;
    }
    return outcome.value;
  } catch (err) {
    // Count the attempt so a failed stage still shows as a miss
    // rather than vanishing from the cache tally.
    tally.misses += 1;
    throw err;
  }
}

async function runForFixtureInner(
  input: RunForFixtureInput,
  deps: RunForFixtureDeps,
  start: number,
  recordCost: (usage: UsageRecord) => Promise<number>,
  getCostAccum: () => number,
  tally: StageTally,
): Promise<RunForFixtureResult> {
  const { cache } = deps;
  const extractionModel = modelFor("extraction");
  const parsingModel = modelFor("requirement_parsing");
  // 1. Load fixtures.
  const resumeText = loadResumeText(input.resumeFixtureId, deps.fixturePaths);
  const jdText = loadJdText(input.jdFixtureId, deps.fixturePaths);
  const expectedUnitsFile: ExpectedUnitFile = loadExpectedUnits(
    input.resumeFixtureId,
    deps.fixturePaths,
  );
  const expectedMatchesFile: ExpectedMatchesFile = loadExpectedMatches(
    input.resumeFixtureId,
    input.jdFixtureId,
    deps.fixturePaths,
  );

  // 2. Extract Units (Anthropic). Keyed on the resume text — the
  //    only input that can change the output — so the 10×10 corpus
  //    runs 10 extractions instead of 100 (#389).
  const extractedUnits = await runStage(
    tally,
    cache,
    {
      stage: "extraction",
      provider: extractionModel.provider,
      model: extractionModel.model,
      promptVersion: promptFingerprint("extraction", "resume"),
      input: resumeText,
    },
    recordCost,
    (record) =>
      extractFromResume(
        resumeText,
        { ownerUid: EVAL_OWNER_UID },
        { client: deps.anthropicClient, record },
      ),
  );

  // 3. Embed Units (OpenAI). Attach embedding to each Unit
  //    in-place so the matching pipeline's filter for
  //    !reembed_pending sees populated embeddings.
  //
  //    Embeddings are nearly free ($0.02/1M tokens) so this cache
  //    entry isn't about money — it's what lets a matching-only
  //    re-run complete with zero network calls (#389 acceptance).
  const unitTexts = extractedUnits.map((u) => u.normalized_summary);
  const unitEmbeddings = await runStage(
    tally,
    cache,
    {
      stage: "embedding",
      provider: "openai",
      model: EMBEDDING_MODEL,
      promptVersion: "n/a",
      // Codex P2: a delimiter join is NOT collision-free here. Both
      // extraction schemas accept any non-empty string, U+0000
      // included, so ["a\u0000b", "c"] and ["a", "b\u0000c"] produced
      // the same key while needing different embedding batches — one
      // fixture could receive another batch's vectors and silently
      // corrupt every matching score downstream. Serialize
      // structurally instead of relying on an unenforced restriction.
      input: JSON.stringify(unitTexts),
    },
    recordCost,
    (record) =>
      embedMany(unitTexts, {
        client: deps.openaiClient,
        record,
        ownerUid: EVAL_OWNER_UID,
      }),
  );
  const embeddedUnits: ExperienceUnit[] = extractedUnits.map((u, idx) => ({
    ...u,
    embedding: unitEmbeddings[idx],
  }));

  // 4. Parse Requirements (Anthropic). Keyed on the JD text, so
  //    changing the extraction prompt leaves these entries warm.
  const parsedRequirements = await runStage(
    tally,
    cache,
    {
      stage: "requirement_parsing",
      provider: parsingModel.provider,
      model: parsingModel.model,
      promptVersion: promptFingerprint("parsing", "jd"),
      input: jdText,
    },
    recordCost,
    (record) =>
      parseJobRequirements(
        jdText,
        { ownerUid: EVAL_OWNER_UID, roleId: EVAL_ROLE_ID },
        { client: deps.anthropicClient, record },
      ),
  );

  // 5. Embed Requirements (OpenAI).
  const reqTexts = parsedRequirements.map((r) => r.normalized_requirement);
  const reqEmbeddings = await runStage(
    tally,
    cache,
    {
      stage: "embedding",
      provider: "openai",
      model: EMBEDDING_MODEL,
      promptVersion: "n/a",
      input: JSON.stringify(reqTexts),
    },
    recordCost,
    (record) =>
      embedMany(reqTexts, {
        client: deps.openaiClient,
        record,
        ownerUid: EVAL_OWNER_UID,
      }),
  );
  const embeddedReqs: JobRequirementUnit[] = parsedRequirements.map((r, idx) => ({
    ...r,
    embedding: reqEmbeddings[idx],
  }));

  // 6. Run matching with in-memory deps (no Firestore).
  const matches = await runMatchingPipeline(
    { ownerUid: EVAL_OWNER_UID, roleId: EVAL_ROLE_ID },
    {
      listUnits: async () => embeddedUnits,
      listRequirements: async () => embeddedReqs,
      persistBatch: deps.persistBatch ?? (async (_ctx, m) => m),
    },
  );

  // 7. Score extraction. unitSetAccuracy uses
  //    `normalizedSummary` + `skills`; convert our shapes.
  const extractionAccuracy = unitSetAccuracy(
    expectedUnitsFile.expected_units.map((e) => ({
      normalizedSummary: e.normalized_summary,
      skills: e.skills,
    })),
    embeddedUnits.map((u) => ({
      normalizedSummary: u.normalized_summary,
      skills: u.skills,
    })),
  );

  // 8. Score matches. Build mnemonic-ID maps; convert
  //    actual matches to composite strings; topKOverlap.
  // expected_requirements is required by the loader
  // (cursor #139 r1) so we don't have to fall back here.
  const unitMap = mapUnitIds(expectedUnitsFile.expected_units, embeddedUnits);
  const reqMap = mapRequirementIds(
    expectedMatchesFile.expected_requirements,
    embeddedReqs,
  );
  const actualComposite = compositeIdsFromMatches(matches, unitMap, reqMap);
  const matchAccuracy = topKOverlap(
    expectedMatchesFile.expected_top_matches,
    actualComposite,
    expectedMatchesFile.k,
  );

  return {
    resumeFixtureId: input.resumeFixtureId,
    jdFixtureId: input.jdFixtureId,
    extractionAccuracy,
    matchAccuracy,
    latencyMs: Date.now() - start,
    costUsd: getCostAccum(),
    modeledCostUsd: sumUsageCost(tally.modeledUsage),
    cacheHits: tally.hits,
    cacheMisses: tally.misses,
    extractedUnitCount: embeddedUnits.length,
    parsedRequirementCount: embeddedReqs.length,
    matchCount: matches.length,
    ok: true,
    error: null,
  };
}
