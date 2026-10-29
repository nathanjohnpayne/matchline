/**
 * Markdown for `eval:fixed-inputs` (#648). Pure: formats a result.
 */

import type { EmbeddingPlan, FillResult } from "./embeddingCache.ts";
import { median, sumDecompositions, type Decomposition } from "./evaluate.ts";
import type { SideProvenance } from "./corrections.ts";
import type { ScorerName } from "./scorers.ts";

export const DIAGNOSTIC_BANNER =
  "Match-accuracy numbers from this runner are diagnostic until the labels and owner corrections are reviewed (#636). " +
  "Treat them as estimates for choosing bounded fixes, not as measured quality.";

export const GOLD_DEFINITION =
  "Gold inputs are the public labels used as matcher inputs. A gold Unit is an `expected_units` entry " +
  "(id, `normalized_summary` as summary and raw text, skills, tools, domains) with confidence 1 and no dates, " +
  "seniority or scope signals, outcomes or metrics. A gold Requirement is an `expected_requirements` entry " +
  "(id, text, category, must-have) and carries no structure: no keywords, tools, domains or seniority level, " +
  "so every structural scoring axis is unsignalled on it (applicability false). Under the current scorer the " +
  "unconstrained axes pay their fixed defaults: 0.5 for skills, tools and domains, 1.0 for seniority, and 1.0 " +
  "for scope except 0.5 on a scope-category gold Requirement. The renormalized and cosine scorers ignore " +
  "unsignalled axes. Gold sides map to label ids by identity; record and corrected sides map through " +
  "`mapUnitIds`/`mapRequirementIds` at the 0.10 floor.";

/**
 * Item fields no part of `functions/src/matching` reads: the matcher
 * embeds `normalized_summary` / `normalized_requirement` and scores the
 * structured signals, never `raw_text`, `must_have` or `priority`. A
 * correction that changes only these cannot move match accuracy.
 */
export const FIELDS_MATCHER_IGNORES: ReadonlySet<string> = new Set(["raw_text", "must_have", "priority"]);

const NO_EFFECT = "no effect on matching";

/** True when a correction changed something, but only fields the matcher never reads. */
export function onlyIgnoredFieldsChanged(c: Pick<CorrectionReport, "provenance">): boolean {
  const p = c.provenance;
  return (
    p.fixed.length > 0 &&
    p.dropped.length === 0 &&
    p.added.length === 0 &&
    p.fixed.every((f) => f.fields.every((field) => FIELDS_MATCHER_IGNORES.has(field)))
  );
}

function fieldLabel(field: string): string {
  return FIELDS_MATCHER_IGNORES.has(field) ? `${field} (${NO_EFFECT})` : field;
}

export interface ScoredCell {
  readonly accuracy: number;
  readonly matchCount: number;
  readonly decomposition: Decomposition;
}

export interface FlowResult {
  readonly arm: string;
  readonly invocationId: string;
  readonly cell: string;
  readonly sampleIndex: number;
  readonly asOf: string;
  readonly recordMatchAccuracy: number | null;
  readonly recordMatchCount: number | null;
  readonly unitCount: number;
  readonly requirementCount: number;
  /** condition name → scorer → result. */
  readonly conditions: Readonly<Record<string, Readonly<Partial<Record<ScorerName, ScoredCell>>>>>;
}

export interface CorrectionReport {
  readonly side: "units" | "requirements";
  readonly path: string;
  readonly name: string;
  readonly sha256: string;
  readonly cell: string;
  readonly sourceFlow: { readonly invocationId: string; readonly variant: string; readonly sampleIndex: number };
  readonly provenance: SideProvenance;
  /** Requirement-text and must-have overrides, by id. */
  readonly overrides?: readonly { readonly id: string; readonly normalized_requirement?: string; readonly must_have?: boolean }[];
}

export interface FixedInputsResult {
  readonly generatedAt: string;
  readonly argv: readonly string[];
  readonly metric: string;
  readonly k: number | null;
  readonly scorers: readonly ScorerName[];
  readonly conditions: readonly string[];
  readonly cachePath: string;
  readonly plan: Omit<EmbeddingPlan, "uncached"> & { readonly uncachedTexts: number };
  readonly fill: FillResult | null;
  readonly skipped: readonly { readonly reason: string; readonly flows: readonly string[] }[];
  readonly corrections: readonly CorrectionReport[];
  readonly flows: readonly FlowResult[];
}

const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "–" : (100 * v).toFixed(1));
const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k);
    if (list === undefined) out.set(k, [x]);
    else list.push(x);
  }
  return out;
}

/** Per cell, the mean over that cell's flows. */
export function cellMeans(flows: readonly FlowResult[], condition: string, scorer: ScorerName): Map<string, number> {
  const out = new Map<string, number>();
  for (const [cell, fs] of [...groupBy(flows, (f) => f.cell)].sort(([a], [b]) => a.localeCompare(b))) {
    const vals = fs.map((f) => f.conditions[condition]?.[scorer]?.accuracy).filter((v): v is number => v !== undefined);
    const m = mean(vals);
    if (m !== null) out.set(cell, m);
  }
  return out;
}

/** The equal-cell-weight mean (mean of cell means), the `eval:analyze` convention. */
export function equalCellMean(flows: readonly FlowResult[], condition: string, scorer: ScorerName): number | null {
  return mean([...cellMeans(flows, condition, scorer).values()]);
}

export function arms(flows: readonly FlowResult[]): string[] {
  return [...new Set(flows.map((f) => f.arm))];
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

export function formatPlan(plan: FixedInputsResult["plan"], extra: {
  readonly flows: number;
  readonly conditions: readonly string[];
  readonly scorers: readonly ScorerName[];
  readonly cachePath: string;
  readonly maxUsd: number;
  readonly corrections: readonly CorrectionReport[];
  readonly skipped: FixedInputsResult["skipped"];
}): string {
  const lines = [
    "## Plan",
    "",
    `- Flows: ${extra.flows}; conditions: ${extra.conditions.join(", ")}; scorers: ${extra.scorers.join(", ")}.`,
    `- Matcher runs: ${extra.flows * extra.conditions.length * extra.scorers.length} (production \`runMatchingPipeline\`, in memory).`,
    `- Embedding model ${plan.model}: ${plan.uniqueTexts} distinct texts, ${plan.cachedTexts} cached, ${plan.uncachedTexts} uncached.`,
    `- Estimated embedding spend for the uncached texts: ~${plan.estimatedTokens} tokens, $${plan.estimatedUsd.toFixed(6)} (bound --max-usd $${extra.maxUsd}).`,
    `- Embedding cache: ${extra.cachePath}`,
  ];
  for (const s of extra.skipped) lines.push(`- Skipped ${s.flows.length} flow(s): ${s.reason}.`);
  for (const c of extra.corrections) {
    lines.push(`- Corrected ${c.side} for ${c.cell}: "${c.name}" sha256 ${c.sha256} (${c.path}).`);
  }
  return lines.join("\n");
}

function formatProvenance(c: CorrectionReport): string {
  const p = c.provenance;
  const lines = [
    `### ${c.side} of ${c.cell}: "${c.name}"`,
    "",
    `- sha256 ${c.sha256}; source flow ${c.sourceFlow.variant} #${c.sourceFlow.sampleIndex} (invocation ${c.sourceFlow.invocationId}).`,
    `- Kept (${p.kept.length}): ${p.kept.join(", ") || "none"}.`,
    `- Fixed (${p.fixed.length}): ${p.fixed.map((f) => `${f.id} [${f.fields.map(fieldLabel).join(", ")}]`).join("; ") || "none"}.`,
    `- Dropped (${p.dropped.length}): ${p.dropped.join(", ") || "none"}.`,
  ];
  if (c.side === "units") {
    lines.push(`- Added (${p.added.length}): ${p.added.map((a) => `${a.id} "${a.normalized_summary}"`).join("; ") || "none"}.`);
  }
  for (const o of c.overrides ?? []) {
    const parts = [
      ...(o.normalized_requirement !== undefined ? [`text "${o.normalized_requirement}"`] : []),
      ...(o.must_have !== undefined ? [`must_have ${o.must_have} (${NO_EFFECT})`] : []),
    ];
    lines.push(`- Override ${o.id}: ${parts.join(", ")}.`);
  }
  if (onlyIgnoredFieldsChanged(c)) {
    lines.push(
      `- Every fix on this side changes only fields the matcher does not read (${[...FIELDS_MATCHER_IGNORES].join(", ")}), and nothing is dropped or added: the matcher sees the record side's inputs.`,
    );
  }
  return lines.join("\n");
}

export function formatFixedInputsMarkdown(result: FixedInputsResult, maxUsd: number): string {
  const out: string[] = [
    "# Fixed-input matching runner (#648)",
    "",
    `> ${DIAGNOSTIC_BANNER}`,
    "",
    GOLD_DEFINITION,
    "",
    `Metric: ${result.metric}. Conditions are \`<Units side>/<Requirements side>\`. Means are equal-cell-weight (mean of cell means).`,
    "",
    formatPlan(result.plan, {
      flows: result.flows.length,
      conditions: result.conditions,
      scorers: result.scorers,
      cachePath: result.cachePath,
      maxUsd,
      corrections: result.corrections,
      skipped: result.skipped,
    }),
  ];
  if (result.fill !== null && result.fill.requests > 0) {
    out.push(
      `- Embedded ${result.fill.embedded} text(s) in ${result.fill.requests} request(s): ${result.fill.inputTokens} tokens, $${result.fill.usd.toFixed(6)}.`,
    );
  }
  const armList = arms(result.flows);

  out.push("", "## By condition", "");
  const summaryRows: string[][] = [];
  for (const arm of armList) {
    const flows = result.flows.filter((f) => f.arm === arm);
    const cells = new Set(flows.map((f) => f.cell)).size;
    for (const cond of result.conditions) {
      summaryRows.push([
        arm,
        `\`${cond}\``,
        String(flows.length),
        String(cells),
        ...result.scorers.map((s) => pct(equalCellMean(flows, cond, s))),
      ]);
    }
  }
  out.push(table(["arm", "condition", "flows", "cells", ...result.scorers], summaryRows));

  out.push("", "## By cell", "");
  for (const cond of result.conditions) {
    out.push(`### \`${cond}\``, "");
    const rows: string[][] = [];
    for (const arm of armList) {
      const flows = result.flows.filter((f) => f.arm === arm);
      for (const [cell, fs] of [...groupBy(flows, (f) => f.cell)].sort(([a], [b]) => a.localeCompare(b))) {
        rows.push([
          arm,
          cell,
          String(fs.length),
          ...result.scorers.map((s) => pct(cellMeans(fs, cond, s).get(cell))),
        ]);
      }
    }
    out.push(table(["arm", "cell", "flows", ...result.scorers], rows), "");
  }

  out.push(
    "## Missed labelled pairs",
    "",
    "Each unique labelled pair is found (in the window) or missed for one reason: **A** Unit missing (no input Unit mapped to its Unit label; A∧B also lacks the Requirement), **B** Requirement missing (Unit mapped, Requirement label not), **C** ranking (both mapped, ranked below the window). found + A + B + C = expected. FP counts window entries that are not labelled pairs, and how many of those have an unmapped side. Counts are summed over flows.",
    "",
  );
  const decompRows: string[][] = [];
  for (const arm of armList) {
    const flows = result.flows.filter((f) => f.arm === arm);
    for (const cond of result.conditions) {
      for (const s of result.scorers) {
        const d = sumDecompositions(
          flows.map((f) => f.conditions[cond]?.[s]?.decomposition).filter((x): x is Decomposition => x !== undefined),
        );
        const med = median(d.cRanks);
        decompRows.push([
          arm,
          `\`${cond}\``,
          s,
          String(d.expected),
          String(d.found),
          String(d.A),
          String(d.A_and_B),
          String(d.B),
          String(d.C),
          med === null ? "–" : String(med),
          String(d.fp),
          String(d.fpUnmappedSide),
        ]);
      }
    }
  }
  out.push(
    table(["arm", "condition", "scorer", "expected", "found", "A", "A∧B", "B", "C", "C rank median", "FP", "FP unmapped side"], decompRows),
  );

  if (result.conditions.includes("record/record") && result.scorers.includes("current") && result.k === null) {
    out.push(
      "",
      "## Reproduces the record",
      "",
      "`record/record` with the current scorer against the match accuracy and match count each flow recorded. A mismatch can come from embedding jitter (the API returns slightly different vectors for the same text in different batches, which can flip a pair at the window boundary) or from a recency `asOf` difference: this runner pins `asOf` to the flow's `finishedAt`.",
      "",
    );
    const rows: string[][] = [];
    for (const arm of armList) {
      const flows = result.flows.filter((f) => f.arm === arm && f.recordMatchAccuracy !== null);
      const exact = flows.filter(
        (f) => Math.abs((f.conditions["record/record"]?.current?.accuracy ?? Number.NaN) - f.recordMatchAccuracy!) < 1e-9,
      ).length;
      const counts = flows.filter((f) => f.conditions["record/record"]?.current?.matchCount === f.recordMatchCount).length;
      rows.push([arm, String(flows.length), String(exact), String(counts)]);
    }
    out.push(table(["arm", "flows with a recorded accuracy", "accuracy equal", "match count equal"], rows));
  }

  if (result.corrections.length > 0) {
    out.push("", "## Corrected items", "");
    for (const c of result.corrections) out.push(formatProvenance(c), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
