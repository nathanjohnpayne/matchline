/**
 * Run metadata and the human report for the subtask suites (#488).
 *
 * The `RunRecord` is what `--report-json` writes: enough to reproduce
 * and compare a run (git sha, token source and fidelity, replay mode,
 * fixture and schema hashes, every setting as sent, every attempt).
 * Two records are comparable only when `comparable` says so. There is
 * no ranking and no recommendation: the labels are drafts until the
 * owner reviews them, and 14 cases cannot carry a promotion decision.
 */

import type { TokenSourceKind } from "../tokenSource.ts";
import type { CapCheck } from "../projection.ts";

import type { FixtureFileInfo } from "./fixtures.ts";
import type { CallRecord, InvocationRecord, SubtaskSuite } from "./instrument.ts";
import type {
  AssetMetrics,
  CostMetrics,
  CoverageMetrics,
  GenerationMetrics,
  Ratio,
  SchemaValidity,
  SpecificityMetrics,
  TraceabilityMetrics,
  Validity,
  WallTime,
} from "./metrics.ts";
import type { ResolvedVariant } from "./overrides.ts";
import type { Projection } from "./plan.ts";
import type { ReplayMode } from "./replay.ts";

export const CAVEAT = "14 cases / 2 snapshots cannot support production p95 or reliability claims.";
export const ONBOARDING_NOTE = "Onboarding extraction is not part of this suite; see `npm run eval`.";
export const GENERATION_SCOPE_NOTE =
  "JD→validated résumé (from frozen approved matches): JD parsing and matching are not re-run.";

export interface ValidationVariantMetrics {
  readonly kind: "validation";
  readonly coverage: CoverageMetrics;
  readonly schema: Readonly<Record<string, SchemaValidity>>;
  readonly traceability: TraceabilityMetrics;
  readonly specificity: SpecificityMetrics;
  readonly asset: AssetMetrics;
  readonly perCase: readonly CaseDetail[];
}

export interface CaseDetail {
  readonly caseId: string;
  readonly category: string;
  readonly repeat: number;
  readonly covered: string;
  readonly traceability: string;
  readonly specificity: string;
  readonly asset: string;
}

export interface GenerationVariantMetrics {
  readonly kind: "generation";
  readonly generation: GenerationMetrics;
  readonly schema: Readonly<Record<string, SchemaValidity>>;
  readonly perSnapshot: readonly { snapshotId: string; repeat: number; detail: string }[];
}

export interface VariantRecord {
  readonly label: string;
  readonly validity: Validity;
  readonly resolved: ResolvedVariant;
  readonly servedModels: Readonly<Record<string, readonly string[]>>;
  readonly concurrency: number;
  readonly budgetMs: number | null;
  readonly metrics: ValidationVariantMetrics | GenerationVariantMetrics | null;
  readonly wallTime: WallTime | null;
  readonly usage: CostMetrics | null;
  readonly notes: readonly string[];
}

export interface RunRecord {
  readonly schema_version: 1;
  readonly runId: string;
  readonly suite: SubtaskSuite;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly dryRun: boolean;
  readonly git: { readonly sha: string | null; readonly dirty: boolean | null };
  readonly tokenSource: TokenSourceKind;
  readonly tokenFidelity: "metered" | "estimated";
  readonly cacheMode: ReplayMode;
  readonly samples: number;
  readonly labels: {
    readonly status: "draft" | "mixed" | "owner-reviewed";
    readonly fixtureSetHash: string;
    readonly files: readonly FixtureFileInfo[];
    /** Primary fixtures (cases or snapshots) and what each derives from. */
    readonly primary: readonly { readonly id: string; readonly path: string; readonly derivedFrom: string | null }[];
  };
  readonly schemas: Readonly<Record<string, string>>;
  readonly variants: readonly VariantRecord[];
  readonly guards: {
    readonly maxUsd: number | null;
    readonly projected: { readonly expectedUsd: number; readonly worstCaseUsd: number; readonly requests: number };
    readonly capChecks: readonly CapCheck[];
    readonly spentUsd: number;
    readonly budgetReached: boolean;
  };
  readonly plan: Projection | null;
  readonly invocations: readonly InvocationRecord[];
  readonly calls: readonly CallRecord[];
  readonly caveat: string;
}

export function labelStatus(files: readonly { review_status: string }[]): RunRecord["labels"]["status"] {
  if (files.length > 0 && files.every((f) => f.review_status === "owner-reviewed")) return "owner-reviewed";
  if (files.every((f) => f.review_status !== "owner-reviewed")) return "draft";
  return "mixed";
}

/** Whether two runs can be compared row for row; the reason when not. */
export function comparable(a: RunRecord, b: RunRecord): { ok: true } | { ok: false; reason: string } {
  if (a.suite !== b.suite) return { ok: false, reason: `different suites (${a.suite} vs ${b.suite})` };
  if (a.labels.fixtureSetHash !== b.labels.fixtureSetHash) {
    return { ok: false, reason: "different fixtureSetHash: labels or fixtures changed (a relabel invalidates comparison)" };
  }
  if (a.tokenSource !== b.tokenSource) return { ok: false, reason: `different token sources (${a.tokenSource} vs ${b.tokenSource})` };
  if ((a.cacheMode === "replay") !== (b.cacheMode === "replay")) {
    return { ok: false, reason: "one run replayed local outputs and the other ran live" };
  }
  return { ok: true };
}

// -- Formatting --------------------------------------------------------------------

function pct(r: Ratio | null): string {
  if (r === null) return "n/a";
  return r.value === null ? `— (0/0)` : `${(r.value * 100).toFixed(1)}% (${r.num}/${r.den})`;
}

function usd(v: number | null): string {
  return v === null ? "unpriced" : `$${v.toFixed(4)}`;
}

function short(hash: string): string {
  return hash.replace(/^sha256:/, "").slice(0, 8) + "…";
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => "  " + r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
}

function banner(r: RunRecord): string[] {
  const out: string[] = [];
  if (r.labels.status !== "owner-reviewed") {
    const drafts = r.labels.primary.filter((p) => r.labels.files.find((f) => f.path === p.path)?.review_status !== "owner-reviewed");
    const derived = r.labels.primary.filter((p) => p.derivedFrom !== null).length;
    out.push(
      `DRAFT LABELS — ${drafts.length}/${r.labels.primary.length} ${r.suite === "validation" ? "cases" : "snapshots"} draft-pending-owner-review ` +
        `(labeled_by claude-draft)${derived > 0 ? `; ${derived} derive${derived === 1 ? "s" : ""} verdicts from an owner-labeled file` : ""}. Not a comparison of record.`,
    );
  }
  return out;
}

export function formatHeader(r: RunRecord): string[] {
  const lines: string[] = [];
  lines.push(`match|line subtask eval — suite=${r.suite}${r.dryRun ? " — DRY RUN (no requests sent)" : ""}`);
  const git = r.git.sha === null ? "git unknown" : `git ${r.git.sha.slice(0, 7)}${r.git.dirty === null ? "" : r.git.dirty ? " (dirty)" : " (clean)"}`;
  const cache =
    r.cacheMode === "fresh" ? "fresh (never reads earlier runs)" : r.cacheMode === "replay" ? "replay (reuses stored outputs; opt-in)" : "bypass (no local replay)";
  lines.push(`runId ${r.runId}   ${git}   token source: ${r.tokenSource} (${r.tokenFidelity})   cache: ${cache}`);
  lines.push(...banner(r));
  lines.push(r.suite === "validation" ? ONBOARDING_NOTE : `${GENERATION_SCOPE_NOTE} ${ONBOARDING_NOTE}`);
  lines.push(`fixtureSetHash ${r.labels.fixtureSetHash}   (comparable only with runs that share this hash)`);
  lines.push("");
  lines.push("fixtures");
  const rows: string[][] = [["path", "label_version", "review_status", "labeled_by", "sha256"]];
  for (const f of r.labels.files) rows.push([f.path, String(f.label_version), f.review_status, f.labeled_by, short(f.sha256)]);
  lines.push(...table(rows));
  lines.push("");
  lines.push("schemas");
  for (const [k, v] of Object.entries(r.schemas)) lines.push(`  ${k}  sha256 ${short(v)}`);
  return lines;
}

export function formatSettings(r: RunRecord): string[] {
  const lines: string[] = [];
  for (const v of r.variants) {
    lines.push("");
    lines.push(`variant ${v.label}   validity: ${v.validity}${v.validity === "valid" ? "" : " — not comparable"}`);
    const rows: string[][] = [["stage", "requested model", "served", "effort", "max_tokens", "tool_choice", "prompt"]];
    for (const [stage, s] of Object.entries(v.resolved.stages)) {
      const key = Object.keys(v.resolved.promptVersions).find((k) => promptStage(k) === stage);
      const p = key === undefined ? "-" : `${key} ${v.resolved.promptVersions[key]!.fingerprint}`;
      rows.push([stage, s.model, (v.servedModels[stage] ?? []).join(",") || "-", s.effort ?? "-", String(s.maxTokens), s.toolChoice, p]);
    }
    lines.push(...table(rows));
    lines.push(`  concurrency ${v.concurrency}   budget ${v.budgetMs === null ? "none" : `${v.budgetMs}ms`}`);
    for (const n of v.notes) lines.push(`  note: ${n}`);
  }
  return lines;
}

function promptStage(key: string): string {
  return (
    {
      "validation/claimExtraction": "claim_extraction",
      "validation/traceability": "traceability",
      "validation/specificity": "specificity",
      "generation/resume": "generation",
    } as Record<string, string>
  )[key] ?? key;
}

export function formatPlan(r: RunRecord): string[] {
  if (r.plan === null) return [];
  const lines: string[] = ["", `planned requests (samples=${r.samples}, attempts ≤3 each)`];
  const rows: string[][] = [["variant", "pass", "stage", "requests", "max est input tok/req", "output cap", "expected USD", "worst-case USD"]];
  // One row per variant, pass, stage and model: requests and USD summed, the largest per-request input shown.
  const groups = new Map<string, { variant: string; pass: string; stage: string; count: number; input: number; cap: number; expected: number; worst: number }>();
  for (const p of r.plan.rows) {
    const key = `${p.variant}\t${p.pass}\t${p.stage}\t${p.model}\t${p.maxTokens}`;
    const g = groups.get(key) ?? { variant: p.variant, pass: p.pass, stage: p.stage, count: 0, input: 0, cap: p.maxTokens, expected: 0, worst: 0 };
    g.count += p.count;
    g.input = Math.max(g.input, p.inputEstTokens);
    g.expected += p.expectedUsd;
    g.worst += p.worstCaseUsd;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    rows.push([g.variant, g.pass, g.stage, String(g.count), g.input.toLocaleString("en-US"), String(g.cap), g.expected.toFixed(2), g.worst.toFixed(2)]);
  }
  lines.push(...table(rows));
  lines.push(
    `total: ${r.plan.requests} requests   expected $${r.plan.expectedUsd.toFixed(2)}   worst case $${r.plan.worstCaseUsd.toFixed(2)} ` +
      `(3 attempts × full cap, input ×1.25 margin)`,
  );
  for (const c of r.guards.capChecks.filter((c) => c.provider === "anthropic")) {
    lines.push(`cap check (worst case): anthropic $${c.projectedUsd.toFixed(2)} of $${c.cap.toFixed(2)} — ${c.exceedsCap ? "BLOCKED" : c.exceedsWarn ? "WARN" : "OK"}`);
  }
  lines.push(`a paid run needs: --max-usd ≥ ${r.plan.worstCaseUsd.toFixed(2)} (live spend is also stopped per request by the budget ledger)`);
  return lines;
}

function schemaRows(schema: Readonly<Record<string, SchemaValidity>>): string[] {
  const rows: string[][] = [["stage", "invocations", "first-attempt pass", "pass after retry", "hard fail", "retry rate", "error rate"]];
  for (const [stage, s] of Object.entries(schema)) {
    rows.push([stage, String(s.invocations), pct(s.firstAttemptPass), pct(s.passAfterRetry), pct(s.hardFail), s.retryRate === null ? "n/a" : s.retryRate.toFixed(2), s.errorRate === null ? "n/a" : s.errorRate.toFixed(2)]);
  }
  return table(rows);
}

export function formatMetrics(r: RunRecord): string[] {
  const lines: string[] = [];
  for (const v of r.variants) {
    if (v.metrics === null && v.usage === null && v.wallTime === null) continue;
    lines.push("", `results — variant ${v.label}${v.validity === "valid" ? "" : " (not comparable)"}`);
    if (v.metrics === null) {
      lines.push("  no metrics (the variant did not run)");
    } else if (v.metrics.kind === "validation") {
      const m = v.metrics;
      lines.push(`  claim extraction: assertion coverage ${pct(m.coverage.assertionCoverage)}   relationship coverage ${pct(m.coverage.relationshipCoverage)}`);
      if (m.coverage.hardFailedCases.length > 0) lines.push(`    hard-failed extraction (counted uncovered): ${m.coverage.hardFailedCases.join(", ")}`);
      lines.push(
        `  traceability: fabrication false accept ${pct(m.traceability.fabricationFalseAccept)}   supported false flag ${pct(m.traceability.supportedFalseFlag)}   wrong supporting Unit ${pct(m.traceability.wrongSupportingUnit)}`,
      );
      if (m.traceability.unverifiedFabrications.length > 0) {
        lines.push(`    unverified fabrications (check hard-failed; not counted as caught): ${m.traceability.unverifiedFabrications.join(", ")}`);
      }
      lines.push(`  specificity: false flag ${pct(m.specificity.falseFlag)}   miss ${pct(m.specificity.miss)}`);
      lines.push(`  whole asset: fabrication false accept ${pct(m.asset.fabricationFalseAccept)}   false block ${pct(m.asset.falseBlock)}   errored ${m.asset.errored.length}`);
      lines.push("  schema validity (isolated and whole-asset calls)");
      lines.push(...schemaRows(m.schema));
      lines.push("  per case");
      const rows: string[][] = [["case", "category", "r", "covered", "traceability", "specificity", "asset"]];
      for (const d of m.perCase) rows.push([d.caseId, d.category, String(d.repeat), d.covered, d.traceability, d.specificity, d.asset]);
      lines.push(...table(rows));
    } else {
      const g = v.metrics.generation;
      lines.push(`  ${GENERATION_SCOPE_NOTE}`);
      lines.push(`  schema-valid ${pct(g.schemaValidRate)}   first attempt ${pct(g.firstAttemptRate)}   invented-id retry ${pct(g.inventedIdRetryRate)}`);
      lines.push(`  requirement coverage ${pct(g.requirementCoverage)}   expected-trace recall ${pct(g.expectedTraceRecall)}`);
      lines.push(`  unmatched must-haves (not scored): ${g.unmatchedMustHaves.join(", ") || "none"}`);
      lines.push(
        `  baseline-validator verdict (not ground truth): pass ${pct(g.downstreamPassRate)}   flags ${JSON.stringify(g.downstreamFlagCounts)}`,
      );
      lines.push(...schemaRows(v.metrics.schema));
      for (const d of v.metrics.perSnapshot) lines.push(`  ${d.snapshotId} r${d.repeat}: ${d.detail}`);
    }
    if (v.wallTime !== null) {
      lines.push("  wall time (span, not sum)");
      for (const [stage, s] of Object.entries(v.wallTime.stageSpan)) {
        lines.push(`    ${stage}: span p50 ${s.p50Ms}ms p95 ${s.p95Ms}ms (n=${s.n})   per call p50 ${v.wallTime.perCallLatency[stage]?.p50Ms ?? 0}ms`);
      }
      if (v.wallTime.e2eSpan !== null) {
        lines.push(`    end to end: p50 ${v.wallTime.e2eSpan.p50Ms}ms p95 ${v.wallTime.e2eSpan.p95Ms}ms (n=${v.wallTime.e2eSpan.n})`);
      }
    }
    if (v.usage !== null) {
      const u = v.usage;
      lines.push("  usage");
      lines.push(`    actual ${usd(u.actualUsd)}${u.actualIsEstimated ? " (estimated: unmetered token source)" : ""}   modeled ${usd(u.modeledUsd)}   cost per completed flow ${usd(u.costPerCompletedFlow)}`);
      lines.push(`    provider cache tokens: read ${u.providerCache.read}, write ${u.providerCache.write}`);
      lines.push(`    local replay: ${u.localReplay.calls} calls, modeled ${usd(u.localReplay.modeledUsd)}`);
    }
  }
  return lines;
}

export function formatSubtaskReport(r: RunRecord): string {
  const lines = [...formatHeader(r), ...formatSettings(r), ...formatPlan(r)];
  if (!r.dryRun) {
    lines.push("", `spend: $${r.guards.spentUsd.toFixed(4)} of ${r.guards.maxUsd === null ? "no bound" : `$${r.guards.maxUsd.toFixed(2)}`}${r.guards.budgetReached ? " — BUDGET REACHED, remaining work skipped" : ""}`);
    lines.push(...formatMetrics(r));
  }
  lines.push("", `caveat: ${r.caveat}`);
  return lines.join("\n");
}

