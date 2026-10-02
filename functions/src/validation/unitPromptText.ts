/**
 * How a candidate Unit is written into the traceability prompt, i.e.
 * exactly the evidence text the validator's model reads. Extracted from
 * `./traceability.ts` so `./unitEvidenceVersion.ts` can fingerprint
 * this same text: a cited Unit's evidence version then changes if and
 * only if what the validator would read changes, by construction
 * rather than by keeping a second field list in sync (#506 review,
 * after `null` vs omitted and `NaN` vs `null` metric values each
 * slipped through a hand-built encoding).
 *
 * Dependency-free so the app can import it across the package boundary.
 */

/** A metric as the prompt renders it; values are printed as written. */
export interface UnitPromptMetric {
  readonly claim: string;
  readonly value?: unknown;
  readonly unit?: string;
  readonly direction?: string;
}

/** The Unit fields the prompt renders. */
export interface UnitPromptFields {
  readonly id: string;
  readonly raw_text: string;
  readonly normalized_summary: string;
  readonly metrics?: readonly UnitPromptMetric[];
  readonly seniority_signals?: readonly string[];
  readonly scope_signals?: readonly string[];
}

/**
 * Safely embed an arbitrary user-controlled string as a quoted
 * literal in the prompt body. `JSON.stringify` escapes embedded
 * `"`, backslashes, newlines, and control chars — the same shape
 * the few-shot examples already use.
 *
 * Codex P1 round 2 on PR #111: the prior version interpolated raw
 * strings inside `"..."` quotes, so any `"` inside the input
 * (legitimate — e.g. a quoted project name, a metric claim with
 * a quoted phrase) broke the format. A claim text `The user led
 * "Project Alpha"` would render as `Claim: "The user led "Project
 * Alpha"."` — malformed, and the prompt-friendly structure the
 * downstream model depends on was lost.
 *
 * `JSON.stringify` for short strings is identical to a hand-
 * written escape function but is part of the runtime, well-
 * tested, and unambiguous to readers.
 */
export function quote(value: string): string {
  return JSON.stringify(value);
}

export function formatUnit(unit: UnitPromptFields): string {
  // Deterministic, prompt-friendly formatting. Includes every
  // field the prompt's hard rules reference:
  //   - raw_text + normalized_summary (rules 1, 2, 5, 6)
  //   - metrics (rule 1: "Numeric facts (percentages, counts,
  //     durations) DO need to match within reasonable rounding")
  //   - seniority_signals (rule 3: "role-level fact (lead, owner,
  //     principal) and no Unit's seniority_signals or prose backs
  //     that level → false") — Codex P2 round 1 on PR #111 caught
  //     a prior version that omitted this field, leaving the
  //     prompt rule unable to fire.
  //   - scope_signals (rule 3 by analogy: scope claims need their
  //     scope context, same shape as seniority).
  // The Unit `id` is critical — the model's response uses it as
  // `supporting_unit_id`, and the value-level guard in
  // `finalizeResult` checks set membership.
  //
  // Every embedded string is run through `quote()` (= JSON.stringify)
  // so embedded `"`, `\\`, newlines, etc. don't break the format.
  // Codex P1 round 2 on PR #111.
  const metricsBlock =
    unit.metrics && unit.metrics.length > 0
      ? unit.metrics
          .map((m) => formatMetric(m))
          .join(",\n")
      : "  (no metrics)";
  const lines: string[] = [
    `[Unit ${unit.id}]`,
    `raw_text: ${quote(unit.raw_text)}`,
    `normalized_summary: ${quote(unit.normalized_summary)}`,
    `metrics: [`,
    metricsBlock,
    `]`,
  ];
  // Seniority + scope are emitted only when non-empty — the
  // prompt's rule 3 only needs them for role-level / scope
  // claims, and most Units won't have both. Keeping the format
  // tight reduces token cost on the common case.
  if (unit.seniority_signals && unit.seniority_signals.length > 0) {
    lines.push(
      `seniority_signals: [${unit.seniority_signals.map(quote).join(", ")}]`,
    );
  }
  if (unit.scope_signals && unit.scope_signals.length > 0) {
    lines.push(
      `scope_signals: [${unit.scope_signals.map(quote).join(", ")}]`,
    );
  }
  return lines.join("\n");
}

function formatMetric(m: UnitPromptMetric): string {
  const parts: string[] = [`claim: ${quote(m.claim)}`];
  if (m.value !== undefined) parts.push(`value: ${m.value}`);
  if (m.unit !== undefined) parts.push(`unit: ${quote(m.unit)}`);
  if (m.direction !== undefined) parts.push(`direction: ${quote(m.direction)}`);
  return `  { ${parts.join(", ")} }`;
}
