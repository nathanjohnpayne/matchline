/**
 * Deterministic rationale generator (sub-issue #100 of #20).
 *
 * Given a (Unit, Requirement, ScoreComponents) triple, picks the
 * strongest scoring component and emits a one-sentence prose
 * rationale pointing at it. Pure function: no I/O, no LLM, no
 * randomness. Microseconds-fast, free, fully traceable.
 *
 * Why deterministic first: per the plan's risk register (#2),
 * "Matching rationales feel dumb" is a real risk. The
 * deterministic version is the V1 baseline so we can measure
 * how dumb the templates feel against Nathan's real
 * approve/reject patterns. If dogfooding reveals the prose is
 * mechanical, an LLM-driven follow-up replaces this function
 * with a model call (same signature; the pipeline is unchanged).
 *
 * Zero-fabrication invariant: `surface_evidence` always points
 * to user-controlled Unit content (canonical skill names,
 * normalized_summary, scope_signals, etc.). The function NEVER
 * synthesizes text not present on the input — same trust
 * boundary as the #82 integration test pins on the read side.
 */

import {
  normalizeDomain,
  normalizeKey,
  normalizeSkill,
  normalizeTool,
} from "./normalize.js";
import {
  hasMappedSenioritySignal,
  hasMeasurableRecency,
  requirementAxes,
  WEIGHTS,
  type RequirementAxes,
  type ScoreComponents,
} from "./score.js";
import type {
  ExperienceUnit,
  JobRequirementUnit,
} from "../types/capability.js";

export interface RationaleInput {
  readonly components: ScoreComponents;
  readonly unit: Pick<
    ExperienceUnit,
    | "normalized_summary"
    | "skills"
    | "tools"
    | "domains"
    | "seniority_signals"
    | "scope_signals"
    | "date_range"
  >;
  readonly requirement: Pick<
    JobRequirementUnit,
    | "normalized_requirement"
    | "category"
    | "keywords"
    | "tools"
    | "domains"
    | "seniority_level"
  >;
}

export interface RationaleResult {
  /** Human-facing one-sentence rationale. */
  readonly rationale: string;
  /** Unit-side claim that supports the match (zero-fab). */
  readonly surface_evidence: string;
  /** The component whose weighted contribution drove the rationale. */
  readonly driving_component: keyof ScoreComponents;
}

/**
 * Tie-breaker priority for `driving_component` selection. When
 * two components produce identical weighted contributions, the
 * earlier entry in this list wins. Order matches the issue's
 * spec: semantic > skill > domain > tool > seniority > scope >
 * recency. Documented + pinned by test so any future re-rank is
 * an intentional decision rather than a silent edit.
 *
 * The default WEIGHTS already produce three components at 0.10
 * (tool, seniority, scope) — the tie-breaker is load-bearing
 * among those.
 */
const TIE_BREAKER_ORDER: readonly (keyof ScoreComponents)[] = [
  "semantic_similarity",
  "skill_overlap",
  "domain_overlap",
  "tool_overlap",
  "seniority_alignment",
  "scope_alignment",
  "recency",
];

const SUMMARY_TRUNCATE_AT = 200;

export function generateRationale(input: RationaleInput): RationaleResult {
  // Only axes the Requirement actually constrains may drive the
  // rationale. Applicability is derived from `input.requirement`
  // rather than passed in, so a caller can't forget it and
  // reopen the hole below.
  const axes = requirementAxes(input.requirement);
  // `seniorityAlignment` returns the same 0.5 for a real
  // one-level gap and for the "we don't know" fallback when the
  // Unit's signals are all unmapped. Only the first is a
  // comparison; narrating the second as "Matched on seniority
  // alignment" describes an evaluation that never happened.
  // The pair-level fact lives in `hasMappedSenioritySignal`,
  // which the coverage gate already consumes — Codex P2 round 5
  // caught that the rationale wasn't consuming it too.
  //
  // `recency` gets the same treatment for the same reason: it
  // returns 0.5 when the Unit has no `date_range`, or an
  // unparseable one, and `requirementAxes` always marks it
  // applicable because it's a Unit-side axis. With a weak
  // semantic score that neutral can win and emit "Matched on
  // recency axis (no date range on Unit)" — an explicit lack of
  // information offered as the reason for the match. Codex P2
  // on #435.
  const drivingComponent = pickDrivingComponent(input.components, {
    ...axes,
    seniority_alignment:
      axes.seniority_alignment && hasMappedSenioritySignal(input.unit),
    recency: axes.recency && hasMeasurableRecency(input.unit),
  });
  switch (drivingComponent) {
    case "semantic_similarity":
      return semanticTemplate(input, drivingComponent);
    case "skill_overlap":
      return skillTemplate(input, drivingComponent);
    case "tool_overlap":
      return toolTemplate(input, drivingComponent);
    case "domain_overlap":
      return domainTemplate(input, drivingComponent);
    case "seniority_alignment":
      return seniorityTemplate(input, drivingComponent);
    case "scope_alignment":
      return scopeTemplate(input, drivingComponent);
    case "recency":
      return recencyTemplate(input, drivingComponent);
  }
}

// -- Driving-component selection --------------------------------------------

/**
 * Highest weighted contribution wins, but ONLY among axes the
 * Requirement actually constrains.
 *
 * The applicability filter is load-bearing for the module's
 * zero-fabrication invariant. `jaccard()` returns the 0.5
 * neutral when the Requirement side is empty or unrecognized
 * (#430), which is 0.10 of contribution on `skill_overlap` —
 * enough to win the tie-break against a Requirement that named
 * no skills at all. `skillTemplate` would then take its
 * no-canonical-overlap branch and emit "Matched on skill axis"
 * with the UNIT's raw skills as `surface_evidence`, presenting
 * them as support for a comparison that never happened.
 * `seniorityAlignment` and `scopeAlignment` have the same
 * shape: both return 1.0 when unconstrained, worth another 0.10
 * each. CodeRabbit Major on PR #435 caught the leak.
 *
 * `semantic_similarity` is always applicable, so the filter can
 * never empty the candidate set.
 */
function pickDrivingComponent(
  components: ScoreComponents,
  axes: RequirementAxes,
): keyof ScoreComponents {
  let best: keyof ScoreComponents = TIE_BREAKER_ORDER[0]!;
  let bestContribution = WEIGHTS[best] * components[best];
  for (const key of TIE_BREAKER_ORDER) {
    if (!axes[key]) continue;
    const contribution = WEIGHTS[key] * components[key];
    if (contribution > bestContribution) {
      best = key;
      bestContribution = contribution;
    }
    // On strict equality, tie-breaker order means the EARLIER
    // entry wins — `>` (not `>=`) preserves that.
  }
  return best;
}

// -- Per-component templates ------------------------------------------------

function semanticTemplate(
  input: RationaleInput,
  driving: keyof ScoreComponents,
): RationaleResult {
  const evidence = input.unit.normalized_summary;
  const display = truncate(evidence, SUMMARY_TRUNCATE_AT);
  return {
    rationale: `Matched on semantic similarity: ${display} ↔ ${truncate(
      input.requirement.normalized_requirement,
      SUMMARY_TRUNCATE_AT,
    )}.`,
    surface_evidence: evidence,
    driving_component: driving,
  };
}

function skillTemplate(
  input: RationaleInput,
  driving: keyof ScoreComponents,
): RationaleResult {
  const overlap = canonicalOverlap(
    input.unit.skills,
    input.requirement.keywords,
    normalizeSkill,
  );
  if (overlap.length === 0) {
    // Defensive fallback: skill_overlap drove the score but no
    // canonical overlap is computable (e.g. raw terms that
    // didn't normalize). Don't claim "shared X" without an X
    // — and don't lie that overlap exists. Codex P2 + CodeRabbit
    // on PR #105 caught the prior misleading prose.
    return {
      rationale:
        "Matched on skill axis (no canonical overlap; raw skills surfaced).",
      surface_evidence: input.unit.skills.join(", "),
      driving_component: driving,
    };
  }
  return {
    rationale: `Matched on skill overlap: shared ${formatList(overlap)}.`,
    surface_evidence: overlap.join(", "),
    driving_component: driving,
  };
}

function toolTemplate(
  input: RationaleInput,
  driving: keyof ScoreComponents,
): RationaleResult {
  const overlap = canonicalOverlap(
    input.unit.tools,
    input.requirement.tools,
    normalizeTool,
  );
  if (overlap.length === 0) {
    return {
      rationale:
        "Matched on tool axis (no canonical overlap; raw tools surfaced).",
      surface_evidence: input.unit.tools.join(", "),
      driving_component: driving,
    };
  }
  return {
    rationale: `Matched on tool overlap: shared ${formatList(overlap)}.`,
    surface_evidence: overlap.join(", "),
    driving_component: driving,
  };
}

function domainTemplate(
  input: RationaleInput,
  driving: keyof ScoreComponents,
): RationaleResult {
  const overlap = canonicalOverlap(
    input.unit.domains,
    input.requirement.domains,
    normalizeDomain,
  );
  if (overlap.length === 0) {
    return {
      rationale:
        "Matched on domain axis (no canonical overlap; raw domains surfaced).",
      surface_evidence: input.unit.domains.join(", "),
      driving_component: driving,
    };
  }
  return {
    rationale: `Matched on domain overlap: ${formatList(overlap)}.`,
    surface_evidence: overlap.join(", "),
    driving_component: driving,
  };
}

function seniorityTemplate(
  input: RationaleInput,
  driving: keyof ScoreComponents,
): RationaleResult {
  const required = input.requirement.seniority_level;
  const hasSignals = input.unit.seniority_signals.length > 0;
  const signals = hasSignals ? input.unit.seniority_signals.join(", ") : "";
  // surface_evidence stays user-derived: empty string when the
  // unit has no seniority signals, NOT a fabricated "none
  // recorded". CodeRabbit Minor on PR #105 caught the
  // fabrication. The rationale prose can describe absence
  // without fabricating it onto surface_evidence.
  const rationale = hasSignals
    ? `Matched on seniority alignment: Unit signals "${signals}"${
        required ? ` against required level "${required}".` : "."
      }`
    : `Matched on seniority alignment${
        required ? ` against required level "${required}"` : ""
      } (no explicit signals on Unit).`;
  return {
    rationale,
    surface_evidence: signals,
    driving_component: driving,
  };
}

/**
 * Match the canonical-form scope overlap that scopeAlignment
 * uses in score.ts. CodeRabbit Major on PR #105: the prior
 * template emitted EVERY unit.scope_signals entry — including
 * ones that didn't actually match the requirement — which
 * over-claimed the match and surfaced unsupporting evidence on
 * the Matches tab. The new logic keeps only signals whose
 * normalize-key collides with a requirement keyword.
 *
 * Returns the signals in their original (raw) form so the
 * surface_evidence remains user-controlled phrasing rather
 * than the lossy normalize-key form ("$5m p l" etc.).
 */
function scopeOverlap(
  unitSignals: readonly string[],
  requirementKeywords: readonly string[],
): string[] {
  // Build a set of normalize-key forms from the requirement side.
  const reqKeys = new Set<string>();
  for (const k of requirementKeywords) {
    const norm = normalizeKey(k);
    if (norm.length > 0) reqKeys.add(norm);
  }
  if (reqKeys.size === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sig of unitSignals) {
    const norm = normalizeKey(sig);
    if (norm.length > 0 && reqKeys.has(norm) && !seen.has(norm)) {
      seen.add(norm);
      out.push(sig);
    }
  }
  return out;
}

function scopeTemplate(
  input: RationaleInput,
  driving: keyof ScoreComponents,
): RationaleResult {
  const overlap = scopeOverlap(
    input.unit.scope_signals,
    input.requirement.keywords,
  );
  if (overlap.length === 0) {
    // Component drove the score but no canonical overlap
    // computes — same defensive shape as skill/tool/domain.
    // surface_evidence stays empty rather than fabricating.
    return {
      rationale:
        "Matched on scope axis (no canonical overlap with requirement).",
      surface_evidence: "",
      driving_component: driving,
    };
  }
  return {
    rationale: `Matched on scope alignment: ${formatList(overlap)}.`,
    surface_evidence: overlap.join(", "),
    driving_component: driving,
  };
}

function recencyTemplate(
  input: RationaleInput,
  driving: keyof ScoreComponents,
): RationaleResult {
  const range = input.unit.date_range;
  // Surface only the endpoints that PARSE. `hasMeasurableRecency`
  // gates this template on `end` when `end` is present, so a
  // range like `{ start: "not-a-date", end: "2021-01-01" }`
  // reaches here with a measurable end and an unusable start —
  // and an end-only range reaches here with no start at all. The
  // prior guard keyed on `start` alone, so the first case
  // surfaced "not-a-date" as evidence and the second claimed
  // "no date range on Unit" despite having a real end date.
  // CodeRabbit on #435.
  const usable = (v: unknown): v is string =>
    typeof v === "string" &&
    v.length > 0 &&
    !Number.isNaN(new Date(v).getTime());
  const start = range !== undefined && usable(range.start) ? range.start : null;
  const end = range !== undefined && usable(range.end) ? range.end : null;
  if (start === null && end === null) {
    // Nothing parseable to point at. surface_evidence stays
    // empty rather than fabricating "no date recorded"
    // (CodeRabbit Minor on PR #105). The rationale prose
    // acknowledges the absence without claiming a date.
    return {
      rationale: "Matched on recency axis (no usable date on Unit).",
      surface_evidence: "",
      driving_component: driving,
    };
  }
  const evidence =
    start === null
      ? `through ${end!}`
      : `${start}${end !== null ? ` to ${end}` : " (ongoing)"}`;
  return {
    rationale: `Recent: Unit dates within the relevant window (${evidence}).`,
    surface_evidence: evidence,
    driving_component: driving,
  };
}

// -- Helpers ----------------------------------------------------------------

/**
 * Compute the canonicalized overlap between two raw-string
 * arrays. Mirrors `canonicalize` in score.ts but returns the
 * canonical names (sorted, deduped) rather than a Set, so the
 * rationale prose has a stable display order across renders.
 *
 * Sorted for stable output: an unsorted Set iteration would
 * produce different rationale strings on different runs of
 * the same data, which would break test pinning and produce
 * confusing diffs in the Matches tab.
 */
function canonicalOverlap(
  unitTerms: readonly string[],
  requirementTerms: readonly string[],
  normalize: (raw: string) => string | null,
): string[] {
  const unitSet = new Set<string>();
  for (const t of unitTerms) {
    const c = normalize(t);
    if (c !== null) unitSet.add(c);
  }
  const out = new Set<string>();
  for (const t of requirementTerms) {
    const c = normalize(t);
    if (c !== null && unitSet.has(c)) out.add(c);
  }
  return [...out].sort();
}

/**
 * Format a list of items for prose: ["a"] → "a"; ["a", "b"] →
 * "a and b"; ["a", "b", "c"] → "a, b, and c". Oxford comma
 * because the rationale is at-a-glance UI text and the comma
 * removes a parsing pause.
 */
function formatList(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
