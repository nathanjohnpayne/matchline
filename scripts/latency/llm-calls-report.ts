/**
 * Read-only latency report over the `llm_calls` collection (#616).
 *
 * Owns the measurement half of the PRD's full-flow target (paste JD →
 * validated résumé, p95 < 20 s). Every model call already records its
 * stage, subtask, model and `latencyMs` through `recordUsage()`
 * (`functions/src/llm/cost.ts`); this groups them per stage and per
 * application run. It makes no model calls and writes nothing.
 *
 * Usage (Application Default Credentials with read access to the
 * project's Firestore):
 *   npm run latency:report                         # matchline-dev, last 90 days
 *   npm run latency:report -- --since 2026-10-01   # ISO date
 *   npm run latency:report -- --project <id> --json
 *
 * Output is Markdown with application ids replaced by ordinals, safe
 * to paste into a public issue. `--json` prints the raw grouped rows
 * instead (ids included); keep that output private.
 */

import { createRequire } from "node:module";

import { byRun, byStage, productCalls, renderMarkdown, type CallRow } from "./report.ts";

// firebase-admin is a dependency of the functions package only.
const requireFromFunctions = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp } = requireFromFunctions("firebase-admin/app") as typeof import("firebase-admin/app");
const { getFirestore, Timestamp } = requireFromFunctions(
  "firebase-admin/firestore",
) as typeof import("firebase-admin/firestore");

const LLM_CALLS_COLLECTION = "llm_calls";
const DAY_MS = 24 * 60 * 60 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const projectId = arg("project") ?? "matchline-dev";
  const untilMs = Date.now();
  const sinceArg = arg("since");
  const sinceMs = sinceArg ? Date.parse(sinceArg) : untilMs - 90 * DAY_MS;
  if (Number.isNaN(sinceMs)) throw new Error(`--since is not a date: ${sinceArg}`);

  // Bill the read to the target project, not whatever the local ADC
  // file names as its quota project.
  process.env.GOOGLE_CLOUD_QUOTA_PROJECT ??= projectId;
  initializeApp({ projectId });

  const snap = await getFirestore()
    .collection(LLM_CALLS_COLLECTION)
    .where("createdAt", ">=", Timestamp.fromMillis(sinceMs))
    .select("stage", "subtask", "model", "latencyMs", "createdAt", "applicationId", "runId", "attempt", "costUsd")
    .get();

  const rows: CallRow[] = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const createdAt = d.createdAt as InstanceType<typeof Timestamp> | undefined;
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

  if (process.argv.includes("--json")) {
    const product = productCalls(rows);
    console.log(JSON.stringify({ projectId, sinceMs, untilMs, stages: byStage(product), runs: byRun(product) }, null, 2));
    return;
  }
  console.log(renderMarkdown(rows, { sinceMs, untilMs }));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
