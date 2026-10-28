/**
 * Read-only latency report over the `llm_calls` collection (#616).
 *
 * Owns the measurement half of the PRD's full-flow target (paste JD →
 * validated résumé, p95 < 20 s). Every model call already records its
 * stage, subtask, model and `latencyMs` through `recordUsage()`
 * (`functions/src/llm/cost.ts`); this groups them per stage and per
 * application run. It makes no model calls and writes nothing.
 *
 * Prerequisites: Application Default Credentials with read access to
 * the project's Firestore, and the functions package's dependencies
 * (`firebase-admin` is declared there only): `npm --prefix functions ci`.
 *
 * Usage:
 *   npm run latency:report                         # matchline-dev, last 90 days
 *   npm run latency:report -- --since 2026-10-01   # ISO date (UTC midnight)
 *   npm run latency:report -- --since 2026-08-31 --until 2026-09-04
 *   npm run latency:report -- --project <id> --json
 *
 * `--since` is inclusive and `--until` exclusive; both apply to
 * `createdAt`, so a fixed window reproduces exactly.
 *
 * Output is Markdown with application ids replaced by ordinals, safe
 * to paste into a public issue. `--json` prints the raw grouped rows
 * instead (ids included); keep that output private.
 */

import { createRequire } from "node:module";

import { loadCallRows } from "./load.ts";
import { byRun, byStage, parseIsoDate, productCalls, renderMarkdown } from "./report.ts";

// firebase-admin is a dependency of the functions package only.
const requireFromFunctions = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp } = requireFromFunctions("firebase-admin/app") as typeof import("firebase-admin/app");
const { getFirestore } = requireFromFunctions(
  "firebase-admin/firestore",
) as typeof import("firebase-admin/firestore");

const DAY_MS = 24 * 60 * 60 * 1000;

/** An option's operand; throws when the flag is present without one. */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const projectId = arg("project") ?? "matchline-dev";
  const untilArg = arg("until");
  const untilMs = untilArg ? parseIsoDate("until", untilArg) : Date.now();
  const sinceArg = arg("since");
  const sinceMs = sinceArg ? parseIsoDate("since", sinceArg) : untilMs - 90 * DAY_MS;
  if (sinceMs >= untilMs) throw new Error("--since must be before --until");

  // Bill the read to the target project, not whatever the local ADC
  // file names as its quota project.
  process.env.GOOGLE_CLOUD_QUOTA_PROJECT ??= projectId;
  initializeApp({ projectId });

  const rows = await loadCallRows(getFirestore(), { sinceMs, untilMs });

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
