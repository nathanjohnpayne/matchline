/**
 * Pure aggregation for the `llm_calls` latency report (#616).
 *
 * Kept free of Firestore so it can be unit-tested; the CLI in
 * `llm-calls-report.ts` does the read-only query and hands the rows
 * here.
 *
 * Two views:
 *   - per stage / subtask: n, p50, p95, max of `latencyMs`;
 *   - per application run: calls that share an `applicationId`
 *     (generation and validation tag it), with the call count, the
 *     sum of call latency, and the wall-clock span from the first call's
 *     start to the last call's end. The span is what a serial pipeline
 *     costs the user; the sum shows how much of it is model time.
 *
 * `createdAt` is the server timestamp written after a call returns, so
 * a call's start is estimated as `createdAt - latencyMs`.
 */

export interface CallRow {
  readonly stage: string;
  readonly subtask?: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly createdAtMs: number;
  readonly applicationId?: string;
  readonly runId?: string;
  readonly attempt?: number;
  readonly costUsd?: number;
}

export interface LatencyStats {
  readonly n: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface StageRow extends LatencyStats {
  readonly stage: string;
  readonly subtask: string;
  readonly models: readonly string[];
  readonly costUsd: number;
}

export interface RunRow {
  readonly applicationId: string;
  readonly startMs: number;
  readonly calls: number;
  readonly stages: readonly string[];
  readonly sumLatencyMs: number;
  readonly spanMs: number;
  readonly costUsd: number;
}

/** Nearest-rank percentile of an unsorted list; 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

export function stats(values: readonly number[]): LatencyStats {
  return {
    n: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length === 0 ? 0 : Math.max(...values),
  };
}

/** Product calls only: eval-harness calls carry a `runId`. */
export function productCalls(rows: readonly CallRow[]): CallRow[] {
  return rows.filter((r) => !r.runId);
}

export function byStage(rows: readonly CallRow[]): StageRow[] {
  const groups = new Map<string, CallRow[]>();
  for (const r of rows) {
    const key = `${r.stage}\u0000${r.subtask ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return [...groups.values()]
    .map((list) => ({
      stage: list[0].stage,
      subtask: list[0].subtask ?? "",
      models: [...new Set(list.map((r) => r.model))].sort(),
      costUsd: list.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      ...stats(list.map((r) => r.latencyMs)),
    }))
    .sort((a, b) => b.p95Ms - a.p95Ms);
}

export function byRun(rows: readonly CallRow[]): RunRow[] {
  const groups = new Map<string, CallRow[]>();
  for (const r of rows) {
    if (!r.applicationId) continue;
    const list = groups.get(r.applicationId) ?? [];
    list.push(r);
    groups.set(r.applicationId, list);
  }
  return [...groups.entries()]
    .map(([applicationId, list]) => {
      const startMs = Math.min(...list.map((r) => r.createdAtMs - r.latencyMs));
      const endMs = Math.max(...list.map((r) => r.createdAtMs));
      return {
        applicationId,
        startMs,
        calls: list.length,
        stages: [...new Set(list.map((r) => r.subtask || r.stage))].sort(),
        sumLatencyMs: list.reduce((s, r) => s + r.latencyMs, 0),
        spanMs: endMs - startMs,
        costUsd: list.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * Markdown for posting. Application ids are replaced with ordinals so
 * the output carries no identifiers from the owner's data.
 */
export function renderMarkdown(
  rows: readonly CallRow[],
  window: { readonly sinceMs: number; readonly untilMs: number },
): string {
  const product = productCalls(rows);
  const evalCount = rows.length - product.length;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const out: string[] = [];
  out.push(
    `Window: ${day(window.sinceMs)} to ${day(window.untilMs)}. ` +
      `${product.length} product calls; ${evalCount} eval-harness calls (with a \`runId\`) excluded. ` +
      "Model-call latency only: callable, Firestore and network time are not in `llm_calls`.",
  );
  out.push("", "| Stage | Subtask | Models | n | p50 | p95 | max |", "|---|---|---|---:|---:|---:|---:|");
  for (const s of byStage(product)) {
    out.push(
      `| ${s.stage} | ${s.subtask || "-"} | ${s.models.join(", ")} | ${s.n} | ${secs(s.p50Ms)} | ${secs(s.p95Ms)} | ${secs(s.maxMs)} |`,
    );
  }
  const runs = byRun(product);
  out.push("", `Per-application runs (calls tagged with an \`applicationId\`): ${runs.length}.`);
  if (runs.length > 0) {
    out.push(
      "",
      "| Run | Date | Calls | Calls by step | Sum of call latency | Wall-clock span |",
      "|---:|---|---:|---|---:|---:|",
    );
    runs.forEach((r, i) => {
      out.push(
        `| ${i + 1} | ${day(r.startMs)} | ${r.calls} | ${r.stages.join(", ")} | ${secs(r.sumLatencyMs)} | ${secs(r.spanMs)} |`,
      );
    });
    const spans = runs.map((r) => r.spanMs);
    const sp = stats(spans);
    out.push("", `Run span: p50 ${secs(sp.p50Ms)}, p95 ${secs(sp.p95Ms)}, max ${secs(sp.maxMs)} (n=${sp.n}).`);
  }
  return out.join("\n");
}
