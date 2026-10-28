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
    // Single-character emphasis (*x*, _x_) at word boundaries; asterisks
    // and underscores inside words are left alone (Codex P2, #581).
    .replace(/(^|[^\p{L}\p{N}])[*_](?=\S)(.+?)(?<=\S)[*_](?=$|[^\p{L}\p{N}])/gmu, "$1$2")
    // The same list-item and heading markers evidenceUnits strips from the
    // sources, so a quote copied with its marker still matches (Codex P2, #581).
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface EvidenceCheck {
  readonly total: number;
  readonly unsupported: readonly string[];
  /**
   * Units mode only: the unsupported quotes that DO match a Unit's
   * `raw_text` (the extraction paraphrased the résumé and the brief quoted
   * the paraphrase)...
   */
  readonly extractionParaphrase?: readonly string[];
  /** ...and the ones that match neither the sources nor any Unit. */
  readonly unsupportedQuote?: readonly string[];
}

/**
 * Every failure category the printed aggregate may show. A closed set,
 * so a new failure path cannot invent a column.
 *
 * - `evidence-quote`: a quote found in neither the sources nor (units
 *   mode) any Unit — artifacts call it `unsupported-quote`.
 * - `extraction-paraphrase`: units mode, a quote found in a Unit's
 *   `raw_text` but not in the résumé or inventory.
 * - `unsupported-claim`, `claim-rule`: the judge's two lists.
 * - `unscored`: the brief could not be generated or judged.
 */
export const FAILURE_CATEGORIES = [
  "evidence-quote",
  "extraction-paraphrase",
  "unsupported-claim",
  "claim-rule",
  "unscored",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * A quote is supported when it appears, as written, inside a single
 * evidence unit of the canonical sources (see `evidenceUnits`), so two
 * adjacent bullets cannot be stitched into one quote (Codex P1, #581).
 * Only verbatim résumé or inventory text passes: units mode keeps the
 * extraction's dates out of the quotable lines (see `renderUnitEvidence`
 * in run.ts), so a quote carrying a date the résumé line does not hold
 * fails here, and any date a brief asserts is left to the judge's
 * claim gate against the canonical sources.
 */
export function checkEvidence(
  brief: FitBriefResponseV1,
  sources: readonly string[],
  /** Units mode: the `raw_text` of each Unit the generator read, to classify failures. */
  unitTexts?: readonly string[],
): EvidenceCheck {
  const units = sources.flatMap(evidenceUnits);
  const quotes = brief.strengths.flatMap((s) => s.evidence);
  const supported = (q: string): boolean => {
    const needle = normalizeForMatch(q);
    return units.some((unit) => containsAtWordBoundaries(unit, needle));
  };
  const unsupported = quotes.filter((q) => !supported(q));
  return {
    total: quotes.length,
    unsupported,
    ...(unitTexts !== undefined && classifyUnsupportedQuotes(unsupported, unitTexts)),
  };
}

/**
 * Split failed quotes by whether a Unit's `raw_text` holds them (same
 * normalization and word-boundary rule as the gate). Classification only:
 * a quote matching a Unit still fails the evidence gate, because Units
 * never certify a claim.
 */
export function classifyUnsupportedQuotes(
  unsupported: readonly string[],
  unitTexts: readonly string[],
): { extractionParaphrase: string[]; unsupportedQuote: string[] } {
  const normalizedUnits = unitTexts.map(normalizeForMatch).filter((u) => u.length > 0);
  const extractionParaphrase: string[] = [];
  const unsupportedQuote: string[] = [];
  for (const q of unsupported) {
    const needle = normalizeForMatch(q);
    if (normalizedUnits.some((u) => containsAtWordBoundaries(u, needle))) extractionParaphrase.push(q);
    else unsupportedQuote.push(q);
  }
  return { extractionParaphrase, unsupportedQuote };
}

const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/u;
const HEADING = /^\s*#{1,6}\s/u;
const INDENTED = /^[ \t]+\S/u;

/**
 * Split a source into the spans a quote may come from. A list item keeps
 * only its indented continuation lines; every other line is its own span,
 * so an unindented line after a bullet, or the next line of a hard-wrapped
 * paragraph, never joins the line before it (Codex P1 ×2, #581). That
 * fails closed: a quote spanning two plain lines is rejected rather than
 * a stitched quote accepted. Returned normalized for matching.
 */
export function evidenceUnits(text: string): string[] {
  const units: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) units.push(normalizeForMatch(current.join("\n")));
    current = [];
  };
  let inListItem = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "") {
      flush();
      inListItem = false;
    } else if (HEADING.test(line)) {
      flush();
      inListItem = false;
      units.push(normalizeForMatch(line.replace(/^\s*#{1,6}\s+/u, "")));
    } else if (LIST_ITEM.test(line)) {
      flush();
      inListItem = true;
      current.push(line.replace(LIST_ITEM, ""));
    } else if (inListItem && INDENTED.test(line)) {
      current.push(line);
    } else {
      flush();
      inListItem = false;
      current.push(line);
      flush();
    }
  }
  flush();
  return units.filter((u) => u.length > 0);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Substring match anchored at word boundaries, so a short quote such as
 * "led" is not found inside "controlled" (CodeRabbit on #581).
 */
export function containsAtWordBoundaries(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}_])`, "u").test(haystack);
}

export interface BriefScore {
  readonly evidenceTotal: number;
  readonly evidenceUnsupported: number;
  /** Failed quotes found in a Unit's raw_text (units mode); 0 otherwise. */
  readonly evidenceExtractionParaphrase: number;
  /** Failed quotes found nowhere; every failed quote in résumé mode. */
  readonly evidenceUnsupportedQuote: number;
  /** The closed-set categories this brief failed on. */
  readonly failureCategories: readonly FailureCategory[];
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
  const extractionParaphrase = evidence.extractionParaphrase?.length ?? 0;
  const unsupportedQuote = evidence.unsupportedQuote?.length ?? evidence.unsupported.length;
  const failureCategories: FailureCategory[] = [];
  if (unsupportedQuote > 0) failureCategories.push("evidence-quote");
  if (extractionParaphrase > 0) failureCategories.push("extraction-paraphrase");
  if (unsupportedClaims > 0) failureCategories.push("unsupported-claim");
  if (claimRuleViolations > 0) failureCategories.push("claim-rule");
  return {
    evidenceTotal: evidence.total,
    evidenceUnsupported: evidence.unsupported.length,
    evidenceExtractionParaphrase: extractionParaphrase,
    evidenceUnsupportedQuote: unsupportedQuote,
    failureCategories,
    unsupportedClaims,
    claimRuleViolations,
    recall: refs.length === 0 ? null : (covered + 0.5 * partial) / refs.length,
    precision: gen.length === 0 ? null : matched / gen.length,
    verdictAgrees:
      judge.reference_verdict === "unclear" ? null : judge.reference_verdict === args.generatedVerdict,
    gatesPass: evidence.unsupported.length === 0 && unsupportedClaims === 0 && claimRuleViolations === 0,
  };
}

export interface CategoryCount {
  /** Briefs with at least one failure of the category. */
  readonly briefs: number;
  /** Failing items (quotes, claims, violations, unscored briefs). */
  readonly items: number;
}

export interface AggregateRow {
  readonly split: string;
  readonly briefs: number;
  /** Unscored briefs (generation or judging failed). */
  readonly failed: number;
  readonly categories: Readonly<Record<FailureCategory, CategoryCount>>;
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
    const failed = inSplit.length - scored.length;
    const count = (cat: FailureCategory, items: (s: BriefScore) => number): CategoryCount => ({
      briefs: scored.filter((s) => s.failureCategories.includes(cat)).length,
      items: sum(items),
    });
    return {
      split,
      briefs: inSplit.length,
      failed,
      categories: {
        "evidence-quote": count("evidence-quote", (s) => s.evidenceUnsupportedQuote),
        "extraction-paraphrase": count("extraction-paraphrase", (s) => s.evidenceExtractionParaphrase),
        "unsupported-claim": count("unsupported-claim", (s) => s.unsupportedClaims),
        "claim-rule": count("claim-rule", (s) => s.claimRuleViolations),
        unscored: { briefs: failed, items: failed },
      },
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
    /** Generator prompt version, e.g. generation/fitBrief.v1. */
    readonly generatorPrompt?: string;
    /** Fingerprint of the generator's full request template. */
    readonly generatorRequest?: string;
    readonly judgeModel: string;
    readonly judgeEffort?: string;
    /** Judge prompt fingerprint. */
    readonly judgePrompt?: string;
    /** Hash of the corpus inputs the run read. */
    readonly corpus?: string;
    readonly evidenceMode: string;
    /** Units mode: the extraction configuration that produced the evidence. */
    readonly extraction?: string;
    /** Units mode: fingerprint of the evidence serialization. */
    readonly unitsFormat?: string;
    /** Units mode: whether the Units were extracted this run or reused. */
    readonly unitsSource?: string;
    /** Units mode: hash of exactly the evidence the generator read. */
    readonly unitsSha256?: string;
    readonly spentUsd: number;
    readonly maxUsd?: number;
    readonly incomplete: boolean;
  },
): string {
  const lines = [
    `Fit-brief eval — model ${meta.model}${meta.effort ? ` (effort ${meta.effort})` : ""}, ` +
      `${meta.corpus ? `corpus ${meta.corpus}, ` : ""}evidence ${meta.evidenceMode}` +
      `${
        meta.extraction
          ? ` (extraction ${meta.extraction}` +
            `${meta.unitsFormat ? `, format ${meta.unitsFormat}` : ""}` +
            `${meta.unitsSource ? `, units ${meta.unitsSource}` : ""}` +
            `${meta.unitsSha256 ? ` sha256:${meta.unitsSha256.slice(0, 12)}` : ""})`
          : ""
      }` +
      `, judge ${meta.judgeModel}` +
      `${meta.judgeEffort ? ` (effort ${meta.judgeEffort})` : ""}` +
      (meta.generatorPrompt || meta.judgePrompt
        ? `; prompts ${[
            meta.generatorPrompt && `${meta.generatorPrompt}${meta.generatorRequest ? ` (request ${meta.generatorRequest})` : ""}`,
            meta.judgePrompt,
          ]
            .filter(Boolean)
            .join(", ")}`
        : ""),
    "",
    `| split | briefs | gates passed | ${FAILURE_CATEGORIES.join(" | ")} | recall* | precision* | verdict agreement |`,
    `|---|---|---|${FAILURE_CATEGORIES.map(() => "---").join("|")}|---|---|---|`,
    ...rows.map(
      (r) =>
        // An unscored brief passed no gate, so it stays in the denominator.
        `| ${r.split} | ${r.briefs} | ${r.gatesPassed}/${r.briefs} | ` +
        `${FAILURE_CATEGORIES.map((c) => `${r.categories[c].briefs} (${r.categories[c].items})`).join(" | ")} | ` +
        `${pct(r.meanRecall)} | ${pct(r.meanPrecision)} | ${pct(r.verdictAgreement)} |`,
    ),
    "",
    "Failure columns: briefs failing on the category (failing items). gates passed counts every brief, so an unscored brief is a gate failure.",
    `* model-graded by ${meta.judgeModel}; unsupported-claim and claim-rule are model-graded too.`,
    `Spend (list-price estimate from usage records): $${meta.spentUsd.toFixed(2)}.` +
      (meta.incomplete ? " INCOMPLETE: the run stopped at its --max-usd bound." : "") +
      // Every sample ran, but the last call reached the bound: say so, so a
      // complete-looking report never hides an over-budget run (Codex P2, #581).
      (!meta.incomplete && meta.maxUsd !== undefined && meta.spentUsd >= meta.maxUsd
        ? ` BOUND REACHED: the final call brought spend to the --max-usd bound; every requested sample was evaluated.`
        : "") +
      // A paid call already in flight when the bound is reached still
      // completes, so say so rather than imply the bound held exactly.
      (meta.maxUsd !== undefined && meta.spentUsd > meta.maxUsd
        ? ` Spend exceeded --max-usd $${meta.maxUsd.toFixed(2)} by $${(meta.spentUsd - meta.maxUsd).toFixed(2)} (the last call in flight).`
        : ""),
  ];
  return lines.join("\n");
}
