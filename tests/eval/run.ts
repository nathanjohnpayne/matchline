#!/usr/bin/env -S tsx
/**
 * Eval harness entry point. Walks `tests/fixtures/` for fixture
 * inputs, runs the (stub, until Phase 1) extraction/matching
 * pipeline, scores against expected outputs, and prints a report.
 *
 * Phase 0 scope: skeleton that runs green on an empty fixture set
 * (or a handful of hand-authored fixtures) and demonstrates the
 * full pipeline wiring. Phase 1 (#25) populates the corpus and
 * flips the 80/80 CI gate blocking.
 *
 * Usage:
 *   npm run eval               — smoke mode (default)
 *   npm run eval -- --full     — full corpus (projection-guard gated)
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkCaps, DEFAULT_CAPS, shouldBlock } from "./projection.js";
import { formatReport, type EvalReport, type FixtureResult } from "./report.js";

type Mode = "smoke" | "full";

function parseMode(argv: readonly string[]): Mode {
  return argv.includes("--full") ? "full" : "smoke";
}

function listFixtures(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isFile() &&
          !d.name.startsWith(".") &&
          d.name.endsWith(ext) &&
          // Skip READMEs and other meta files that happen to share the ext.
          d.name.toLowerCase() !== `readme${ext}`,
      )
      .map((d) => d.name);
  } catch (err) {
    // ENOENT is expected — a fixture subdir simply doesn't exist yet.
    // Anything else (permission, I/O) should fail visibly so a broken
    // mount or a typo'd path never silently reports "no fixtures".
    if (isEnoent(err)) return [];
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  const fixturesDir = join(process.cwd(), "tests", "fixtures");
  const resumeFixtures = listFixtures(join(fixturesDir, "resumes"), ".txt");
  const jdFixtures = listFixtures(join(fixturesDir, "jds"), ".txt");

  // Phase 0 stub: no actual extraction/matching runs yet. The harness
  // reports "scaffolding live, no content" when fixtures are empty
  // and lists any that exist without scoring them. Phase 1 (#25)
  // wires real extraction + scoring.
  const fixtureResults: FixtureResult[] = [];
  const selected =
    mode === "smoke" ? resumeFixtures.slice(0, 1) : resumeFixtures;

  for (const f of selected) {
    fixtureResults.push({
      id: f,
      extractionAccuracy: null,
      matchAccuracy: null,
      latencyMs: null,
      costUsd: null,
      notes: "Phase 0 stub — scoring pending #25",
    });
  }

  // Projection guard: even with no real LLM calls today, the harness
  // always reports against the caps so the output shape is stable
  // and operators see the monthly picture. Phase 1 replaces the
  // zero-currentUsage mock with a real Firestore aggregation.
  const currentUsage = { anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 };
  // A flow is one (resume × JD) pair, not one resume. With N resumes
  // and M JDs, a --full run is N×M flows. No floor on the JD
  // multiplier: if zero JDs are present, the run has zero flows,
  // projected spend is genuinely zero, and the guard should not trip.
  // A prior `Math.max(selectedJdCount, 1)` defaulted the multiplier
  // to 1 and falsely projected N×1 flows on a resumes-only corpus
  // (blocker from nathanpayne-codex on #55).
  const flowCount = computeFlowCount(mode, selected.length, jdFixtures.length);
  const plannedAdd = estimatePlannedSpend(mode, flowCount);
  const capChecks = checkCaps(currentUsage, plannedAdd, DEFAULT_CAPS);

  if (mode === "full" && shouldBlock(capChecks)) {
    // Projection guard is enforcing from day 1: once Phase 1 wires
    // real `currentUsage` from the llm_calls Firestore aggregation,
    // this branch will trip in actual over-budget scenarios. Keeping
    // it non-enforcing "until Phase 1" would ship a guard CI treats
    // as success — which is exactly the failure mode a guard exists
    // to prevent. Exit 1 now, so the gate works identically the
    // moment real spend flows through.
    console.error(
      "\nRefusing to run --full: projection exceeds a monthly cap.\n" +
        "Re-run with --smoke or wait for next month's cap reset.\n",
    );
    console.log(formatReport(buildReport(mode, fixtureResults, capChecks)));
    return 1;
  }

  const report = buildReport(mode, fixtureResults, capChecks);
  console.log(formatReport(report));
  console.log(
    `\n(fixtures available: ${resumeFixtures.length} resumes × ${jdFixtures.length} JDs)`,
  );

  return 0;
}

function buildReport(
  mode: Mode,
  fixtureResults: readonly FixtureResult[],
  capChecks: ReturnType<typeof checkCaps>,
): EvalReport {
  const latencies = fixtureResults
    .map((r) => r.latencyMs)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const costs = fixtureResults
    .map((r) => r.costUsd)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  return {
    mode,
    fixtureResults,
    capChecks,
    aggregate: {
      extractionAccuracyMean: mean(
        fixtureResults
          .map((r) => r.extractionAccuracy)
          .filter((n): n is number => n !== null),
      ),
      matchAccuracyMean: mean(
        fixtureResults
          .map((r) => r.matchAccuracy)
          .filter((n): n is number => n !== null),
      ),
      latencyP50: percentile(latencies, 50),
      latencyP95: percentile(latencies, 95),
      costP50: percentile(costs, 50),
      costP95: percentile(costs, 95),
      totalCostUsd: costs.reduce((a, b) => a + b, 0),
    },
  };
}

/**
 * Pure cardinality: given the number of resume and JD fixtures in a
 * run, how many (resume × JD) flows will execute? Smoke mode pairs
 * the single selected resume with a single JD (or zero if none
 * exist); full mode is the full cross product.
 *
 * Exported for tests: the zero-JD regression (50 resumes × 0 JDs
 * should be 0 flows, not 50) was the second blocker from
 * nathanpayne-codex on #55.
 */
export function computeFlowCount(
  mode: Mode,
  resumeCount: number,
  jdCount: number,
): number {
  if (resumeCount <= 0 || jdCount <= 0) return 0;
  if (mode === "smoke") {
    // Smoke: one resume × one JD, capped at available fixtures.
    return Math.min(resumeCount, 1) * Math.min(jdCount, 1);
  }
  return resumeCount * jdCount;
}

/**
 * Very conservative upfront estimate of what one mode's run will
 * cost, so the projection guard has something to check against even
 * before real calls happen. `flowCount` is resume×JD pairs, not
 * resume count — see `computeFlowCount`. Phase 1 replaces this with
 * per-stage rate × estimated-token math.
 */
function estimatePlannedSpend(
  mode: Mode,
  flowCount: number,
): { anthropicUsd: number; openaiUsd: number; firebaseUsd: number } {
  const perFlow = mode === "full" ? 0.75 : 0.0;
  return {
    anthropicUsd: flowCount * perFlow * 0.7,
    openaiUsd: flowCount * perFlow * 0.3,
    firebaseUsd: 0,
  };
}

// Only run main() when invoked as a script (via `npm run eval` →
// `tsx tests/eval/run.ts`). Importing run.ts from a test file must
// not trigger process.exit — vitest caught this in unhandled-error
// form when run.test.ts imported `computeFlowCount`.
const isScriptEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isScriptEntry) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("eval harness failed:", err);
      process.exit(2);
    });
}
