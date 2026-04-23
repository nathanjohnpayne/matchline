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
 */
export function priceFor(model: string, tokens: TokenCounts): number {
  const rate = rateFor(model);
  return (
    (tokens.inputTokens / 1000) * rate.inputUsdPer1k +
    (tokens.outputTokens / 1000) * rate.outputUsdPer1k
  );
}

/**
 * Persist one LLM call's usage + cost to Firestore and return the
 * computed dollar cost. Firestore failures are logged but never thrown
 * — a flaky write path must not kill the caller's actual LLM response,
 * per the "fail visibly, not silently" principle applied inversely:
 * cost telemetry failing is a reporting issue, not a correctness one.
 *
 * The returned value lets the caller surface per-call cost on the
 * Application (Phase 2a Editor footer) without a round-trip read.
 */
export async function recordUsage(usage: UsageRecord): Promise<number> {
  const costUsd = priceFor(usage.model, usage);
  const doc: LlmCallDoc = {
    ...usage,
    costUsd,
    createdAt: FieldValue.serverTimestamp(),
  };

  try {
    await getFirestore().collection(LLM_CALLS_COLLECTION).add(doc);
  } catch (err) {
    logger.warn("cost.recordUsage: Firestore write failed; returning cost anyway", {
      stage: usage.stage,
      model: usage.model,
      provider: usage.provider,
      costUsd,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return costUsd;
}
