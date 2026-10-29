/**
 * LLM cost accounting. Every LLM call logs tokens and computed USD cost
 * to the `llm_calls` Firestore collection; readers aggregate per-month
 * and per-application to enforce the per-flow and monthly budget caps
 * defined in specs/matchline.md § Execution targets.
 *
 * The pure `priceFor` is trivially testable and used by both the
 * per-call `recordUsage` path and any projection guard that wants to
 * pre-compute a spend estimate without hitting Firestore.
 *
 * **Every figure here is a list-price estimate, not an invoice.** It
 * prices the token counts the provider reported against `rates.ts`; it
 * does not see credits, discounts or billing adjustments. The eval
 * harness's subscription-CLI token sources report a third kind of
 * number — modeled cost for tokens that were never metered — and label
 * it as such (tests/eval/README.md § Token sources).
 */

import type Anthropic from "@anthropic-ai/sdk";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { getAdminDb } from "../firestore/admin.js";
import { rateFor, RATES, type RateCard } from "./rates.js";

export const LLM_CALLS_COLLECTION = "llm_calls";

/**
 * Version of the `llm_calls` document shape. Docs written before this
 * field existed are version 1 and stay as written — they are never
 * backfilled or re-priced.
 */
export const USAGE_SCHEMA_VERSION = 2;

export interface TokenCounts {
  /** Uncached input tokens. */
  readonly inputTokens: number;
  /**
   * Output tokens. On Anthropic this already includes any thinking
   * tokens; the API reports no separate reasoning count, so none is
   * recorded (adding one would double count).
   */
  readonly outputTokens: number;
  /**
   * Prompt-cache writes. `undefined` means the provider did not report
   * the field, which is not the same as a reported `0`.
   */
  readonly cacheCreationInputTokens?: number;
  /** Prompt-cache reads. `undefined` = not reported, as above. */
  readonly cacheReadInputTokens?: number;
}

export interface UsageRecord extends TokenCounts {
  /** Pipeline stage the call served (e.g. "extraction", "generation"). */
  readonly stage: string;

  /**
   * Finer task within `stage`, where one stage makes several kinds of
   * call — validation's "claim_extraction" / "traceability" /
   * "specificity".
   */
  readonly subtask?: string;

  /** Requested model identifier — what config or a sweep variant asked for. */
  readonly model: string;

  /**
   * Model the provider reports having served (`response.model`). Can
   * differ from `model` when an alias resolves to a snapshot. Pricing
   * uses it when it has a rate — see `priceUsage`.
   */
  readonly servedModel?: string;

  /** Provider side, "anthropic" | "openai" — split for per-vendor alarms. */
  readonly provider: "anthropic" | "openai";

  /** Wall-clock latency of the call. Used by the eval harness. */
  readonly latencyMs: number;

  /** Prompt that built the request, as `<stage>/<name>.<version>`. */
  readonly promptVersion?: string;

  /** 0-based attempt within the caller's retry loop. */
  readonly attempt?: number;

  /** `max_tokens` the request was sent with. */
  readonly maxTokens?: number;

  /** `output_config.effort` the request was sent with, when any. */
  readonly effort?: string;

  /**
   * Tolerant pre-parse the stage applied to the model's output before
   * validating it, when it applied one: extraction's `"units-string"`
   * (#650). Absent when the output was validated as returned.
   */
  readonly recovered?: string;

  /** Eval-harness run that made the call, when there is one. */
  readonly runId?: string;

  /** Optional — the user whose flow originated the call. */
  readonly ownerUid?: string;

  /** Optional — the Application being generated, if any. */
  readonly applicationId?: string;
}

export interface LlmCallDoc extends UsageRecord {
  readonly usageSchemaVersion: number;
  /**
   * `"unpriced"` when no rate could price the call. `costUsd` is then
   * absent rather than `0`, so an unknown cost never reads as free.
   */
  readonly costStatus: "priced" | "unpriced";
  readonly costUsd?: number;
  /** Model whose rate produced `costUsd`. */
  readonly pricedModel?: string;
  readonly createdAt: FirebaseFirestore.FieldValue;
}

function assertTokenCount(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Token counts must be finite, non-negative numbers (got ${name}=${value}).`,
    );
  }
}

/** Every token the prompt carried: uncached input plus cache traffic. */
function promptTokens(tokens: TokenCounts): number {
  return (
    tokens.inputTokens +
    (tokens.cacheCreationInputTokens ?? 0) +
    (tokens.cacheReadInputTokens ?? 0)
  );
}

/**
 * Pure price calculator. No I/O. Reused by the eval-harness projection
 * guard (#48) to pre-compute run cost without burning Firestore reads.
 *
 * Throws on unknown models (via `rateFor`), on invalid token counts
 * (negative, `NaN`, `Infinity`), and on cache tokens for a model with
 * no cache rate, so bad inputs can never silently persist as a $0 cost
 * and corrupt downstream budget math.
 */
export function priceFor(model: string, tokens: TokenCounts): number {
  assertTokenCount("input", tokens.inputTokens);
  assertTokenCount("output", tokens.outputTokens);
  assertTokenCount("cacheCreationInput", tokens.cacheCreationInputTokens);
  assertTokenCount("cacheReadInput", tokens.cacheReadInputTokens);

  const rate = rateFor(model);
  // A request over the long-prompt threshold is priced entirely on the
  // long card, cache hits included.
  const card: RateCard =
    rate.longPrompt && promptTokens(tokens) > rate.longPrompt.thresholdTokens
      ? rate.longPrompt.rate
      : rate;

  const cacheWrite = tokens.cacheCreationInputTokens ?? 0;
  const cacheRead = tokens.cacheReadInputTokens ?? 0;
  if (cacheWrite > 0 && card.cacheWriteUsdPer1k === undefined) {
    throw new Error(`No cache-write rate registered for model: ${model}.`);
  }
  if (cacheRead > 0 && card.cacheReadUsdPer1k === undefined) {
    throw new Error(`No cache-read rate registered for model: ${model}.`);
  }

  return (
    (tokens.inputTokens / 1000) * card.inputUsdPer1k +
    (tokens.outputTokens / 1000) * card.outputUsdPer1k +
    (cacheWrite / 1000) * (card.cacheWriteUsdPer1k ?? 0) +
    (cacheRead / 1000) * (card.cacheReadUsdPer1k ?? 0)
  );
}

/**
 * The model whose rate prices a call: the served model when it has a
 * rate, otherwise the requested one. A served model with no rate is
 * logged (it means rates.ts is missing a snapshot) but does not drop
 * the call's cost, as long as the requested model can price it.
 */
export function pricedModelFor(usage: Pick<UsageRecord, "model" | "servedModel">): string {
  const { model, servedModel } = usage;
  if (servedModel === undefined || servedModel === model) return model;
  if (Object.hasOwn(RATES, servedModel)) return servedModel;
  logger.warn("cost.pricedModelFor: served model has no rate; pricing the requested model", {
    model,
    servedModel,
  });
  return model;
}

/**
 * Price one usage record on the model `pricedModelFor` picks. Throws
 * like `priceFor` when that model has no rate.
 */
export function priceUsage(usage: UsageRecord): { costUsd: number; pricedModel: string } {
  const pricedModel = pricedModelFor(usage);
  return { costUsd: priceFor(pricedModel, usage), pricedModel };
}

/**
 * Token categories and served model off an Anthropic response, for
 * spreading into a `UsageRecord`. Cache fields the API returned as
 * `null` stay `undefined` (not reported), never `0`.
 */
export function anthropicUsageFields(
  response: Pick<Anthropic.Messages.Message, "model" | "usage">,
): Pick<
  UsageRecord,
  "inputTokens" | "outputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens" | "servedModel"
> {
  const { usage } = response;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof usage.cache_creation_input_tokens === "number" && {
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
    }),
    ...(typeof usage.cache_read_input_tokens === "number" && {
      cacheReadInputTokens: usage.cache_read_input_tokens,
    }),
    ...(typeof response.model === "string" && { servedModel: response.model }),
  };
}

/**
 * Wrap a `recordUsage`-shaped call with the consolidated try/catch
 * + `logger.warn` shape every LLM pipeline module previously had to
 * hand-roll. Centralizing it here keeps the redaction contract
 * (no `ownerUid` in log payloads, no PII widening) and the
 * "telemetry never blocks the caller" invariant in one place — a
 * future change to that contract only needs to land in one module
 * instead of six (CodeRabbit Nitpick on PR #118).
 *
 * Pipelines should call
 * `safeRecordUsage(record, () => ({...usage...}), "<stage.module>")`
 * instead of inlining `try { await record(...) } catch (err) { logger.warn(...) }`.
 * The `stageLabel` is a free-form string used only in the warn log
 * (e.g. `"validation.traceability"`, `"extraction.resume"`) so
 * grep-by-pipeline still works across log output.
 *
 * **Why a thunk and not a `UsageRecord` value.** Codex P2 on PR #220
 * caught a real regression: the prior signature evaluated
 * `response.usage.input_tokens` (and friends) at the call site —
 * BEFORE the helper entered its try/catch. Function arguments are
 * evaluated eagerly, so a malformed `response.usage` would throw
 * past the helper and break the "telemetry must never block a
 * successful verdict" contract that the inline pattern preserved.
 * Accepting a `() => UsageRecord` thunk defers the construction
 * into the protected try block, restoring the original semantics.
 *
 * Returns the propagated cost from `record` on success, or `0` if
 * either the thunk OR `record` threw. The return value is rarely
 * consumed by these pipelines (callers use it only for footer-cost
 * display, where `0` on a failed telemetry write is the correct
 * "unknown" answer).
 */
export async function safeRecordUsage(
  record: (usage: UsageRecord) => Promise<number>,
  buildUsage: () => UsageRecord,
  stageLabel: string,
): Promise<number> {
  let stageForLog: string | undefined;
  let modelForLog: string | undefined;
  try {
    const usage = buildUsage();
    stageForLog = usage.stage;
    modelForLog = usage.model;
    return await record(usage);
  } catch (err) {
    // `ownerUid` intentionally omitted from the log payload —
    // matches the redaction shape `cost.ts` already uses on its
    // own internal failure paths so logs don't widen PII exposure
    // for an observability-only failure path. CodeRabbit Major on
    // PR #116.
    //
    // `stage`/`model` log fields default to `<unknown>` because the
    // thunk itself may have thrown before populating them (e.g.,
    // a malformed `response.usage`). Better to surface the failure
    // with placeholders than to drop the log.
    logger.warn(`${stageLabel}: recordUsage failed (non-fatal)`, {
      stage: stageForLog ?? "<unknown>",
      model: modelForLog ?? "<unknown>",
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Compute the dollar cost for one LLM call and persist a `llm_calls`
 * doc fire-and-forget — the caller never waits for the Firestore
 * write, and neither pricing failures nor Firestore failures throw.
 *
 * The "telemetry must not kill caller flow" contract applies to BOTH
 * failure modes: a malformed token count (rejected by `priceFor`) OR
 * a flaky Firestore write is logged and swallowed. Cost telemetry is
 * a reporting concern, not a correctness one.
 *
 * The returned value lets the caller surface per-call cost on the
 * Application (Phase 2a Editor footer) without a round-trip read.
 * Returns `0` when pricing itself fails. That failure is logged at
 * error level and the call is still persisted, with
 * `costStatus: "unpriced"` and no `costUsd`, so its tokens are kept
 * and the gap is visible in the data rather than recorded as free.
 */
export async function recordUsage(usage: UsageRecord): Promise<number> {
  // Malformed token counts are dropped, not persisted: they would
  // poison every rollup that sums them. Only a missing rate takes the
  // persist-as-unpriced path below.
  try {
    assertTokenCount("input", usage.inputTokens);
    assertTokenCount("output", usage.outputTokens);
    assertTokenCount("cacheCreationInput", usage.cacheCreationInputTokens);
    assertTokenCount("cacheReadInput", usage.cacheReadInputTokens);
  } catch (err) {
    logger.warn("cost.recordUsage: invalid token counts; skipping usage write", {
      stage: usage.stage,
      model: usage.model,
      provider: usage.provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  let priced: { costUsd: number; pricedModel: string } | undefined;
  try {
    priced = priceUsage(usage);
  } catch (err) {
    logger.error("cost.recordUsage: pricing failed; persisting the call as unpriced", {
      stage: usage.stage,
      model: usage.model,
      servedModel: usage.servedModel,
      provider: usage.provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Guard `latencyMs` before persisting: a NaN/Infinity/negative value
  // (clock skew, a bad `Date.now()` diff) written straight to the doc
  // would pollute downstream latency rollups and dashboards. Coerce to
  // 0 and warn-and-continue, matching the pricing/Firestore failure
  // shape this function already uses.
  let latencyMs = usage.latencyMs;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    logger.warn("cost.recordUsage: invalid latencyMs coerced to 0", {
      stage: usage.stage,
      model: usage.model,
      provider: usage.provider,
      latencyMs: usage.latencyMs,
    });
    latencyMs = 0;
  }

  // Firestore rejects documents containing `undefined` values by
  // default. Most UsageRecord fields are optional and commonly absent
  // (e.g. embeddings called from a non-user context), so undefined
  // entries are dropped rather than globally enabling
  // `ignoreUndefinedProperties` on the admin SDK.
  const doc = Object.fromEntries(
    Object.entries({
      ...usage,
      latencyMs,
      usageSchemaVersion: USAGE_SCHEMA_VERSION,
      costStatus: priced ? "priced" : "unpriced",
      costUsd: priced?.costUsd,
      pricedModel: priced?.pricedModel,
      createdAt: FieldValue.serverTimestamp(),
    } satisfies LlmCallDoc).filter(([, value]) => value !== undefined),
  ) as unknown as LlmCallDoc;
  const costUsd = priced?.costUsd ?? 0;

  // Fire-and-forget: the caller's LLM response path must not block on
  // the telemetry write. Errors are logged via .catch. V1 accepts the
  // narrow data-loss window during Cloud Run instance scale-down;
  // upgrading to Cloud Tasks / Pub/Sub for durability is deferred
  // until Phase 3 telemetry (#41) when real usage reveals whether loss
  // is measurable. Single-user V1 volume does not justify the infra.
  //
  // Route through `getAdminDb()` (the documented single choke point in
  // firestore/admin.ts) rather than calling `getFirestore()` directly,
  // and wrap in try/catch: `.catch` only handles async rejections, but
  // `getAdminDb()`/`getFirestore()` can throw synchronously if the
  // Firebase app state is invalid. That synchronous throw would escape
  // past `.catch` and break the caller's response path, violating the
  // "telemetry never blocks/throws into the caller" contract.
  try {
    void getAdminDb()
      .collection(LLM_CALLS_COLLECTION)
      .add(doc)
      .catch((err) => {
        logger.warn("cost.recordUsage: Firestore write failed; returning cost anyway", {
          stage: usage.stage,
          model: usage.model,
          provider: usage.provider,
          costUsd,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  } catch (err) {
    logger.warn("cost.recordUsage: Firestore init failed; returning cost anyway", {
      stage: usage.stage,
      model: usage.model,
      provider: usage.provider,
      costUsd,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return costUsd;
}

/** `<stage>/<name>.<version>` label for a loaded prompt, e.g. `extraction/resume.v1`. */
export function promptVersionLabel(prompt: {
  readonly stage: string;
  readonly name: string;
  readonly version: string;
}): string {
  return `${prompt.stage}/${prompt.name}.${prompt.version}`;
}
