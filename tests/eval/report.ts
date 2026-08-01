/**
 * Pure stdout formatter for harness runs. Takes in the eval result
 * structure and produces a printable report; does no I/O itself so
 * the tests can snapshot the exact output.
 */

import type { CapCheck } from "./projection.js";

export interface FixtureResult {
  readonly id: string;
  readonly extractionAccuracy: number | null;
  readonly matchAccuracy: number | null;
  readonly latencyMs: number | null;
  /** Real new spend this run. Drops toward 0 as the stage cache warms. */
  readonly costUsd: number | null;
  /**
   * What this configuration costs **uncached** (#389). Equal to
   * `costUsd` on a cold run; stays put as the cache warms, which is
   * what makes it the honest number to rank models on.
   *
   * Optional so pre-#389 callers and the stub/skipped-fixture rows
   * (which have no usage records at all) don't have to synthesize one.
   */
  readonly modeledCostUsd?: number | null;
  readonly notes?: string;
}

export interface EvalReport {
  readonly mode: "smoke" | "full";
  readonly fixtureResults: readonly FixtureResult[];
  readonly capChecks: readonly CapCheck[];
  readonly aggregate: {
    readonly extractionAccuracyMean: number | null;
    readonly matchAccuracyMean: number | null;
    readonly latencyP50: number | null;
    readonly latencyP95: number | null;
    readonly costP50: number | null;
    readonly costP95: number | null;
    readonly totalCostUsd: number;
    /**
     * Sum of `modeledCostUsd` across fixtures (#389) — what the run
     * would have cost with a cold cache. Optional so pre-#389 report
     * constructors stay valid.
     */
    readonly totalModeledCostUsd?: number | null;
  };
  /**
   * Stage-cache rollup for the run (#389). Omitted when caching is
   * off, so a `--no-cache` run's report is byte-identical to the
   * pre-#389 shape.
   */
  readonly cache?: {
    readonly mode: string;
    readonly hits: number;
    readonly misses: number;
  };
  /**
   * Per-(stage,name) resolved prompt versions used during this run.
   * Empty when no overrides are active (production-equivalent run);
   * present when `--prompt stage/name=version` flags are passed so
   * the report shows which prompt versions produced the numbers.
   * Each entry includes whether it came from PROMPT_CONFIG (default)
   * or a runtime override so an A/B comparison is unambiguous from
   * the report alone.
   */
  readonly promptVersions?: ReadonlyArray<{
    readonly key: string; // e.g. "extraction/resume"
    readonly version: string; // e.g. "v2"
    readonly source: "default" | "override";
  }>;
}

/**
 * Format a report as a plain-text report for CI logs. Empty-fixture
 * runs print a short "no fixtures" notice so the harness can ship in
 * Phase 0 and be meaningfully runnable before #25 populates the
 * corpus.
 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Matchline eval — mode: ${report.mode}`);

  if (report.promptVersions && report.promptVersions.length > 0) {
    lines.push("");
    lines.push("## Prompt versions");
    for (const p of report.promptVersions) {
      const tag = p.source === "override" ? " (override)" : "";
      lines.push(`- ${p.key}: ${p.version}${tag}`);
    }
  }

  if (report.fixtureResults.length === 0) {
    lines.push("");
    lines.push("No fixtures found under tests/fixtures/. Scaffolding is live");
    lines.push("(this harness is runnable) but content lands in #25.");
  } else {
    lines.push("");
    lines.push("## Per-fixture");
    for (const r of report.fixtureResults) {
      // Show the modeled cost alongside real spend only when the two
      // differ — on a cold run they're equal and the extra column is
      // noise.
      const modeled =
        r.modeledCostUsd !== undefined &&
        r.modeledCostUsd !== null &&
        r.modeledCostUsd !== r.costUsd
          ? ` (uncached ${fmtUsd(r.modeledCostUsd)})`
          : "";
      lines.push(
        `- ${r.id.padEnd(30)} extraction=${fmtPct(r.extractionAccuracy)} ` +
          `match=${fmtPct(r.matchAccuracy)} latency=${fmtMs(r.latencyMs)} ` +
          `cost=${fmtUsd(r.costUsd)}${modeled}${r.notes ? `  (${r.notes})` : ""}`,
      );
    }
    lines.push("");
    lines.push("## Aggregate");
    lines.push(`extraction accuracy (mean): ${fmtPct(report.aggregate.extractionAccuracyMean)}`);
    lines.push(`match accuracy (mean):      ${fmtPct(report.aggregate.matchAccuracyMean)}`);
    lines.push(
      `latency p50 / p95:          ${fmtMs(report.aggregate.latencyP50)} / ${fmtMs(report.aggregate.latencyP95)}`,
    );
    // Codex P2 round 2: a warm run reaches this line having served
    // extraction, parsing, and embeddings from disk, so the elapsed
    // time is matching-only. Printed bare, the aggregate could appear
    // to clear the production <20s p95 target without a single API
    // call having been made. Label it rather than let a reader take
    // it at face value.
    if (report.cache !== undefined && report.cache.hits > 0) {
      lines.push(
        `  ⚠️  NOT a production latency reading — ${report.cache.hits} stage(s) served from`,
      );
      lines.push(
        "      cache, so this excludes the LLM calls it measures. Re-run with",
      );
      lines.push(
        "      --no-cache --token-source api for a figure comparable to the <20s target.",
      );
    }
    lines.push(
      `cost per fixture p50 / p95: ${fmtUsd(report.aggregate.costP50)} / ${fmtUsd(report.aggregate.costP95)}`,
    );
    lines.push(`total run cost:             ${fmtUsd(report.aggregate.totalCostUsd)}`);
    if (
      report.aggregate.totalModeledCostUsd !== undefined &&
      report.aggregate.totalModeledCostUsd !== null &&
      report.aggregate.totalModeledCostUsd !== report.aggregate.totalCostUsd
    ) {
      lines.push(
        `total uncached cost:        ${fmtUsd(report.aggregate.totalModeledCostUsd)}  ` +
          `(what this config costs with a cold cache)`,
      );
    }
    if (report.cache) {
      const total = report.cache.hits + report.cache.misses;
      const pct = total === 0 ? 0 : (report.cache.hits / total) * 100;
      lines.push(
        `stage cache:                ${report.cache.hits} hit / ${report.cache.misses} miss ` +
          `(${pct.toFixed(0)}% hit, mode=${report.cache.mode})`,
      );
    }
  }

  lines.push("");
  lines.push("## Monthly spend projection");
  for (const c of report.capChecks) {
    const flag = c.exceedsCap ? " ❌ EXCEEDS" : c.exceedsWarn ? " ⚠️  over warn" : "";
    lines.push(
      `- ${c.provider.padEnd(10)} ${fmtUsd(c.projectedUsd)} / cap ${fmtUsd(c.cap)}${flag} ` +
        `(current=${fmtUsd(c.currentUsd)}, +plan=${fmtUsd(c.plannedAddUsd)})`,
    );
  }
  return lines.join("\n");
}

function fmtPct(v: number | null): string {
  return v === null ? "  —  " : `${(v * 100).toFixed(1)}%`;
}

function fmtMs(v: number | null): string {
  return v === null ? "   — " : `${v.toFixed(0)}ms`;
}

function fmtUsd(v: number | null): string {
  return v === null ? " — " : `$${v.toFixed(4)}`;
}
