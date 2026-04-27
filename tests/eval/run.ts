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

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  anthropicForCli,
} from "../../functions/src/llm/anthropic.ts";
import { openaiForCli } from "../../functions/src/llm/openai.ts";

import { checkCaps, DEFAULT_CAPS, shouldBlock } from "./projection.js";
import { formatReport, type EvalReport, type FixtureResult } from "./report.js";
import { runForFixture, type RunForFixtureResult } from "./runForFixture.js";

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

  // #136: real extraction/parsing/matching runs when both
  // ANTHROPIC_API_KEY and OPENAI_API_KEY are present in the
  // environment. Without keys, fall back to the previous
  // "fixtures listed, not scored" stub so CI's non-blocking
  // smoke run still produces a report shape.
  const haveKeys =
    typeof process.env.ANTHROPIC_API_KEY === "string" &&
    process.env.ANTHROPIC_API_KEY.length > 0 &&
    typeof process.env.OPENAI_API_KEY === "string" &&
    process.env.OPENAI_API_KEY.length > 0;

  // Smoke mode pins to a SPECIFIC (resume, JD) pair via
  // `selectFixturesForMode` (extracted as a pure helper so the
  // bare-ID-vs-`.txt`-filename mismatch and the missing-fixture
  // throw paths are testable without touching the filesystem).
  const { selectedResumes, selectedJds } = selectFixturesForMode(
    mode,
    resumeFixtures,
    jdFixtures,
    fixturesDir,
  );

  // Build (resume, jd) pairs. Smoke = single pair (smoke pin
  // points at a labeled pair already). Full = cross product
  // for the corpus run, then filter to pairs that actually
  // have labeled `expected-matches/*.json` so the eval doesn't
  // mark every unlabeled cell as a 0/0 failed-fixture entry
  // (Codex P1 on PR #151 post-merge).
  const allPairs: Array<{ resume: string; jd: string }> = [];
  for (const r of selectedResumes) {
    for (const j of selectedJds) {
      allPairs.push({ resume: r, jd: j });
    }
  }
  const { labeled: pairs, skipped } = filterToLabeledPairs(
    allPairs,
    fixturesDir,
  );

  const fixtureResults: FixtureResult[] = [];
  // Emit a "skipped" entry per unlabeled pair so the operator
  // sees the gap explicitly. `extractionAccuracy: null` and
  // `matchAccuracy: null` keep skipped cells out of the mean
  // (the aggregator already filters nulls), so corpus accuracy
  // is dominated by labeled pairs — not by ENOENT-driven
  // false-zeros.
  for (const sk of skipped) {
    const resumeId = sk.resume.replace(/\.txt$/, "");
    const jdId = sk.jd.replace(/\.txt$/, "");
    fixtureResults.push({
      id: `${resumeId}__${jdId}`,
      extractionAccuracy: null,
      matchAccuracy: null,
      latencyMs: null,
      costUsd: null,
      notes:
        `skipped: no tests/fixtures/expected-matches/${resumeId}__${jdId}.json. ` +
        `Label this pair to include in the corpus run.`,
    });
  }
  if (haveKeys && pairs.length > 0) {
    const anthropicClient = anthropicForCli();
    const openaiClient = openaiForCli();
    for (const pair of pairs) {
      // Strip `.txt` from the fixture filename to get the
      // fixture id (resumes/jds are always `<id>.txt`).
      const resumeFixtureId = pair.resume.replace(/\.txt$/, "");
      const jdFixtureId = pair.jd.replace(/\.txt$/, "");
      const result = await runForFixture(
        { resumeFixtureId, jdFixtureId },
        { anthropicClient, openaiClient },
      );
      fixtureResults.push(toFixtureResult(result));
    }
  } else {
    // No API keys (or no JD fixtures yet) — list each
    // resume fixture without scoring. Same shape as the
    // pre-#136 Phase 0 stub.
    const stubReason = haveKeys
      ? "no JD fixtures available — extraction + matching needs at least one (resume, JD) pair"
      : "ANTHROPIC_API_KEY and/or OPENAI_API_KEY not set — export both before running for real scoring";
    for (const r of selectedResumes) {
      fixtureResults.push({
        id: r,
        extractionAccuracy: null,
        matchAccuracy: null,
        latencyMs: null,
        costUsd: null,
        notes: stubReason,
      });
    }
  }

  // Projection guard: even with no real LLM calls today, the harness
  // always reports against the caps so the output shape is stable
  // and operators see the monthly picture. Phase 1 replaces the
  // zero-currentUsage mock with a real Firestore aggregation.
  const currentUsage = { anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 };
  // A flow is one (resume × JD) pair THAT WILL ACTUALLY RUN —
  // skipped pairs (no expected-matches label yet) don't dispatch
  // to the engine and therefore don't add to projected spend.
  // Pre-#151-postmerge this used the full listing counts and
  // would overshoot — projecting 110 flows on the current corpus
  // when only 1 (the canonical labeled pair) actually runs.
  // `pairs.length` is post-`filterToLabeledPairs`. For smoke
  // mode this is identical to the prior count (smoke pin always
  // points at a labeled pair); for full mode it falls to the
  // labeled subset.
  const flowCount = pairs.length;
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

/**
 * Convert a per-fixture orchestration result into the
 * report-layer FixtureResult shape. Failed runs (`ok=false`)
 * still produce a result — the error is surfaced in `notes`
 * and accuracies are 0 so the corpus mean reflects the
 * failure (intentional: the gate should fail when fixtures
 * fail, not silently skip them).
 */
export function toFixtureResult(r: RunForFixtureResult): FixtureResult {
  const id = `${r.resumeFixtureId}__${r.jdFixtureId}`;
  if (!r.ok) {
    return {
      id,
      extractionAccuracy: 0,
      matchAccuracy: 0,
      latencyMs: r.latencyMs,
      // Surface the PARTIAL cost the orchestrator
      // accumulated before throwing. Earlier API calls
      // billed real tokens; zeroing them out of the CLI
      // report would hide spend during flaky runs and
      // break the aggregate-total contract. cursor #139
      // r3 caught the prior `costUsd: null` shape after
      // the orchestrator-level fix had already preserved
      // the partial total.
      costUsd: r.costUsd,
      notes: `failed (cost=$${r.costUsd.toFixed(4)}): ${r.error ?? "unknown error"}`,
    };
  }
  return {
    id,
    extractionAccuracy: r.extractionAccuracy,
    matchAccuracy: r.matchAccuracy,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    notes: `extracted=${r.extractedUnitCount} reqs=${r.parsedRequirementCount} matches=${r.matchCount}`,
  };
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
 * Smoke-mode fixture pin. Bare fixture IDs (no `.txt` extension) —
 * `listFixtures` returns `<id>.txt`-shaped names, so the comparison
 * is "ID ∈ stripped(filenames)" and the selected output always
 * carries the `.txt` suffix the rest of the pipeline expects.
 *
 * **Why constants, not slice(0, 1).** Codex P1 + cursor on PRs
 * #150 / #151: prior `slice(0, 1)` selected whatever filename
 * sorted first, which became one of the new unlabeled fixtures
 * the moment a corpus PR landed. `loadExpectedMatches` then threw
 * ENOENT before any LLM call and the smoke run reported a
 * guaranteed 0/0 instead of a meaningful signal. Pinning to a
 * SPECIFIC pair makes that regression structural — not behavioral.
 *
 * **Why this pair.** Nathan + Google SPM is the canonical fixture;
 * it has hand-curated `expected-matches/*.json` and the rest of
 * #137's labeling work keeps it current.
 */
export const SMOKE_RESUME = "nathan-2026";
export const SMOKE_JD = "google-compute-spm-2026";

/**
 * Select the resume + JD fixture filenames to evaluate for a given
 * mode. Pure: takes the listing arrays and returns the slice/pin —
 * no filesystem or process state. Extracted so the bare-ID-vs-
 * `.txt`-filename comparison and the missing-fixture throw paths
 * are testable without mocking the filesystem (the regression
 * cursor caught on the first smoke-pin attempt).
 *
 * Throws `Error` with a clear "update SMOKE_RESUME / SMOKE_JD"
 * message if either pinned fixture is absent from the listing,
 * so removing a pinned fixture fails loud at startup instead of
 * producing a confusing downstream `loadX` error.
 */
export function selectFixturesForMode(
  mode: Mode,
  resumeFixtures: readonly string[],
  jdFixtures: readonly string[],
  fixturesDir: string,
): { selectedResumes: string[]; selectedJds: string[] } {
  if (mode !== "smoke") {
    return {
      selectedResumes: [...resumeFixtures],
      selectedJds: [...jdFixtures],
    };
  }
  const stripTxt = (n: string): string => n.replace(/\.txt$/, "");
  const resumeIds = resumeFixtures.map(stripTxt);
  const jdIds = jdFixtures.map(stripTxt);
  if (!resumeIds.includes(SMOKE_RESUME)) {
    throw new Error(
      `Smoke mode pin: resume fixture "${SMOKE_RESUME}" not found in ${join(
        fixturesDir,
        "resumes",
      )}. Update SMOKE_RESUME in tests/eval/run.ts.`,
    );
  }
  if (!jdIds.includes(SMOKE_JD)) {
    throw new Error(
      `Smoke mode pin: JD fixture "${SMOKE_JD}" not found in ${join(
        fixturesDir,
        "jds",
      )}. Update SMOKE_JD in tests/eval/run.ts.`,
    );
  }
  return {
    selectedResumes: [`${SMOKE_RESUME}.txt`],
    selectedJds: [`${SMOKE_JD}.txt`],
  };
}

/**
 * Partition (resume, jd) pairs by whether their corresponding
 * `expected-matches/<resume>__<jd>.json` label file exists on
 * disk. Pairs without a label file are returned in `skipped`
 * so the harness can emit a per-pair "skipped" report entry
 * (with `extractionAccuracy: null` so the aggregate isn't
 * polluted) instead of dispatching the pair to the engine,
 * which would throw ENOENT inside `loadExpectedMatches`.
 *
 * **Why this exists** (Codex P1 on PR #151 post-merge):
 * the corpus PRs added 9 resumes × 10 JDs = 100 cells but
 * only the 1 canonical (`nathan-2026 × google-compute-spm-2026`)
 * cell has labels. A full-mode run on main would cascade-fail
 * the other 99 cells, marking each as a failed fixture
 * contributing 0% extraction + 0% match accuracy to the
 * aggregate. The eval would report a corrupted picture
 * dominated by label incompleteness, not by real prompt
 * quality.
 *
 * Intent: corpus accuracy is computed over **labeled cells
 * only** until the per-pair labeling work in #137 sub-issue 3
 * lands. Skipped cells stay visible in the per-fixture report
 * so it's obvious which pairs need labeling next.
 *
 * Pure: filesystem reads scoped to `expected-matches/` only;
 * no LLM, no Firestore, no process state.
 */
export function filterToLabeledPairs(
  pairs: ReadonlyArray<{ resume: string; jd: string }>,
  fixturesDir: string,
): {
  labeled: Array<{ resume: string; jd: string }>;
  skipped: Array<{ resume: string; jd: string }>;
} {
  const stripTxt = (n: string): string => n.replace(/\.txt$/, "");
  const labeled: Array<{ resume: string; jd: string }> = [];
  const skipped: Array<{ resume: string; jd: string }> = [];
  for (const p of pairs) {
    const labelPath = join(
      fixturesDir,
      "expected-matches",
      `${stripTxt(p.resume)}__${stripTxt(p.jd)}.json`,
    );
    if (existsSync(labelPath)) {
      labeled.push(p);
    } else {
      skipped.push(p);
    }
  }
  return { labeled, skipped };
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
