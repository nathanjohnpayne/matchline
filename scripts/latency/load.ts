/**
 * The latency report's read-only Firestore query (#616), split from
 * the CLI so the emulator suite can exercise it
 * (`tests/latency-report.integration.test.ts`).
 *
 * Takes the Firestore instance rather than importing firebase-admin:
 * the root package doesn't depend on it, and the CLI and the test
 * each get it from the functions package their own way. The window
 * bounds are passed as `Date`s, which Firestore compares as
 * Timestamps, for the same reason.
 */

import type { getAdminDb } from "../../functions/src/firestore/admin.ts";
import type { CallRow } from "./report.ts";

/** firebase-admin's type, resolved through the functions package. */
type Firestore = ReturnType<typeof getAdminDb>;

export const LLM_CALLS_COLLECTION = "llm_calls";

/**
 * Calls with `createdAt` in `[sinceMs, untilMs)`, projected to the
 * fields the report reads. Documents missing a timestamp, stage or
 * latency are skipped.
 */
export async function loadCallRows(
  db: Firestore,
  window: { readonly sinceMs: number; readonly untilMs: number },
): Promise<CallRow[]> {
  const snap = await db
    .collection(LLM_CALLS_COLLECTION)
    .where("createdAt", ">=", new Date(window.sinceMs))
    .where("createdAt", "<", new Date(window.untilMs))
    .select("stage", "subtask", "model", "latencyMs", "createdAt", "applicationId", "runId", "attempt", "costUsd")
    .get();

  const rows: CallRow[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const createdAt = d.createdAt as { toMillis(): number } | undefined;
    if (!createdAt || typeof d.stage !== "string" || typeof d.latencyMs !== "number") continue;
    rows.push({
      stage: d.stage,
      subtask: typeof d.subtask === "string" ? d.subtask : undefined,
      model: typeof d.model === "string" ? d.model : "unknown",
      latencyMs: d.latencyMs,
      createdAtMs: createdAt.toMillis(),
      applicationId: typeof d.applicationId === "string" ? d.applicationId : undefined,
      runId: typeof d.runId === "string" ? d.runId : undefined,
      attempt: typeof d.attempt === "number" ? d.attempt : undefined,
      costUsd: typeof d.costUsd === "number" ? d.costUsd : undefined,
    });
  }
  return rows;
}
