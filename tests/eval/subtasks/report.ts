/**
 * Run metadata and the human report for the subtask suites (#488).
 *
 * The `RunRecord` is what `--report-json` writes: enough to reproduce
 * and compare a run (git sha, token source and fidelity, replay mode,
 * fixture and schema hashes, every setting as sent, every attempt).
 * Two records are comparable only when `comparable` says so. There is
 * no ranking and no recommendation: the labels are drafts until the
 * owner reviews them, and 15 cases cannot carry a promotion decision.
 */

import type { TokenSourceKind } from "../tokenSource.ts";
import type { CapCheck } from "../projection.ts";

import { DRAFT_LABELER, type FixtureFileInfo } from "./fixtures.ts";
import type { CallRecord, InvocationRecord, SubtaskSuite } from "./instrument.ts";
import type {
  AssetMetrics,
  ClusteredRate,
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
import type { ResolvedJudge, ResolvedStageSettings, ResolvedVariant } from "./overrides.ts";
import type { Projection } from "./plan.ts";
import type { ReplayMode } from "./replay.ts";

export const CAVEAT = "15 cases / 2 snapshots cannot support production p95 or reliability claims.";
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
  /**
   * Responses that arrived and were charged but could not be written to
   * the local replay store (full disk, unwritable directory). The run's
   * own results include them; its replay does not.
   */
  readonly replayWriteErrors: number;
  /** False when any response is missing from the replay store: a later `--replay` would miss it. */
  readonly replayComplete: boolean;
  /**
   * The run date every prompt showed (`Today:`; `FIXED_RUN_DATE` in
   * fixtures.ts), never the wall clock. Runs with different dates sent
   * different inputs and are not comparable.
   */
  readonly fixedRunDate: string;
  readonly labels: {
    readonly status: "draft" | "mixed" | "owner-reviewed";
    readonly fixtureSetHash: string;
    readonly files: readonly FixtureFileInfo[];
    /** Primary fixtures (cases or snapshots) and what each derives from. */
    readonly primary: readonly { readonly id: string; readonly path: string; readonly derivedFrom: string | null }[];
  };
  readonly schemas: Readonly<Record<string, string>>;
  /**
   * Generation suite: the pinned downstream validator whose pass rate the
   * run reports (settings and prompt fingerprints, resolved at defaults
   * outside any variant). Null for the validation suite, where the
   * validator is the thing under test and lives in `variants[].resolved`.
   */
  readonly judge: ResolvedJudge | null;
  readonly variants: readonly VariantRecord[];
  readonly guards: {
    readonly maxUsd: number | null;
    readonly projected: { readonly expectedUsd: number; readonly worstCaseUsd: number; readonly requests: number };
    readonly capChecks: readonly CapCheck[];
    /** Replay with no key: every request is served offline or fails, so the caps were checked against $0. */
    readonly offlineReplay: boolean;
    readonly spentUsd: number;
    readonly budgetReached: boolean;
  };
  readonly plan: Projection | null;
  readonly invocations: readonly InvocationRecord[];
  readonly calls: readonly CallRecord[];
  readonly caveat: string;
}

/** Owner-reviewed by the owner: a draft labeler's file never counts, whatever its review_status says. */
function ownerReviewed(f: { readonly review_status: string; readonly labeled_by?: string }): boolean {
  return f.review_status === "owner-reviewed" && f.labeled_by !== DRAFT_LABELER;
}

export function labelStatus(files: readonly { review_status: string; labeled_by?: string }[]): RunRecord["labels"]["status"] {
  if (files.length > 0 && files.every(ownerReviewed)) return "owner-reviewed";
  if (!files.some(ownerReviewed)) return "draft";
  return "mixed";
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The first key whose value differs between two records, or null when equal. */
function firstDifference<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>): string | null {
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (stableJson(a[k]) !== stableJson(b[k])) return k;
  }
  return null;
}

function settingsDifference(
  what: string,
  a: { readonly stages: Readonly<Record<string, ResolvedStageSettings>>; readonly promptVersions: ResolvedVariant["promptVersions"] },
  b: { readonly stages: Readonly<Record<string, ResolvedStageSettings>>; readonly promptVersions: ResolvedVariant["promptVersions"] },
): string | null {
  const stage = firstDifference(a.stages, b.stages);
  if (stage !== null) return `${what}: different settings for stage ${stage} (model, effort, max_tokens or tool choice)`;
  const prompt = firstDifference(a.promptVersions, b.promptVersions);
  if (prompt !== null) {
    return (
      `${what}: different prompt for ${prompt} (${a.promptVersions[prompt]?.fingerprint ?? "absent"} vs ${b.promptVersions[prompt]?.fingerprint ?? "absent"}); ` +
      "a prompt wording change is a new experiment input"
    );
  }
  return null;
}

/**
 * Whether two runs can be compared row for row; the reason when not.
 * Neither may be a dry run (it sent no requests), and every variant
 * label both ran must be `valid` in both. Comparable runs share the
 * suite, fixtures and labels, token source, replay mode, sample count,
 * fixed run date, every enforced tool schema, the settings and prompt
 * fingerprints of each variant label they both ran (baseline always),
 * and, for the generation suite, the judge. A
 * different git sha alone does not refuse the comparison (comparing
 * across commits is the point), but it is returned as a caveat: module
 * code that shapes a request (e.g. how Units are rendered into the
 * prompt) is not covered by a prompt fingerprint.
 */
export function comparable(
  a: RunRecord,
  b: RunRecord,
): { ok: true; caveats: readonly string[] } | { ok: false; reason: string } {
  if (a.dryRun || b.dryRun) return { ok: false, reason: "a dry run sent no requests and has no results to compare" };
  if (a.suite !== b.suite) return { ok: false, reason: `different suites (${a.suite} vs ${b.suite})` };
  if (a.labels.fixtureSetHash !== b.labels.fixtureSetHash) {
    return { ok: false, reason: "different fixtureSetHash: labels or fixtures changed (a relabel invalidates comparison)" };
  }
  if (a.tokenSource !== b.tokenSource) return { ok: false, reason: `different token sources (${a.tokenSource} vs ${b.tokenSource})` };
  if ((a.cacheMode === "replay") !== (b.cacheMode === "replay")) {
    return { ok: false, reason: "one run replayed local outputs and the other ran live" };
  }
  if (a.samples !== b.samples) return { ok: false, reason: `different samples per case (${a.samples} vs ${b.samples})` };
  if (a.fixedRunDate !== b.fixedRunDate) {
    return { ok: false, reason: `different fixed run dates (${a.fixedRunDate} vs ${b.fixedRunDate}): the prompts showed a different Today` };
  }
  const schema = firstDifference(a.schemas, b.schemas);
  if (schema !== null) return { ok: false, reason: `different enforced tool schema for ${schema}` };
  const baseA = a.variants.find((v) => v.label === "baseline");
  const baseB = b.variants.find((v) => v.label === "baseline");
  if (baseA === undefined || baseB === undefined) return { ok: false, reason: "a run has no baseline variant" };
  for (const va of a.variants) {
    const vb = b.variants.find((v) => v.label === va.label);
    if (vb === undefined) continue;
    for (const v of [va, vb]) {
      if (v.validity !== "valid") return { ok: false, reason: `variant ${v.label} is ${v.validity} in run ${v === va ? a.runId : b.runId}` };
    }
    const diff = settingsDifference(`variant ${va.label}`, va.resolved, vb.resolved);
    if (diff !== null) return { ok: false, reason: diff };
  }
  if (a.suite === "generation") {
    if (a.judge === null || b.judge === null) return { ok: false, reason: "a generation run did not record its judge (the pinned validator)" };
    const diff = settingsDifference("judge", a.judge, b.judge);
    if (diff !== null) return { ok: false, reason: `${diff}; the downstream pass rates come from different validators` };
  }
  const caveats: string[] = [];
  if (a.git.sha === null || b.git.sha === null || a.git.sha !== b.git.sha || a.git.dirty === true || b.git.dirty === true) {
    caveats.push(
      `different or unknown git state (${a.git.sha?.slice(0, 7) ?? "unknown"}${a.git.dirty === true ? " dirty" : ""} vs ` +
        `${b.git.sha?.slice(0, 7) ?? "unknown"}${b.git.dirty === true ? " dirty" : ""}): prompts, schemas and settings match, ` +
        "but module code that builds a request is not fingerprinted",
    );
  }
  return { ok: true, caveats };
}

// -- Formatting --------------------------------------------------------------------

function pct(r: Ratio | null): string {
  if (r === null) return "n/a";
  return r.value === null ? `— (0/0)` : `${(r.value * 100).toFixed(1)}% (${r.num}/${r.den})`;
}

function pct1(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * A clustered rate: the distinct count (assertions or cases) with its
 * Wilson 95% interval, and the pooled sample count when repeats exist.
 */
export function rate(r: ClusteredRate, unit: "assertions" | "cases"): string {
  if (r.units.value === null) return `— (0/0 ${unit})`;
  const ci = r.interval === null ? "" : `, 95% CI ${pct1(r.interval.low)}–${pct1(r.interval.high)}`;
  const samples = r.samples.den !== r.units.den ? `; ${r.samples.num}/${r.samples.den} samples` : "";
  return `${pct1(r.units.value)} (${r.units.num}/${r.units.den} ${unit}${ci}${samples})`;
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
    const drafts = r.labels.primary.filter((p) => {
      const f = r.labels.files.find((x) => x.path === p.path);
      return f === undefined || !ownerReviewed(f);
    });
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
  if (r.replayWriteErrors > 0 || !r.replayComplete) {
    lines.push(
      `REPLAY INCOMPLETE — ${r.replayWriteErrors} replay write error${r.replayWriteErrors === 1 ? "" : "s"}: ` +
        "the responses were kept and scored here, but are not in the replay store; a later --replay misses them",
    );
  }
  lines.push(...banner(r));
  lines.push(r.suite === "validation" ? ONBOARDING_NOTE : `${GENERATION_SCOPE_NOTE} ${ONBOARDING_NOTE}`);
  lines.push(`fixtureSetHash ${r.labels.fixtureSetHash}   (comparable only with runs that share this hash)`);
  lines.push(`run date shown to the model (Today:) ${r.fixedRunDate.slice(0, 10)}, fixed, never the wall clock`);
  lines.push("");
  lines.push("fixtures");
  const rows: string[][] = [["path", "label_version", "review_status", "labeled_by", "sha256"]];
  for (const f of r.labels.files) rows.push([f.path, String(f.label_version), f.review_status, f.labeled_by, short(f.sha256)]);
  lines.push(...table(rows));
  lines.push("");
  lines.push("schemas");
  for (const [k, v] of Object.entries(r.schemas)) lines.push(`  ${k}  sha256 ${short(v)}`);
  if (r.judge !== null) {
    lines.push("");
    lines.push("judge (baseline validator, pinned to production defaults; comparable only with runs that share it)");
    const rows: string[][] = [["stage", "model", "effort", "max_tokens", "tool_choice", "prompt"]];
    for (const [stage, s] of Object.entries(r.judge.stages)) {
      const key = Object.keys(r.judge.promptVersions).find((k) => promptStage(k) === stage);
      rows.push([stage, s.model, s.effort ?? "-", String(s.maxTokens), s.toolChoice, key === undefined ? "-" : `${key} ${r.judge.promptVersions[key]!.fingerprint}`]);
    }
    lines.push(...table(rows));
  }
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
  const rows: string[][] = [["variant", "pass", "stage", "requests", "max est input tok/req", "output cap", "expected USD", "conservative USD"]];
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
    `total: ${r.plan.requests} requests   expected $${r.plan.expectedUsd.toFixed(2)}   conservative estimate $${r.plan.worstCaseUsd.toFixed(2)} ` +
      `(3 attempts × full cap, input ×1.25 margin; claim and item counts are heuristics, so not a bound)`,
  );
  for (const c of r.guards.capChecks.filter((c) => c.provider === "anthropic")) {
    lines.push(
      `cap check (conservative estimate${r.guards.offlineReplay ? "; offline replay, no live request possible" : ""}): ` +
        `anthropic $${c.projectedUsd.toFixed(2)} of $${c.cap.toFixed(2)} — ${c.exceedsCap ? "BLOCKED" : c.exceedsWarn ? "WARN" : "OK"}`,
    );
  }
  lines.push(`a paid run needs: --max-usd ≥ ${r.plan.worstCaseUsd.toFixed(2)}; the budget ledger is the actual stop, checked before every request`);
  return lines;
}

function schemaRows(schema: Readonly<Record<string, SchemaValidity>>): string[] {
  const rows: string[][] = [
    ["stage", "invocations", "first-attempt pass", "pass after retry", "hard fail", "retry rate", "error rate", "no call", "cancelled", "budget stop"],
  ];
  for (const [stage, s] of Object.entries(schema)) {
    rows.push([
      stage,
      String(s.invocations),
      pct(s.firstAttemptPass),
      pct(s.passAfterRetry),
      pct(s.hardFail),
      s.retryRate === null ? "n/a" : s.retryRate.toFixed(2),
      s.errorRate === null ? "n/a" : s.errorRate.toFixed(2),
      String(s.deterministic + s.failedBeforeRequest),
      String(s.cancelled),
      String(s.budgetStopped),
    ]);
  }
  const lines = table(rows);
  lines.push(
    "  (rates count invocations that made a model call; \"no call\" finished or failed without one, \"cancelled\" were aborted by the call pool after another call failed, \"budget stop\" were stopped by --max-usd)",
  );
  return lines;
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
      lines.push(
        `  claim extraction: assertion coverage ${pct(m.coverage.assertionCoverage)} (one claim per assertion)   ` +
          `fused claims ${m.coverage.fusedClaims}   relationship coverage ${pct(m.coverage.relationshipCoverage)}`,
      );
      if (m.coverage.hardFailedCases.length > 0) {
        lines.push(`    hard-failed extraction (not counted; see schema validity): ${m.coverage.hardFailedCases.join(", ")}`);
        lines.push(
          `    end to end, hard fails scored as zero: assertion coverage ${pct(m.coverage.assertionCoverageHardFailsAsZero)}   ` +
            `relationship coverage ${pct(m.coverage.relationshipCoverageHardFailsAsZero)}`,
        );
      }
      if (m.coverage.stoppedCases.length > 0) lines.push(`    budget-stopped extraction (not counted): ${m.coverage.stoppedCases.join(", ")}`);
      lines.push(`  traceability: fabrication false accept ${rate(m.traceability.fabricationFalseAccept, "assertions")}`);
      lines.push(`    supported false flag ${rate(m.traceability.supportedFalseFlag, "assertions")}`);
      lines.push(`    wrong supporting Unit ${rate(m.traceability.wrongSupportingUnit, "assertions")}`);
      if (m.traceability.unverifiedFabrications.length > 0) {
        lines.push(`    unverified fabrications (check hard-failed; not counted as caught): ${m.traceability.unverifiedFabrications.join(", ")}`);
      }
      lines.push(`  specificity: false flag ${rate(m.specificity.falseFlag, "assertions")}   miss ${rate(m.specificity.miss, "assertions")}`);
      lines.push(`  whole asset: fabrication false accept ${rate(m.asset.fabricationFalseAccept, "cases")}`);
      lines.push(`    specificity false accept ${rate(m.asset.specificityFalseAccept, "cases")}`);
      lines.push(
        `    false block ${rate(m.asset.falseBlock, "cases")}   errored ${m.asset.errored.length}${m.asset.stopped.length > 0 ? `   budget-stopped ${m.asset.stopped.length}` : ""}`,
      );
      lines.push("  schema validity (isolated and whole-asset calls)");
      lines.push(...schemaRows(m.schema));
      lines.push("  per case");
      const rows: string[][] = [["case", "category", "r", "covered", "traceability", "specificity", "asset"]];
      for (const d of m.perCase) rows.push([d.caseId, d.category, String(d.repeat), d.covered, d.traceability, d.specificity, d.asset]);
      lines.push(...table(rows));
    } else {
      const g = v.metrics.generation;
      lines.push(`  ${GENERATION_SCOPE_NOTE}`);
      lines.push(
        `  schema-valid ${pct(g.schemaValidRate)}   first attempt ${pct(g.firstAttemptRate)}   invented-id retry ${pct(g.inventedIdRetryRate)}` +
          (g.budgetStopped > 0 ? `   budget-stopped flows (not counted) ${g.budgetStopped}` : ""),
      );
      lines.push(`  requirement coverage ${pct(g.requirementCoverage)}   expected-trace recall ${pct(g.expectedTraceRecall)}`);
      lines.push(`  unmatched must-haves (not scored): ${g.unmatchedMustHaves.join(", ") || "none"}`);
      lines.push(
        `  baseline-validator verdict (not ground truth): pass ${pct(g.downstreamPassRate)}   flags ${JSON.stringify(g.downstreamFlagCounts)}`,
      );
      lines.push(...schemaRows(v.metrics.schema));
      for (const d of v.metrics.perSnapshot) lines.push(`  ${d.snapshotId} r${d.repeat}: ${d.detail}`);
    }
    if (v.wallTime !== null) {
      lines.push("  wall time (span, not sum; live calls only)");
      for (const [key, s] of Object.entries(v.wallTime.stageSpan)) {
        lines.push(`    ${key}: span p50 ${s.p50Ms}ms p95 ${s.p95Ms}ms (n=${s.n})   per call p50 ${v.wallTime.perCallLatency[key]?.p50Ms ?? 0}ms`);
      }
      if (v.wallTime.e2eSpan !== null) {
        const what = r.suite === "validation" ? "validateAsset, whole-asset pass" : "generation + baseline validation";
        lines.push(`    end to end (${what}): p50 ${v.wallTime.e2eSpan.p50Ms}ms p95 ${v.wallTime.e2eSpan.p95Ms}ms (n=${v.wallTime.e2eSpan.n})`);
      }
    }
    if (v.usage !== null) {
      const u = v.usage;
      lines.push("  usage");
      lines.push(`    actual ${usd(u.actualUsd)}${u.actualIsEstimated ? " (estimated: unmetered token source)" : ""}   modeled ${usd(u.modeledUsd)} (all passes)`);
      lines.push(`    cost per ${u.perFlow.label} ${u.perFlow.flows === 0 ? "n/a (none completed)" : usd(u.perFlow.usd)} (n=${u.perFlow.flows})`);
      if (u.modeledByPass.isolated !== undefined) {
        lines.push(`    isolated pass (evaluation only, not a production cost) modeled ${usd(u.modeledByPass.isolated)}`);
      }
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

