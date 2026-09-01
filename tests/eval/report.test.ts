/**
 * Report formatter tests.
 *
 * `formatReport` had no coverage at all, which is how both latency
 * caveats below shipped unpinned. The report is written to be saved and
 * pasted as experiment evidence, so the invariant these tests protect
 * is narrow and specific: a latency figure that is NOT comparable to
 * the production <20s p95 target must never print bare.
 */

import { describe, expect, it } from "vitest";

import { formatReport, type EvalReport } from "./report.ts";

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    mode: "smoke",
    fixtureResults: [
      {
        id: "nathan-2026 × google-compute-spm-2026",
        extractionAccuracy: 0.5,
        matchAccuracy: 0.2,
        latencyMs: 1000,
        costUsd: 0.1,
      },
    ],
    capChecks: [],
    aggregate: {
      extractionAccuracyMean: 0.5,
      matchAccuracyMean: 0.2,
      latencyP50: 1000,
      latencyP95: 2000,
      costP50: 0.1,
      costP95: 0.2,
      totalCostUsd: 0.3,
    },
    ...overrides,
  };
}

const CAVEAT = "NOT a production latency reading";

describe("formatReport latency caveats", () => {
  it("prints latency bare for a cold metered-API run", () => {
    // The one case where the number IS production-comparable.
    const out = formatReport(report({ tokenSource: "api" }));
    expect(out).toContain("latency p50 / p95:");
    expect(out).not.toContain(CAVEAT);
  });

  it("labels latency on a cold CLI run", () => {
    // Codex P2: the cache caveat covered warm runs, but a COLD
    // claude-cli run prints timings carrying agent startup and
    // tool-loop overhead a production API call never pays. Unlabeled,
    // it reads as production-comparable.
    const out = formatReport(report({ tokenSource: "claude-cli" }));
    expect(out).toContain(CAVEAT);
    expect(out).toContain("claude-cli");
    expect(out).toContain("agent startup");
    expect(out).toContain("--token-source api");
  });

  it("labels latency on a warm run served from cache", () => {
    const out = formatReport(
      report({
        tokenSource: "api",
        cache: { mode: "read-write", hits: 4, misses: 0 } as NonNullable<EvalReport["cache"]>,
      }),
    );
    expect(out).toContain(CAVEAT);
    expect(out).toContain("4 stage(s) served from");
    expect(out).toContain("--no-cache");
  });

  it("prints both caveats when a CLI run is also warm", () => {
    // They describe two independent reasons the figure is not
    // production-comparable; suppressing either would understate why.
    const out = formatReport(
      report({
        tokenSource: "claude-cli",
        cache: { mode: "read-write", hits: 2, misses: 2 } as NonNullable<EvalReport["cache"]>,
      }),
    );
    expect(out.split(CAVEAT)).toHaveLength(3);
    expect(out).toContain("agent startup");
    expect(out).toContain("2 stage(s) served from");
  });

  it("marks CLI modeled costs as estimated, and API ones not", () => {
    // Codex P2: a CLI-measured modeled cost is `estimateTokens`'
    // ~4-chars-per-token approximation. `formatSweepReport` marks those
    // with `~`; this formatter labeled only the latency, so the plain
    // report's uncached figures read as exact.
    const withModeled = (tokenSource: string) =>
      formatReport(
        report({
          tokenSource,
          fixtureResults: [
            {
              id: "nathan-2026 × google-compute-spm-2026",
              extractionAccuracy: 0.5,
              matchAccuracy: 0.2,
              latencyMs: 1000,
              costUsd: 0.1,
              modeledCostUsd: 0.4,
            },
          ],
          aggregate: { ...report().aggregate, totalCostUsd: 0.1, totalModeledCostUsd: 0.4 },
        }),
      );

    const cli = withModeled("claude-cli");
    expect(cli).toContain("(uncached ~$");
    expect(cli).toContain("total uncached cost:        ~$");
    expect(cli).toContain("~ = estimated");

    const api = withModeled("api");
    expect(api).toContain("(uncached $");
    expect(api).not.toContain("~$");
    expect(api).not.toContain("~ = estimated");
  });

  it("stays bare when the token source is unknown", () => {
    // Pre-#389 report constructors omit tokenSource. Absence is not
    // evidence of a CLI run, so do not invent a caveat for it.
    const out = formatReport(report());
    expect(out).not.toContain(CAVEAT);
  });
});
