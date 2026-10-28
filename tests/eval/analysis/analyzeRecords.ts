/**
 * Core of `eval:analyze`: per-arm summaries and incumbent-versus-candidate
 * comparisons over recorded flows. Pure: flows and labels come in, a
 * result object and Markdown go out. Deterministic for a given seed.
 *
 * An arm is a variant label; flows from several invocations with the
 * same label pool into one arm. Task metrics come from every flow whose
 * task stage returned (`units !== null` for extraction, `requirements
 * !== null` for jd), so a later-stage outage does not remove a valid
 * sample; match accuracy comes from successful flows only. A flow that
 * replayed its task stage from the stage cache with the same output as
 * another flow of the arm and cell is not an independent sample, so its
 * task metrics are left out. Every aggregate weights cells equally, so an
 * unbalanced cell mix cannot move a mean.
 */

import { priceUsage, type UsageRecord } from "../../../functions/src/llm/cost.ts";
import type { FlowRecord, RecordedCall } from "../flowRecord.ts";

import {
  extractionMetrics,
  jdMetrics,
  METRICS,
  type ExtractionLabels,
  type JdLabels,
  type MetricDef,
  type MetricValues,
  type Task,
} from "./metrics.ts";
import {
  cellWeightedDiff,
  commonCells,
  DEFAULT_RESAMPLES,
  DEFAULT_SEED,
  equalCellWeightMean,
  mean,
  minMax,
  nearestRankPercentile,
  pooledWithinCellSd,
  powerCheck,
  sampleSd,
  stratifiedBootstrapCi,
  stratifiedWelchTTest,
  type CellValues,
  type PowerCheck,
} from "./stats.ts";

export interface AnalysisLabels {
  /** Extraction labels by résumé id. */
  readonly units?: ReadonlyMap<string, ExtractionLabels>;
  /** JD labels by cell id (`<resume>__<jd>`). */
  readonly requirements?: ReadonlyMap<string, JdLabels>;
}

export interface AnalyzeOptions {
  readonly task: Task;
  readonly incumbent: string;
  /** Defaults to every other arm in the records, sorted. */
  readonly candidates?: readonly string[];
  readonly labels: AnalysisLabels;
  readonly seed?: number;
  readonly resamples?: number;
}

export interface CellStat {
  readonly n: number;
  readonly mean: number | null;
  readonly sd: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

export interface CellSummary {
  readonly cell: string;
  readonly flows: number;
  readonly successful: number;
  /** Flows whose task-stage metrics count (task output present, not a repeated replay). */
  readonly scored: number;
  readonly metrics: Readonly<Record<string, CellStat>>;
}

export interface StepLatency {
  readonly step: string;
  readonly calls: number;
  readonly p50Ms: number | null;
  readonly maxMs: number | null;
}

export interface StepCost {
  readonly step: string;
  /** Σ list-price cost of the step's records (replayed included) / flows in the arm. */
  readonly perFlowUsd: number;
  readonly unpricedRecords: number;
}

export interface ArmSummary {
  readonly label: string;
  readonly invocations: readonly string[];
  /** Distinct per-stage configurations seen under this label. */
  readonly configs: number;
  readonly flows: number;
  readonly failedFlows: number;
  /** Failed flows whose error kind is `refusal`. */
  readonly refusals: number;
  /** Failed flows that failed in the task's own stage (extraction / requirement_parsing). */
  readonly taskStepFailures: number;
  /** Flows whose task stage returned an output, whether or not a later stage failed. */
  readonly taskOutputFlows: number;
  /** Flows that replayed the task stage from the stage cache. */
  readonly replayedTaskFlows: number;
  /** Replayed flows left out of the task metrics because their output repeats another flow's in the same cell. */
  readonly repeatedReplays: number;
  /** Flows that replayed both extraction and requirement parsing with a counted flow's outputs; their match accuracy is left out. */
  readonly repeatedMatchReplays: number;
  readonly errorKinds: Readonly<Record<string, number>>;
  /** Live (non-replayed) usage records. */
  readonly records: number;
  readonly replayedRecords: number;
  /** Live records with attempt > 0 / live records. */
  readonly retryShare: number | null;
  /** Live records flagged truncated. */
  readonly truncations: number;
  /** Live records flagged refusal. */
  readonly refusalRecords: number;
  readonly cells: readonly CellSummary[];
  /** Equal-cell-weight mean per metric. */
  readonly aggregate: Readonly<Record<string, number | null>>;
  readonly latency: readonly StepLatency[];
  readonly stageCost: readonly StepCost[];
  readonly modeledCostPerFlowUsd: number | null;
}

export interface CellDiff {
  readonly cell: string;
  readonly diff: number;
}

export interface Comparison {
  readonly candidate: string;
  readonly metric: string;
  /** Equal-cell-weight difference of means (candidate − incumbent) over common cells. */
  readonly diff: number | null;
  readonly ci95: { readonly lo: number; readonly hi: number } | null;
  /**
   * Two-sided p of the stratified Welch test of `diff` (same estimand).
   * Null when a common cell has fewer than two values in either arm.
   */
  readonly welchP: number | null;
  readonly commonCells: number;
  readonly cellDiffs: readonly CellDiff[];
  /** Common cells where the candidate's cell mean is higher. */
  readonly cellsAhead: number;
  /**
   * Cells both arms ran (any flow) where one arm has values for this
   * metric and the other has none, e.g. every candidate flow refused.
   */
  readonly droppedCells: readonly string[];
  /**
   * Guards this comparison fails. When non-empty, `diff`, `ci95` and
   * `welchP` are null: a figure over the surviving cells would favour an
   * arm that produced nothing in a hard cell.
   */
  readonly failedGuards: readonly string[];
}

/** Guard: a cell both arms ran has values for this metric in one arm only. */
export const RAN_CELL_NO_VALUES = "ran-cell-no-values";

export interface PowerRow extends Partial<PowerCheck> {
  readonly metric: string;
  readonly available: boolean;
}

export interface AnalysisResult {
  readonly task: Task;
  readonly incumbent: string;
  readonly candidates: readonly string[];
  readonly seed: number;
  readonly resamples: number;
  readonly flows: number;
  readonly invocations: readonly string[];
  readonly metrics: readonly MetricDef[];
  readonly arms: readonly ArmSummary[];
  readonly comparisons: readonly Comparison[];
  readonly power: readonly PowerRow[];
  readonly warnings: readonly string[];
}

/** Sort key that makes every downstream order independent of input order. */
function compareFlows(a: FlowRecord, b: FlowRecord): number {
  return (
    a.cell.localeCompare(b.cell) ||
    a.invocationId.localeCompare(b.invocationId) ||
    a.sampleIndex - b.sampleIndex ||
    a.startedAt.localeCompare(b.startedAt)
  );
}

/** The step whose output a task scores. */
export const TASK_STEP: Readonly<Record<Task, string>> = { extraction: "extraction", jd: "requirement_parsing" };

/** Metrics computed from the task stage's output (everything but the reported match accuracy). */
const isTaskMetric = (metric: string): boolean => metric !== "match_accuracy";

function taskOutput(flow: FlowRecord, task: Task): readonly unknown[] | null {
  return task === "extraction" ? flow.units : flow.requirements;
}

function replayedTaskStep(flow: FlowRecord, task: Task): boolean {
  // Records parsed from disk may predate `stepCacheHits`.
  const hits = (flow.stepCacheHits as Readonly<Record<string, boolean>> | undefined) ?? {};
  return hits[TASK_STEP[task]] === true;
}

/**
 * A flow that replayed both scored stages (extraction and requirement
 * parsing) from the stage cache. Matching then runs on inputs a counted
 * flow may already have had, so its match accuracy can be a copy.
 */
function replayedBothSides(flow: FlowRecord): boolean {
  const hits = (flow.stepCacheHits as Readonly<Record<string, boolean>> | undefined) ?? {};
  return hits[TASK_STEP.extraction] === true && hits[TASK_STEP.jd] === true;
}

/** The matching inputs a flow scored: its saved Units and Requirements. */
function matchInputKey(flow: FlowRecord): string {
  return JSON.stringify([flow.units, flow.requirements]);
}

interface ScoredFlows {
  readonly perFlow: { flow: FlowRecord; values: MetricValues }[];
  readonly taskOutputFlows: number;
  readonly replayedTaskFlows: number;
  readonly repeatedReplays: number;
  readonly repeatedMatchReplays: number;
}

/**
 * The per-flow metric values an arm contributes. Task metrics need only
 * the task stage's output; match accuracy is null on a failed flow and
 * drops out by itself. A replayed flow whose saved output equals a live
 * flow's, or an earlier replay's, in the same cell keeps only match
 * accuracy: its task value repeats a sample already counted. Match
 * accuracy is dropped the same way, but only for a flow that replayed
 * both extraction and requirement parsing and whose (Units, Requirements)
 * pair equals a counted flow's in the same cell: matching then ran on
 * identical inputs. A live parse of either side gives a new match sample.
 */
function scoreArm(flows: readonly FlowRecord[], task: Task, labels: AnalysisLabels): ScoredFlows {
  const liveOutputs = new Map<string, Set<string>>();
  for (const f of flows) {
    const out = taskOutput(f, task);
    if (out === null || replayedTaskStep(f, task)) continue;
    const set = liveOutputs.get(f.cell) ?? new Set<string>();
    set.add(JSON.stringify(out));
    liveOutputs.set(f.cell, set);
  }
  const liveMatchInputs = new Map<string, Set<string>>();
  for (const f of flows) {
    if (f.matchAccuracy === null || replayedBothSides(f)) continue;
    const set = liveMatchInputs.get(f.cell) ?? new Set<string>();
    set.add(matchInputKey(f));
    liveMatchInputs.set(f.cell, set);
  }
  const replaysKept = new Map<string, Set<string>>();
  const matchReplaysKept = new Map<string, Set<string>>();
  const perFlow: { flow: FlowRecord; values: MetricValues }[] = [];
  let taskOutputFlows = 0;
  let replayedTaskFlows = 0;
  let repeatedReplays = 0;
  let repeatedMatchReplays = 0;
  for (const flow of flows) {
    const out = taskOutput(flow, task);
    if (out === null) continue;
    taskOutputFlows += 1;
    let values = flowMetrics(flow, task, labels);
    if (replayedTaskStep(flow, task)) {
      replayedTaskFlows += 1;
      const key = JSON.stringify(out);
      const kept = replaysKept.get(flow.cell) ?? new Set<string>();
      replaysKept.set(flow.cell, kept);
      if (liveOutputs.get(flow.cell)?.has(key) === true || kept.has(key)) {
        repeatedReplays += 1;
        values = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, isTaskMetric(k) ? null : v]));
      } else {
        kept.add(key);
      }
    }
    if (values.match_accuracy !== null && values.match_accuracy !== undefined && replayedBothSides(flow)) {
      const key = matchInputKey(flow);
      const kept = matchReplaysKept.get(flow.cell) ?? new Set<string>();
      matchReplaysKept.set(flow.cell, kept);
      if (liveMatchInputs.get(flow.cell)?.has(key) === true || kept.has(key)) {
        repeatedMatchReplays += 1;
        values = { ...values, match_accuracy: null };
      } else {
        kept.add(key);
      }
    }
    perFlow.push({ flow, values });
  }
  return { perFlow, taskOutputFlows, replayedTaskFlows, repeatedReplays, repeatedMatchReplays };
}

function flowMetrics(flow: FlowRecord, task: Task, labels: AnalysisLabels): MetricValues {
  if (task === "extraction") {
    const l = labels.units?.get(flow.resumeId);
    if (l === undefined) throw new Error(`no expected-units labels for résumé ${flow.resumeId}`);
    return extractionMetrics(flow, l);
  }
  const l = labels.requirements?.get(flow.cell);
  if (l === undefined) throw new Error(`no expected-matches labels for cell ${flow.cell}`);
  return jdMetrics(flow, l);
}

function liveCalls(flows: readonly FlowRecord[]): RecordedCall[] {
  return flows.flatMap((f) => f.calls.filter((c) => !c.replayed));
}

function priceRecord(call: RecordedCall): number | null {
  try {
    return priceUsage(call as UsageRecord).costUsd;
  } catch {
    return null;
  }
}

/** Per-flow metric values of an arm, grouped by cell. */
function cellValues(perFlow: readonly { flow: FlowRecord; values: MetricValues }[], metric: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const { flow, values } of perFlow) {
    const v = values[metric];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const list = out.get(flow.cell) ?? [];
    list.push(v);
    out.set(flow.cell, list);
  }
  return out;
}

function summarizeArm(
  label: string,
  flows: readonly FlowRecord[],
  scoredArm: ScoredFlows,
  metrics: readonly MetricDef[],
  task: Task,
): ArmSummary {
  const { perFlow } = scoredArm;
  const failed = flows.filter((f) => !f.ok);
  const errorKinds: Record<string, number> = {};
  for (const f of failed) {
    const kind = f.error?.kind ?? "error";
    errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
  }
  const live = liveCalls(flows);
  const replayed = flows.reduce((n, f) => n + f.calls.filter((c) => c.replayed).length, 0);

  const cellIds = [...new Set(flows.map((f) => f.cell))].sort();
  const cells: CellSummary[] = cellIds.map((cell) => {
    const inCell = flows.filter((f) => f.cell === cell);
    const stats: Record<string, CellStat> = {};
    for (const m of metrics) {
      const values = cellValues(perFlow, m.id).get(cell) ?? [];
      const mm = minMax(values);
      stats[m.id] = { n: values.length, mean: mean(values), sd: sampleSd(values), min: mm?.min ?? null, max: mm?.max ?? null };
    }
    const scoredInCell = perFlow.filter(
      (p) => p.flow.cell === cell && Object.entries(p.values).some(([k, v]) => isTaskMetric(k) && v !== null),
    ).length;
    return {
      cell,
      flows: inCell.length,
      successful: inCell.filter((f) => f.ok).length,
      scored: scoredInCell,
      metrics: stats,
    };
  });

  const aggregate: Record<string, number | null> = {};
  for (const m of metrics) aggregate[m.id] = equalCellWeightMean(cellValues(perFlow, m.id));

  const steps = [...new Set(flows.flatMap((f) => f.calls.map((c) => c.step)))].sort();
  const latency: StepLatency[] = steps.map((step) => {
    const ms = live.filter((c) => c.step === step).map((c) => c.latencyMs);
    return { step, calls: ms.length, p50Ms: nearestRankPercentile(ms, 0.5), maxMs: minMax(ms)?.max ?? null };
  });
  const stageCost: StepCost[] = steps.map((step) => {
    let total = 0;
    let unpriced = 0;
    for (const f of flows) {
      for (const c of f.calls) {
        if (c.step !== step) continue;
        const cost = priceRecord(c);
        if (cost === null) unpriced += 1;
        else total += cost;
      }
    }
    return { step, perFlowUsd: flows.length === 0 ? 0 : total / flows.length, unpricedRecords: unpriced };
  });

  return {
    label,
    invocations: [...new Set(flows.map((f) => f.invocationId))].sort(),
    configs: new Set(flows.map((f) => JSON.stringify([f.tokenSource ?? null, f.stages]))).size,
    flows: flows.length,
    failedFlows: failed.length,
    refusals: failed.filter((f) => f.error?.kind === "refusal").length,
    taskStepFailures: failed.filter((f) => f.error?.step === TASK_STEP[task]).length,
    taskOutputFlows: scoredArm.taskOutputFlows,
    replayedTaskFlows: scoredArm.replayedTaskFlows,
    repeatedReplays: scoredArm.repeatedReplays,
    repeatedMatchReplays: scoredArm.repeatedMatchReplays,
    errorKinds,
    records: live.length,
    replayedRecords: replayed,
    retryShare: live.length === 0 ? null : live.filter((c) => c.retry).length / live.length,
    truncations: live.filter((c) => c.truncated).length,
    refusalRecords: live.filter((c) => c.refusal).length,
    cells,
    aggregate,
    latency,
    stageCost,
    modeledCostPerFlowUsd: flows.length === 0 ? null : flows.reduce((a, f) => a + f.modeledCostUsd, 0) / flows.length,
  };
}

export function analyzeRecords(input: readonly FlowRecord[], options: AnalyzeOptions): AnalysisResult {
  const seed = options.seed ?? DEFAULT_SEED;
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const metrics = METRICS[options.task];
  const flows = [...input].sort(compareFlows);
  const labelsPresent = [...new Set(flows.map((f) => f.variant))].sort();
  if (!labelsPresent.includes(options.incumbent)) {
    throw new Error(
      `incumbent ${JSON.stringify(options.incumbent)} has no recorded flows; arms present: ${labelsPresent.join(", ") || "(none)"}`,
    );
  }
  const candidates = options.candidates ?? labelsPresent.filter((l) => l !== options.incumbent);
  for (const c of candidates) {
    if (!labelsPresent.includes(c)) {
      throw new Error(`candidate ${JSON.stringify(c)} has no recorded flows; arms present: ${labelsPresent.join(", ")}`);
    }
    if (c === options.incumbent) throw new Error(`candidate ${JSON.stringify(c)} is also the incumbent`);
  }
  const armLabels = [options.incumbent, ...candidates];
  const warnings: string[] = [];

  const perFlowByArm = new Map<string, { flow: FlowRecord; values: MetricValues }[]>();
  const arms: ArmSummary[] = armLabels.map((label) => {
    const armFlows = flows.filter((f) => f.variant === label);
    const scoredArm = scoreArm(armFlows, options.task, options.labels);
    perFlowByArm.set(label, scoredArm.perFlow);
    const summary = summarizeArm(label, armFlows, scoredArm, metrics, options.task);
    if (summary.configs > 1) {
      warnings.push(
        `${label}: ${summary.configs} different stage configurations (or token sources) share this label; the arm pools them.`,
      );
    }
    if (scoredArm.perFlow.length === 0) {
      warnings.push(`${label}: no flow returned a ${TASK_STEP[options.task]} output, so no metric values.`);
    }
    if (scoredArm.replayedTaskFlows > 0) {
      warnings.push(
        `${label}: ${scoredArm.replayedTaskFlows} flow(s) replayed the ${TASK_STEP[options.task]} output from the stage cache; ` +
          `${scoredArm.repeatedReplays} repeat an earlier sample's output in the same cell and are left out of the task metrics ` +
          `(match accuracy kept unless the flow also replayed the other stage; see below). Record with --no-cache or --samples > 1 to measure variance.`,
      );
    }
    if (scoredArm.repeatedMatchReplays > 0) {
      warnings.push(
        `${label}: ${scoredArm.repeatedMatchReplays} flow(s) replayed both extraction and requirement parsing with the same ` +
          `outputs as a counted flow in the same cell; their match accuracy is a copy and is left out.`,
      );
    }
    return summary;
  });

  const valuesOf = (label: string, metric: string): CellValues => cellValues(perFlowByArm.get(label) ?? [], metric);
  const comparisons: Comparison[] = [];
  for (const candidate of candidates) {
    const incCells = new Set(arms[0]!.cells.map((c) => c.cell));
    const candCells = new Set(arms.find((a) => a.label === candidate)!.cells.map((c) => c.cell));
    const onlyOne = [...incCells, ...candCells].filter((c) => !(incCells.has(c) && candCells.has(c)));
    if (onlyOne.length > 0) {
      warnings.push(`${candidate}: compared on common cells only; ${[...new Set(onlyOne)].sort().join(", ")} held by one arm.`);
    }
    // Cells both arms ran (any flow), whatever their metric values.
    const ranBoth = [...incCells].filter((c) => candCells.has(c)).sort();
    for (const m of metrics) {
      const inc = valuesOf(options.incumbent, m.id);
      const cand = valuesOf(candidate, m.id);
      const cells = commonCells(inc, cand);
      const withValues = new Set(cells);
      const has = (v: CellValues, cell: string): boolean => (v.get(cell)?.length ?? 0) > 0;
      const missing = ranBoth.filter((c) => !withValues.has(c));
      // One arm has values, the other none: comparing on the rest would
      // favour the arm that produced nothing there.
      const droppedCells = missing.filter((c) => has(inc, c) || has(cand, c));
      // Neither arm has values: the metric is undefined there for both, so
      // dropping the cell treats them alike; say so without failing a guard.
      const neither = missing.filter((c) => !has(inc, c) && !has(cand, c));
      const failedGuards = droppedCells.length > 0 ? [RAN_CELL_NO_VALUES] : [];
      if (droppedCells.length > 0) {
        const detail = droppedCells
          .map((c) => `${c} (no values for ${has(inc, c) ? candidate : options.incumbent})`)
          .join(", ");
        warnings.push(
          `${candidate} ${m.id}: ${detail} ran in both arms but has values in one only; difference, CI and p ` +
            `are withheld rather than computed on the other cells (guard ${RAN_CELL_NO_VALUES}).`,
        );
      }
      if (neither.length > 0) {
        warnings.push(`${candidate} ${m.id}: ${neither.join(", ")} ran in both arms but has no values in either; compared without it.`);
      }
      const cellDiffs = cells.map((cell) => ({ cell, diff: mean(cand.get(cell)!)! - mean(inc.get(cell)!)! }));
      const guarded = failedGuards.length > 0;
      comparisons.push({
        candidate,
        metric: m.id,
        diff: guarded ? null : cellWeightedDiff(inc, cand),
        ci95: guarded ? null : stratifiedBootstrapCi(inc, cand, { seed, resamples }),
        welchP: guarded ? null : (stratifiedWelchTTest(inc, cand)?.p ?? null),
        commonCells: cells.length,
        cellDiffs,
        cellsAhead: cellDiffs.filter((d) => d.diff > 0).length,
        droppedCells,
        failedGuards,
      });
    }
  }

  const power: PowerRow[] = metrics.map((m) => {
    const inc = valuesOf(options.incumbent, m.id);
    const s = pooledWithinCellSd(inc);
    if (s === null) return { metric: m.id, available: false };
    return { metric: m.id, available: true, ...powerCheck(s, inc.size, m.share) };
  });

  return {
    task: options.task,
    incumbent: options.incumbent,
    candidates,
    seed,
    resamples,
    flows: flows.length,
    invocations: [...new Set(flows.map((f) => f.invocationId))].sort(),
    metrics,
    arms,
    comparisons,
    power,
    warnings,
  };
}

// -- Markdown ------------------------------------------------------------------

function fmtMetric(def: MetricDef, v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sign = signed && v > 0 ? "+" : "";
  return def.share ? `${sign}${(v * 100).toFixed(1)}` : `${sign}${v.toFixed(2)}`;
}

const fmtShare = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const fmtP = (p: number | null): string => (p === null ? "—" : p < 0.001 ? "<0.001" : p.toFixed(3));
const fmtMs = (v: number | null): string => (v === null ? "—" : `${Math.round(v)}`);
const fmtN = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : String(v));

/** Markdown report. Ids, labels and numbers only: no Unit or requirement text. */
export function formatAnalysisMarkdown(result: AnalysisResult): string {
  const defs = new Map(result.metrics.map((m) => [m.id, m]));
  const lines: string[] = [];
  lines.push(`# eval:analyze — ${result.task} task`);
  lines.push("");
  lines.push(
    `Incumbent \`${result.incumbent}\`; candidates ${result.candidates.map((c) => `\`${c}\``).join(", ") || "(none)"}. ` +
      `${result.flows} flow(s) from ${result.invocations.length} invocation(s). ` +
      `Share metrics in points (×100). Bootstrap: ${result.resamples} stratified resamples, seed ${result.seed}.`,
  );
  if (result.warnings.length > 0) {
    lines.push("");
    for (const w of result.warnings) lines.push(`- Warning: ${w}`);
  }

  lines.push("", "## Arms", "");
  lines.push(
    "| arm | flows | failed | in task step | refusals | error kinds | task outputs | replayed task outputs | repeated replays dropped | repeated match replays dropped | " +
      "live records | retry share | truncations | replayed records | invocations | configs | modeled $/flow |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of result.arms) {
    const kinds = Object.entries(a.errorKinds).sort(([x], [y]) => x.localeCompare(y)).map(([k, n]) => `${k} ${n}`).join(", ") || "—";
    lines.push(
      `| ${a.label} | ${a.flows} | ${a.failedFlows} | ${a.taskStepFailures} | ${a.refusals} | ${kinds} | ` +
        `${a.taskOutputFlows} | ${a.replayedTaskFlows} | ${a.repeatedReplays} | ${a.repeatedMatchReplays} | ${a.records} | ${fmtShare(a.retryShare)} | ` +
        `${a.truncations} | ${a.replayedRecords} | ${a.invocations.length} | ${a.configs} | ` +
        `${a.modeledCostPerFlowUsd === null ? "—" : `$${a.modeledCostPerFlowUsd.toFixed(4)}`} |`,
    );
  }

  lines.push(
    "",
    "## Metrics",
    "",
    "Aggregate = mean of cell means. Cells show mean ± SD [min–max] (n flows). Task metrics count every flow whose " +
      "task stage returned, less repeated cache replays; match accuracy counts successful flows.",
  );
  const allCells = [...new Set(result.arms.flatMap((a) => a.cells.map((c) => c.cell)))].sort();
  for (const m of result.metrics) {
    lines.push("", `### ${m.label}`, "");
    lines.push(`| arm | aggregate | ${allCells.join(" | ")} |`);
    lines.push(`|---|---|${allCells.map(() => "---").join("|")}|`);
    for (const a of result.arms) {
      const cellText = allCells.map((cell) => {
        const s = a.cells.find((c) => c.cell === cell)?.metrics[m.id];
        if (s === undefined || s.n === 0) return "—";
        return `${fmtMetric(m, s.mean)} ± ${fmtMetric(m, s.sd)} [${fmtMetric(m, s.min)}–${fmtMetric(m, s.max)}] (${s.n})`;
      });
      lines.push(`| ${a.label} | ${fmtMetric(m, a.aggregate[m.id])} | ${cellText.join(" | ")} |`);
    }
  }

  if (result.comparisons.length > 0) {
    lines.push("", "## Versus incumbent", "", "Difference = mean over common cells of (candidate − incumbent) cell means.", "");
    lines.push("| candidate | metric | difference | 95% CI | stratified Welch p | cells ahead | per-cell differences | failed guards |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const c of result.comparisons) {
      const def = defs.get(c.metric)!;
      lines.push(
        `| ${c.candidate} | ${def.label} | ${fmtMetric(def, c.diff, true)} | ` +
          `${c.ci95 === null ? "—" : `${fmtMetric(def, c.ci95.lo, true)} to ${fmtMetric(def, c.ci95.hi, true)}`} | ` +
          `${fmtP(c.welchP)} | ${c.cellsAhead}/${c.commonCells} | ` +
          `${c.cellDiffs.map((d) => `${d.cell} ${fmtMetric(def, d.diff, true)}`).join("; ") || "—"} | ` +
          `${c.failedGuards.length === 0 ? "—" : `${c.failedGuards.join(", ")}: ${c.droppedCells.join(", ")}`} |`,
      );
    }
  }

  lines.push("", "## Latency per step (live calls)", "");
  lines.push("| arm | step | calls | p50 ms | max ms |");
  lines.push("|---|---|---|---|---|");
  for (const a of result.arms) {
    for (const l of a.latency) lines.push(`| ${a.label} | ${l.step} | ${l.calls} | ${fmtMs(l.p50Ms)} | ${fmtMs(l.maxMs)} |`);
  }

  lines.push("", "## Modeled cost per flow by step (list price)", "");
  lines.push("| arm | step | $/flow | unpriced records |");
  lines.push("|---|---|---|---|");
  for (const a of result.arms) {
    for (const s of a.stageCost) lines.push(`| ${a.label} | ${s.step} | $${s.perFlowUsd.toFixed(4)} | ${s.unpricedRecords} |`);
  }

  lines.push("", `## Power check (incumbent \`${result.incumbent}\`)`, "");
  lines.push("s = pooled within-cell SD. Half-width = 1.96·s/√(2n) at n = 6; the C-cell form 1.96·s·√(2/(C·n)) equals it at C = 4. n = samples per cell for a ±2.5-point half-width (share metrics only).", "");
  lines.push("| metric | s | C | half-width n=6 | half-width n=6 (C cells) | n for ±2.5 | n for ±2.5 (C cells) |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const p of result.power) {
    const def = defs.get(p.metric)!;
    if (!p.available) {
      lines.push(`| ${def.label} | — | — | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${def.label} | ${fmtMetric(def, p.s)} | ${p.cells} | ${fmtMetric(def, p.halfWidthAtN6)} | ` +
        `${fmtMetric(def, p.halfWidthAtN6ForCells)} | ${fmtN(p.nForTarget)} | ${fmtN(p.nForTargetForCells)} |`,
    );
  }
  return lines.join("\n");
}
