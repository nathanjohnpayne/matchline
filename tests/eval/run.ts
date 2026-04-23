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
  } catch {
    return [];
  }
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

  const sortedLatencies: number[] = [];
  const sortedCosts: number[] = [];

  // Projection guard: even with no real LLM calls today, the harness
  // always reports against the caps so the output shape is stable
  // and operators see the monthly picture. Phase 1 replaces the
  // zero-currentUsage mock with a real Firestore aggregation.
  const currentUsage = { anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 };
  const plannedAdd = estimatePlannedSpend(mode, selected.length);
  const capChecks = checkCaps(currentUsage, plannedAdd, DEFAULT_CAPS);

  if (mode === "full" && shouldBlock(capChecks)) {
    // Phase 0 won't actually block — there's no real spend. But the
    // branch exists so the behavior is testable and so Phase 1 only
    // has to wire real currentUsage to flip this live.
    console.error(
      "\nRefusing to run --full: projection exceeds a monthly cap.\n" +
        "Re-run with --smoke or wait for next month's cap reset.\n",
    );
    // Intentionally don't return 1 here in Phase 0; empty spend can't
    // trip the guard. Logged for future diff.
  }

  const report: EvalReport = {
    mode,
    fixtureResults,
    capChecks,
    aggregate: {
      extractionAccuracyMean: mean(fixtureResults.map((r) => r.extractionAccuracy).filter((n): n is number => n !== null)),
      matchAccuracyMean: mean(fixtureResults.map((r) => r.matchAccuracy).filter((n): n is number => n !== null)),
      latencyP50: percentile(sortedLatencies, 50),
      latencyP95: percentile(sortedLatencies, 95),
      costP50: percentile(sortedCosts, 50),
      costP95: percentile(sortedCosts, 95),
      totalCostUsd: 0,
    },
  };

  console.log(formatReport(report));
  console.log(
    `\n(fixtures available: ${resumeFixtures.length} resumes × ${jdFixtures.length} JDs)`,
  );

  return 0;
}

/**
 * Very conservative upfront estimate of what one mode's run will
 * cost, so the projection guard has something to check against even
 * before real calls happen. Phase 1 replaces this with per-stage
 * rate × estimated-token math.
 */
function estimatePlannedSpend(
  mode: Mode,
  fixtureCount: number,
): { anthropicUsd: number; openaiUsd: number; firebaseUsd: number } {
  const perFixture = mode === "full" ? 0.75 : 0.0;
  return {
    anthropicUsd: fixtureCount * perFixture * 0.7,
    openaiUsd: fixtureCount * perFixture * 0.3,
    firebaseUsd: 0,
  };
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("eval harness failed:", err);
    process.exit(2);
  });
