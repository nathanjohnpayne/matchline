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
  readonly costUsd: number | null;
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
  };
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

  if (report.fixtureResults.length === 0) {
    lines.push("");
    lines.push("No fixtures found under tests/fixtures/. Scaffolding is live");
    lines.push("(this harness is runnable) but content lands in #25.");
  } else {
    lines.push("");
    lines.push("## Per-fixture");
    for (const r of report.fixtureResults) {
      lines.push(
        `- ${r.id.padEnd(30)} extraction=${fmtPct(r.extractionAccuracy)} ` +
          `match=${fmtPct(r.matchAccuracy)} latency=${fmtMs(r.latencyMs)} ` +
          `cost=${fmtUsd(r.costUsd)}${r.notes ? `  (${r.notes})` : ""}`,
      );
    }
    lines.push("");
    lines.push("## Aggregate");
    lines.push(`extraction accuracy (mean): ${fmtPct(report.aggregate.extractionAccuracyMean)}`);
    lines.push(`match accuracy (mean):      ${fmtPct(report.aggregate.matchAccuracyMean)}`);
    lines.push(
      `latency p50 / p95:          ${fmtMs(report.aggregate.latencyP50)} / ${fmtMs(report.aggregate.latencyP95)}`,
    );
    lines.push(
      `cost per fixture p50 / p95: ${fmtUsd(report.aggregate.costP50)} / ${fmtUsd(report.aggregate.costP95)}`,
    );
    lines.push(`total run cost:             ${fmtUsd(report.aggregate.totalCostUsd)}`);
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
