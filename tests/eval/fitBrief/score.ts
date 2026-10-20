/**
 * Pure scoring for the fit-brief eval (#495 Phase 3).
 *
 * Two hard gates and two model-graded measures per brief:
 *
 * - Evidence gate (deterministic): every evidence quote in the
 *   generated brief must appear in the résumé or inventory.
 * - Claim gate (model-graded): the judge lists statements about the
 *   candidate the sources don't support, and claim-rule violations.
 *   A brief passes only with none of either.
 * - Coverage: the judge's recall/precision against the owner's
 *   reference brief.
 * - Verdict agreement with the reference.
 *
 * Aggregates are printed; per-pair rows are written only to the private
 * output directory, never to stdout.
 */

import type { FitBriefResponseV1 } from "../../../functions/src/prompts/generation/fitBrief.v1.schema.ts";

import type { JudgeResult } from "./judge.ts";

/**
 * Normalize text for a verbatim-evidence check: collapse whitespace,
 * strip Markdown emphasis and list markers, straighten quotes, and
 * ignore case. Wording must match; formatting need not.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface EvidenceCheck {
  readonly total: number;
  readonly unsupported: readonly string[];
}

export function checkEvidence(
  brief: FitBriefResponseV1,
  sources: readonly string[],
): EvidenceCheck {
  const haystack = sources.map(normalizeForMatch).join("\n");
  const quotes = brief.strengths.flatMap((s) => s.evidence);
  return {
    total: quotes.length,
    unsupported: quotes.filter((q) => !haystack.includes(normalizeForMatch(q))),
  };
}

export interface BriefScore {
  readonly evidenceTotal: number;
  readonly evidenceUnsupported: number;
  readonly unsupportedClaims: number;
  readonly claimRuleViolations: number;
  /** (covered + 0.5 × partial) / reference points; null when the reference has none. */
  readonly recall: number | null;
  /** Generated points matching the reference / generated points; null when none. */
  readonly precision: number | null;
  /** Null when the judge could not read a verdict from the reference. */
  readonly verdictAgrees: boolean | null;
  /** Both hard gates passed. */
  readonly gatesPass: boolean;
}

export function scoreBrief(args: {
  readonly evidence: EvidenceCheck;
  readonly judge: JudgeResult;
  readonly generatedVerdict: FitBriefResponseV1["verdict"];
}): BriefScore {
  const { evidence, judge } = args;
  const refs = judge.reference_points;
  const covered = refs.filter((r) => r.coverage === "covered").length;
  const partial = refs.filter((r) => r.coverage === "partial").length;
  const gen = judge.generated_points;
  const matched = gen.filter((g) => g.matches_reference).length;
  const unsupportedClaims = judge.unsupported_candidate_claims.length;
  const claimRuleViolations = judge.claim_rule_violations.length;
  return {
    evidenceTotal: evidence.total,
    evidenceUnsupported: evidence.unsupported.length,
    unsupportedClaims,
    claimRuleViolations,
    recall: refs.length === 0 ? null : (covered + 0.5 * partial) / refs.length,
    precision: gen.length === 0 ? null : matched / gen.length,
    verdictAgrees:
      judge.reference_verdict === "unclear" ? null : judge.reference_verdict === args.generatedVerdict,
    gatesPass: evidence.unsupported.length === 0 && unsupportedClaims === 0 && claimRuleViolations === 0,
  };
}

export interface AggregateRow {
  readonly split: string;
  readonly briefs: number;
  readonly failed: number;
  readonly gatesPassed: number;
  readonly evidenceUnsupported: number;
  readonly unsupportedClaims: number;
  readonly claimRuleViolations: number;
  readonly meanRecall: number | null;
  readonly meanPrecision: number | null;
  readonly verdictAgreement: number | null;
}

function mean(values: readonly (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Roll per-brief scores up by split. Failed briefs (null score) count in `failed`. */
export function aggregate(
  rows: readonly { readonly split: string; readonly score: BriefScore | null }[],
): AggregateRow[] {
  const splits = [...new Set(rows.map((r) => r.split))].sort();
  return splits.map((split) => {
    const inSplit = rows.filter((r) => r.split === split);
    const scored = inSplit.map((r) => r.score).filter((s): s is BriefScore => s !== null);
    const sum = (f: (s: BriefScore) => number) => scored.reduce((a, s) => a + f(s), 0);
    const verdicts = scored.map((s) => s.verdictAgrees).filter((v): v is boolean => v !== null);
    return {
      split,
      briefs: inSplit.length,
      failed: inSplit.length - scored.length,
      gatesPassed: scored.filter((s) => s.gatesPass).length,
      evidenceUnsupported: sum((s) => s.evidenceUnsupported),
      unsupportedClaims: sum((s) => s.unsupportedClaims),
      claimRuleViolations: sum((s) => s.claimRuleViolations),
      meanRecall: mean(scored.map((s) => s.recall)),
      meanPrecision: mean(scored.map((s) => s.precision)),
      verdictAgreement:
        verdicts.length === 0 ? null : verdicts.filter(Boolean).length / verdicts.length,
    };
  });
}

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

/**
 * The only report printed to stdout. Aggregates and configuration only:
 * no pair ids, quotes, or text from the corpus.
 */
export function formatAggregate(
  rows: readonly AggregateRow[],
  meta: {
    readonly model: string;
    readonly effort?: string;
    readonly judgeModel: string;
    readonly judgeEffort?: string;
    readonly evidenceMode: string;
    readonly spentUsd: number;
    readonly maxUsd?: number;
    readonly incomplete: boolean;
  },
): string {
  const lines = [
    `Fit-brief eval — model ${meta.model}${meta.effort ? ` (effort ${meta.effort})` : ""}, ` +
      `evidence ${meta.evidenceMode}, judge ${meta.judgeModel}` +
      `${meta.judgeEffort ? ` (effort ${meta.judgeEffort})` : ""}`,
    "",
    "| split | briefs | failed | gates passed | unsupported evidence | unsupported claims | claim-rule violations | recall* | precision* | verdict agreement |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.split} | ${r.briefs} | ${r.failed} | ${r.gatesPassed}/${r.briefs - r.failed} | ` +
        `${r.evidenceUnsupported} | ${r.unsupportedClaims} | ${r.claimRuleViolations} | ` +
        `${pct(r.meanRecall)} | ${pct(r.meanPrecision)} | ${pct(r.verdictAgreement)} |`,
    ),
    "",
    `* model-graded by ${meta.judgeModel}; unsupported claims and claim-rule violations are model-graded too.`,
    `Spend (list-price estimate from usage records): $${meta.spentUsd.toFixed(2)}.` +
      (meta.incomplete ? " INCOMPLETE: the run stopped at its --max-usd bound." : "") +
      // A paid call already in flight when the bound is reached still
      // completes, so say so rather than imply the bound held exactly.
      (meta.maxUsd !== undefined && meta.spentUsd > meta.maxUsd
        ? ` Spend exceeded --max-usd $${meta.maxUsd.toFixed(2)} by $${(meta.spentUsd - meta.maxUsd).toFixed(2)} (the last call in flight).`
        : ""),
  ];
  return lines.join("\n");
}
