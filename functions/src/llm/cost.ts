/**
 * LLM cost accounting. Every LLM call logs tokens and computed USD cost
 * to the `llm_calls` Firestore collection; readers aggregate per-month
 * and per-application to enforce the per-flow and monthly budget caps
 * defined in specs/matchline.md § Execution targets.
 *
 * The pure `priceFor` is trivially testable and used by both the
 * per-call `recordUsage` path and any projection guard that wants to
 * pre-compute a spend estimate without hitting Firestore.
 */

import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { rateFor } from "./rates.js";

export const LLM_CALLS_COLLECTION = "llm_calls";

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface UsageRecord extends TokenCounts {
  /** Pipeline stage the call served (e.g. "extraction", "generation"). */
  readonly stage: string;

  /** Model identifier; must have an entry in `RATES`. */
  readonly model: string;

  /** Provider side, "anthropic" | "openai" — split for per-vendor alarms. */
  readonly provider: "anthropic" | "openai";

  /** Wall-clock latency of the call. Used by the eval harness. */
  readonly latencyMs: number;

  /** Optional — the user whose flow originated the call. */
  readonly ownerUid?: string;

  /** Optional — the Application being generated, if any. */
  readonly applicationId?: string;
}

export interface LlmCallDoc extends UsageRecord {
  readonly costUsd: number;
  readonly createdAt: FirebaseFirestore.FieldValue;
}

/**
 * Pure price calculator. No I/O. Reused by the eval-harness projection
 * guard (#48) to pre-compute run cost without burning Firestore reads.
 *
 * Throws on unknown models (via `rateFor`) or invalid token counts
 * (negative, `NaN`, `Infinity`) so bad inputs can never silently
 * persist as a $0 cost and corrupt downstream budget math.
 */
export function priceFor(model: string, tokens: TokenCounts): number {
  if (
    !Number.isFinite(tokens.inputTokens) ||
    !Number.isFinite(tokens.outputTokens) ||
    tokens.inputTokens < 0 ||
    tokens.outputTokens < 0
  ) {
    throw new Error(
      `Token counts must be finite, non-negative numbers (got input=${tokens.inputTokens}, output=${tokens.outputTokens}).`,
    );
  }
  const rate = rateFor(model);
  return (
    (tokens.inputTokens / 1000) * rate.inputUsdPer1k +
    (tokens.outputTokens / 1000) * rate.outputUsdPer1k
  );
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
 * Returns `0` when pricing itself fails (logged as a warning).
 */
export async function recordUsage(usage: UsageRecord): Promise<number> {
  let costUsd: number;
  try {
    costUsd = priceFor(usage.model, usage);
  } catch (err) {
    logger.warn("cost.recordUsage: pricing failed; skipping usage write", {
      stage: usage.stage,
      model: usage.model,
      provider: usage.provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  // Firestore rejects documents containing `undefined` values by
  // default. `usage.ownerUid` and `usage.applicationId` are optional
  // and commonly absent (e.g. embeddings called from a non-user
  // context), so we build the doc conditionally rather than globally
  // enabling `ignoreUndefinedProperties` on the admin SDK.
  const doc: LlmCallDoc = {
    stage: usage.stage,
    model: usage.model,
    provider: usage.provider,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    latencyMs: usage.latencyMs,
    costUsd,
    createdAt: FieldValue.serverTimestamp(),
    ...(usage.ownerUid !== undefined && { ownerUid: usage.ownerUid }),
    ...(usage.applicationId !== undefined && { applicationId: usage.applicationId }),
  };

  // Fire-and-forget: the caller's LLM response path must not block on
  // the telemetry write. Errors are logged via .catch. V1 accepts the
  // narrow data-loss window during Cloud Run instance scale-down;
  // upgrading to Cloud Tasks / Pub/Sub for durability is deferred
  // until Phase 3 telemetry (#41) when real usage reveals whether loss
  // is measurable. Single-user V1 volume does not justify the infra.
  void getFirestore()
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

  return costUsd;
}
