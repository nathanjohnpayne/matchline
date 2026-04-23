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

  const doc: LlmCallDoc = {
    ...usage,
    costUsd,
    createdAt: FieldValue.serverTimestamp(),
  };

  // Fire-and-forget: the caller's LLM response path must not block on
  // the telemetry write. Errors are logged via .catch.
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
