/**
 * Per-flow metrics for `eval:analyze`, computed from the Units and
 * Requirements a `--record` run saved. Pure: labels and résumé text come
 * in as arguments.
 *
 * Extraction metrics reuse the harness's own scorers: `unitSetAccuracy`
 * for accuracy, and a mirror of its greedy assignment (pinned equal to it
 * in metrics.test.ts) for Unit precision. Grounding reuses the fit-brief
 * evidence gate's `normalizeForMatch` and word-boundary matching.
 *
 * JD metrics mirror the same shape against `expected_requirements`: for
 * each expected requirement in label order, the best unused parsed
 * requirement by `tokenOverlapCoefficient(tokenize(label text),
 * tokenize(normalized_requirement))`, ties to the lowest index.
 */

import { containsAtWordBoundaries, normalizeForMatch } from "../fitBrief/score.ts";
import type { FlowRecord } from "../flowRecord.ts";
import type { ExpectedRequirement, ExpectedUnit } from "../loadFixtures.ts";
import { tokenOverlapCoefficient, tokenize } from "../mapping.ts";
import { jaccard, unitSetAccuracy, type ActualUnit, type ExpectedUnit as ScoringUnit } from "../scoring.ts";

/** Share of extracted Units an expected Unit claims at or above this score. */
export const UNIT_PRECISION_THRESHOLD = 0.5;
/** Requirement pairs at or above this score count as mapped. */
export const REQUIREMENT_MAP_THRESHOLD = 0.3;

export interface AssignmentPair {
  readonly expectedIndex: number;
  readonly actualIndex: number;
  readonly score: number;
}

export interface Assignment {
  /** Mean over expected items of the best score (unpaired = 0). */
  readonly mean: number;
  readonly pairs: readonly AssignmentPair[];
}

function summaryScore(expected: string, actual: string): number {
  const e = tokenize(expected);
  const a = tokenize(actual);
  if (e.size === 0 || a.size === 0) {
    return expected.trim().toLowerCase() === actual.trim().toLowerCase() ? 1 : 0;
  }
  return tokenOverlapCoefficient(e, a);
}

/**
 * Greedy expected-to-actual assignment with the scoring of
 * `unitSetAccuracy` (0.6 × summary overlap + 0.4 × skills Jaccard), so
 * `mean` equals `unitSetAccuracy` exactly and `pairs` says which Unit
 * each expected one claimed.
 */
export function unitAssignment(expected: readonly ScoringUnit[], actual: readonly ActualUnit[]): Assignment {
  if (expected.length === 0) return { mean: actual.length === 0 ? 1 : 0, pairs: [] };
  const used = new Set<number>();
  const pairs: AssignmentPair[] = [];
  let total = 0;
  expected.forEach((e, expectedIndex) => {
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i < actual.length; i++) {
      if (used.has(i)) continue;
      const a = actual[i]!;
      const score = summaryScore(e.normalizedSummary, a.normalizedSummary) * 0.6 + jaccard(e.skills, a.skills) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      pairs.push({ expectedIndex, actualIndex: bestIdx, score: bestScore });
    }
    total += bestScore;
  });
  return { mean: total / expected.length, pairs };
}

/** Share of extracted Units that are some expected Unit's best match at ≥ 0.5. Null with none extracted. */
export function unitPrecision(assignment: Assignment, extractedCount: number): number | null {
  if (extractedCount === 0) return null;
  return assignment.pairs.filter((p) => p.score >= UNIT_PRECISION_THRESHOLD).length / extractedCount;
}

/** Whitespace-delimited word count of a summary. */
export function summaryTokenLength(summary: string): number {
  const trimmed = summary.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Share of Units whose `raw_text` appears, at word boundaries and under
 * `normalizeForMatch`, within ONE line of the résumé. A quote stitched
 * across two lines does not count. Null with no Units.
 */
export function groundingShare(rawTexts: readonly string[], resumeText: string): number | null {
  if (rawTexts.length === 0) return null;
  const lines = resumeText
    .split(/\r?\n/u)
    .map(normalizeForMatch)
    .filter((l) => l.length > 0);
  const grounded = rawTexts.filter((raw) => {
    const needle = normalizeForMatch(raw);
    return lines.some((line) => containsAtWordBoundaries(line, needle));
  }).length;
  return grounded / rawTexts.length;
}

/** Greedy expected-requirement assignment by summary overlap, the `unitSetAccuracy` shape. */
export function requirementAssignment(
  expected: readonly { readonly text: string }[],
  actual: readonly { readonly normalizedRequirement: string }[],
): Assignment {
  if (expected.length === 0) return { mean: actual.length === 0 ? 1 : 0, pairs: [] };
  const used = new Set<number>();
  const pairs: AssignmentPair[] = [];
  let total = 0;
  expected.forEach((e, expectedIndex) => {
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i < actual.length; i++) {
      if (used.has(i)) continue;
      const score = summaryScore(e.text, actual[i]!.normalizedRequirement);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      pairs.push({ expectedIndex, actualIndex: bestIdx, score: bestScore });
    }
    total += bestScore;
  });
  return { mean: total / expected.length, pairs };
}

function mappedPairs(assignment: Assignment): AssignmentPair[] {
  return assignment.pairs.filter((p) => p.score >= REQUIREMENT_MAP_THRESHOLD);
}

/** Share of mapped (≥ 0.3) pairs whose must-have flags agree. Null with no mapped pair. */
export function mustHaveAgreement(
  expected: readonly { readonly must_have: boolean }[],
  actual: readonly { readonly mustHave: boolean }[],
  assignment: Assignment,
): number | null {
  const mapped = mappedPairs(assignment);
  if (mapped.length === 0) return null;
  return mapped.filter((p) => expected[p.expectedIndex]!.must_have === actual[p.actualIndex]!.mustHave).length / mapped.length;
}

/** Share of parsed requirements mapped at ≥ 0.3. Null with none parsed. */
export function requirementPrecision(assignment: Assignment, parsedCount: number): number | null {
  if (parsedCount === 0) return null;
  return mappedPairs(assignment).length / parsedCount;
}

// -- Flow-level metric sets ---------------------------------------------------

export type Task = "extraction" | "jd";

export interface MetricDef {
  readonly id: string;
  readonly label: string;
  /** On [0, 1]: printed in points and eligible for the 2.5-point power target. */
  readonly share: boolean;
}

export const METRICS: Readonly<Record<Task, readonly MetricDef[]>> = {
  extraction: [
    { id: "extraction_accuracy", label: "extraction accuracy", share: true },
    { id: "unit_precision", label: "Unit precision", share: true },
    { id: "extracted_unit_count", label: "extracted Units", share: false },
    { id: "summary_tokens", label: "summary tokens", share: false },
    { id: "grounding_share", label: "grounding share", share: true },
    { id: "match_accuracy", label: "match accuracy (reported)", share: true },
  ],
  jd: [
    { id: "requirement_set_accuracy", label: "requirement-set accuracy", share: true },
    { id: "must_have_agreement", label: "must-have agreement", share: true },
    { id: "requirement_precision", label: "requirement precision", share: true },
    { id: "parsed_requirement_count", label: "parsed requirements", share: false },
    { id: "parsed_must_have_count", label: "parsed must-haves", share: false },
    { id: "match_accuracy", label: "match accuracy (reported)", share: true },
  ],
};

export interface ExtractionLabels {
  readonly expectedUnits: readonly ExpectedUnit[];
  readonly resumeText: string;
}

export interface JdLabels {
  readonly expectedRequirements: readonly ExpectedRequirement[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export type MetricValues = Readonly<Record<string, number | null>>;

export function extractionMetrics(flow: FlowRecord, labels: ExtractionLabels): MetricValues {
  const units = flow.units ?? [];
  const expected = labels.expectedUnits.map((e) => ({ normalizedSummary: e.normalized_summary, skills: e.skills }));
  const actual = units.map((u) => ({ normalizedSummary: str(u.normalized_summary), skills: strs(u.skills) }));
  const assignment = unitAssignment(expected, actual);
  const tokenLengths = units.map((u) => summaryTokenLength(str(u.normalized_summary)));
  return {
    extraction_accuracy: unitSetAccuracy(expected, actual),
    unit_precision: unitPrecision(assignment, units.length),
    extracted_unit_count: units.length,
    summary_tokens: tokenLengths.length === 0 ? null : tokenLengths.reduce((a, b) => a + b, 0) / tokenLengths.length,
    grounding_share: groundingShare(units.map((u) => str(u.raw_text)), labels.resumeText),
    match_accuracy: flow.matchAccuracy,
  };
}

export function jdMetrics(flow: FlowRecord, labels: JdLabels): MetricValues {
  const reqs = flow.requirements ?? [];
  const actual = reqs.map((r) => ({
    normalizedRequirement: str(r.normalized_requirement),
    mustHave: r.must_have === true,
  }));
  const assignment = requirementAssignment(labels.expectedRequirements, actual);
  return {
    requirement_set_accuracy: assignment.mean,
    must_have_agreement: mustHaveAgreement(labels.expectedRequirements, actual, assignment),
    requirement_precision: requirementPrecision(assignment, reqs.length),
    parsed_requirement_count: reqs.length,
    parsed_must_have_count: actual.filter((r) => r.mustHave).length,
    match_accuracy: flow.matchAccuracy,
  };
}
