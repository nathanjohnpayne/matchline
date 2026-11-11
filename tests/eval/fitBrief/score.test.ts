import { describe, expect, it } from "vitest";

import {
  FitBriefResponseV1Schema,
  type FitBriefResponseV1,
} from "../../../functions/src/prompts/generation/fitBrief.v1.schema.ts";
import type { FitBriefResponseV2 } from "../../../functions/src/prompts/generation/fitBrief.v2.schema.ts";

import type { JudgeResult } from "./judge.ts";
import {
  aggregate,
  briefQuotes,
  checkEvidence,
  classifyUnsupportedQuotes,
  comparable,
  countShortSpans,
  evidenceUnits,
  FAILURE_CATEGORIES,
  formatAggregate,
  judgedBrief,
  normalizeForMatch,
  scoreBrief,
  SHORT_SPAN_WORDS,
  type FitBriefRunConfig,
} from "./score.ts";

const brief = (evidence: string[], verdict: FitBriefResponseV1["verdict"] = "apply"): FitBriefResponseV1 => ({
  bottom_line: "b",
  strengths: [{ jd_clause: "c", evidence, argument: "a" }],
  exposures: [],
  positioning: "p",
  homework: [],
  questions_to_ask: [],
  does_not_claim: [],
  verdict,
});

const judge = (over: Partial<JudgeResult> = {}): JudgeResult => ({
  reference_points: [
    { kind: "strength", jd_clause: "c1", point: "p1", coverage: "covered" },
    { kind: "strength", jd_clause: "c2", point: "p2", coverage: "partial" },
    { kind: "exposure", jd_clause: "c3", point: "p3", coverage: "missing" },
    { kind: "exposure", jd_clause: "c4", point: "p4", coverage: "covered" },
  ],
  generated_points: [
    { kind: "strength", index: 0, point: "g1", matches_reference: true },
    { kind: "strength", index: 1, point: "g2", matches_reference: false },
  ],
  unsupported_candidate_claims: [],
  claim_rule_violations: [],
  reference_verdict: "apply",
  ...over,
});

describe("normalizeForMatch / checkEvidence", () => {
  it("ignores Markdown emphasis, list markers, curly quotes, whitespace and case", () => {
    expect(normalizeForMatch("- **Owned** the  “checkout” API")).toBe(normalizeForMatch('owned the "checkout" api'));
  });

  it("accepts evidence quoted from either source and flags anything else", () => {
    const result = checkEvidence(
      brief(["Owned the checkout API.", "Led the PCI migration.", "Ran a twelve-team platform."]),
      ["- **Owned** the checkout API.", "Led the PCI migration."],
    );
    expect(result.total).toBe(3);
    expect(result.unsupported).toEqual(["Ran a twelve-team platform."]);
  });

  it("never certifies a date the résumé line does not hold (Codex P1, #581)", () => {
    const resume = "### Acme — PM\n**Acme · 2021–Present**\n- Owned the checkout API.";
    expect(checkEvidence(brief(["Owned the checkout API. [2021-03–present]"]), [resume]).unsupported).toHaveLength(1);
    expect(checkEvidence(brief(["Owned the checkout API."]), [resume]).unsupported).toEqual([]);
    // Real text is never stripped.
    expect(checkEvidence(brief(["Owned the [new] API."]), ["Owned the API."]).unsupported).toHaveLength(1);
  });

  it("strips single-character emphasis but leaves underscores inside words alone (Codex P2, #581)", () => {
    expect(checkEvidence(brief(["Owned the checkout API."]), ["- *Owned* the checkout API."]).unsupported).toEqual([]);
    expect(checkEvidence(brief(["Owned the checkout API."]), ["_Owned_ the checkout API."]).unsupported).toEqual([]);
    expect(normalizeForMatch("set max_tokens_limit")).toBe("set max_tokens_limit");
  });

  it("matches at word boundaries, so a short quote is not found inside a longer word (CodeRabbit, #581)", () => {
    expect(checkEvidence(brief(["led"]), ["Controlled the rollout."]).unsupported).toEqual(["led"]);
    expect(checkEvidence(brief(["led"]), ["I led the rollout."]).unsupported).toEqual([]);
    expect(checkEvidence(brief(["$18.1M (approved)"]), ["Secured $18.1M (approved) in capital."]).unsupported).toEqual([]);
  });

  it("refuses a quote stitched across adjacent bullets, paragraphs or a heading (Codex P1, #581)", () => {
    const resume = "## Acme\n- Owned checkout API.\n- Saved $5M elsewhere.\n\nRan the platform team.\n\nGrew revenue.";
    const unsupported = (q: string) => checkEvidence(brief([q]), [resume]).unsupported;
    expect(unsupported("Owned checkout API. Saved $5M elsewhere.")).toHaveLength(1);
    expect(unsupported("Ran the platform team. Grew revenue.")).toHaveLength(1);
    expect(unsupported("Acme Owned checkout API.")).toHaveLength(1);
    expect(unsupported("Saved $5M elsewhere.")).toEqual([]);
    // Two sources never join into one span either.
    expect(checkEvidence(brief(["Owned checkout API. Grew revenue."]), ["- Owned checkout API.", "Grew revenue."]).unsupported).toHaveLength(1);
  });

  it("never joins an unindented line to the bullet or line before it (Codex P1, #581)", () => {
    const unsupported = (q: string, src: string) => checkEvidence(brief([q]), [src]).unsupported;
    expect(unsupported("Owned checkout API. Saved $5M elsewhere.", "- Owned checkout API.\nSaved $5M elsewhere.")).toHaveLength(1);
    expect(unsupported("Owned checkout API. Saved $5M elsewhere.", "Owned checkout API.\nSaved $5M elsewhere.")).toHaveLength(1);
    expect(unsupported("Saved $5M elsewhere.", "- Owned checkout API.\nSaved $5M elsewhere.")).toEqual([]);
  });

  it("still matches a quote across a hard-wrapped continuation line of one bullet", () => {
    const resume = "- Owned the checkout API across\n  three regions.\n1. Led the PCI migration.";
    expect(checkEvidence(brief(["Owned the checkout API across three regions."]), [resume]).unsupported).toEqual([]);
    expect(evidenceUnits(resume)).toEqual(["owned the checkout api across three regions.", "led the pci migration."]);
  });

  it("accepts a quote copied with its numbered, plus or heading marker (Codex P2, #581)", () => {
    const resume = "## Platform leadership\n1. Led the rollout.\n+ Ran the migration.";
    for (const q of ["## Platform leadership", "1. Led the rollout.", "+ Ran the migration.", "Led the rollout."]) {
      expect(checkEvidence(brief([q]), [resume]).unsupported).toEqual([]);
    }
  });

  it("does not accept a paraphrase", () => {
    expect(checkEvidence(brief(["Ran the checkout API."]), ["Owned the checkout API."]).unsupported).toHaveLength(1);
  });
});

describe("scoreBrief", () => {
  it("computes recall with partial credit, precision, and verdict agreement", () => {
    const s = scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge(), generatedVerdict: "apply" });
    expect(s.recall).toBeCloseTo((2 + 0.5) / 4, 10);
    expect(s.precision).toBeCloseTo(0.5, 10);
    expect(s.verdictAgrees).toBe(true);
    expect(s.gatesPass).toBe(true);
  });

  it("fails the gates on any unsupported evidence, unsupported claim or rule violation", () => {
    const base = { judge: judge(), generatedVerdict: "apply" as const };
    expect(scoreBrief({ ...base, evidence: { total: 1, unsupported: ["x"] } }).gatesPass).toBe(false);
    expect(
      scoreBrief({
        ...base,
        evidence: { total: 1, unsupported: [] },
        judge: judge({ unsupported_candidate_claims: [{ quote: "q", reason: "r" }] }),
      }).gatesPass,
    ).toBe(false);
    expect(
      scoreBrief({
        ...base,
        evidence: { total: 1, unsupported: [] },
        judge: judge({ claim_rule_violations: [{ rule: "r", quote: "q" }] }),
      }).gatesPass,
    ).toBe(false);
  });

  it("reports unknown rather than zero when there is nothing to measure", () => {
    const s = scoreBrief({
      evidence: { total: 0, unsupported: [] },
      judge: judge({ reference_points: [], generated_points: [], reference_verdict: "unclear" }),
      generatedVerdict: "hold",
    });
    expect(s.recall).toBeNull();
    expect(s.precision).toBeNull();
    expect(s.verdictAgrees).toBeNull();
  });
});

describe("aggregate / formatAggregate", () => {
  const ok = scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge(), generatedVerdict: "apply" });

  it("rolls up by split and counts failed briefs", () => {
    const [dev] = aggregate([
      { split: "dev", score: ok },
      { split: "dev", score: null },
    ]);
    expect(dev).toMatchObject({ split: "dev", briefs: 2, failed: 1, gatesPassed: 1, verdictAgreement: 1 });
  });

  it("flags a complete run whose final call reached the bound (Codex P2, #581)", () => {
    const base = { model: "m", judgeModel: "j", evidenceMode: "resume", maxUsd: 1, incomplete: false };
    expect(formatAggregate(aggregate([{ split: "dev", score: ok }]), { ...base, spentUsd: 1.2 })).toMatch(/BOUND REACHED/);
    expect(formatAggregate(aggregate([{ split: "dev", score: ok }]), { ...base, spentUsd: 0.4 })).not.toMatch(/BOUND REACHED/);
  });

  it("prints configuration and aggregates only, and flags model-graded columns and an incomplete run", () => {
    const out = formatAggregate(aggregate([{ split: "dev", score: ok }]), {
      model: "claude-sonnet-5-5",
      effort: "medium",
      judgeModel: "claude-opus-5-5",
      evidenceMode: "resume",
      spentUsd: 1.234,
      incomplete: true,
    });
    expect(out).toContain("claude-sonnet-5-5 (effort medium)");
    expect(out).toMatch(/model-graded by claude-opus-5-5/);
    expect(out).toContain("$1.23");
    expect(out).toMatch(/INCOMPLETE/);
  });
});

describe("evidence failure classes", () => {
  const RESUME = "- Owned the checkout API used by four storefront teams.";
  const UNITS = ["Owned the checkout API used by twelve teams."];

  it("classifies a failed quote by whether a Unit's raw_text holds it", () => {
    expect(classifyUnsupportedQuotes(["owned the checkout API used by twelve teams", "Ran payroll."], UNITS)).toEqual({
      extractionParaphrase: ["owned the checkout API used by twelve teams"],
      unsupportedQuote: ["Ran payroll."],
    });
    // Same word-boundary rule as the gate.
    expect(classifyUnsupportedQuotes(["wned"], UNITS).unsupportedQuote).toEqual(["wned"]);
  });

  it("classifies only in units mode, and a Unit match still fails the gate", () => {
    const b = brief(["Owned the checkout API used by twelve teams.", "Ran payroll.", "Owned the checkout API used by four storefront teams."]);
    const resumeMode = checkEvidence(b, [RESUME]);
    expect(resumeMode.extractionParaphrase).toBeUndefined();
    const unitsMode = checkEvidence(b, [RESUME], UNITS);
    expect(unitsMode.unsupported).toHaveLength(2);
    expect(unitsMode.extractionParaphrase).toEqual(["Owned the checkout API used by twelve teams."]);
    expect(unitsMode.unsupportedQuote).toEqual(["Ran payroll."]);

    const s = scoreBrief({ evidence: unitsMode, judge: judge(), generatedVerdict: "apply" });
    expect(s).toMatchObject({ evidenceUnsupported: 2, evidenceExtractionParaphrase: 1, evidenceUnsupportedQuote: 1, gatesPass: false });
    expect(s.failureCategories).toEqual(["evidence-quote", "extraction-paraphrase"]);
    expect(scoreBrief({ evidence: resumeMode, judge: judge(), generatedVerdict: "apply" })).toMatchObject({
      evidenceExtractionParaphrase: 0,
      evidenceUnsupportedQuote: 2,
      failureCategories: ["evidence-quote"],
    });
  });

  it("names judge failures with the closed-set categories", () => {
    const s = scoreBrief({
      evidence: { total: 1, unsupported: [] },
      judge: judge({ unsupported_candidate_claims: [{ quote: "q", reason: "r" }], claim_rule_violations: [{ rule: "r", quote: "q" }] }),
      generatedVerdict: "apply",
    });
    expect(s.failureCategories).toEqual(["unsupported-claim", "claim-rule"]);
    expect(s.failureCategories.every((c) => (FAILURE_CATEGORIES as readonly string[]).includes(c))).toBe(true);
  });

  it("aggregates per category and counts an unscored brief as a gate failure", () => {
    const paraphrase = scoreBrief({
      evidence: checkEvidence(brief(["Owned the checkout API used by twelve teams."]), [RESUME], UNITS),
      judge: judge(),
      generatedVerdict: "apply",
    });
    const clean = scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge(), generatedVerdict: "apply" });
    const [row] = aggregate([
      { split: "dev", score: clean },
      { split: "dev", score: paraphrase },
      { split: "dev", score: null },
    ]);
    expect(row).toMatchObject({ briefs: 3, failed: 1, gatesPassed: 1 });
    expect(row!.categories).toEqual({
      "evidence-quote": { briefs: 0, items: 0 },
      "extraction-paraphrase": { briefs: 1, items: 1 },
      "unsupported-claim": { briefs: 0, items: 0 },
      "claim-rule": { briefs: 0, items: 0 },
      unscored: { briefs: 1, items: 1 },
    });
    const out = formatAggregate([row!], { model: "m", judgeModel: "j", evidenceMode: "units", spentUsd: 0, incomplete: false });
    // gatesPassed / every brief, unscored included.
    expect(out).toContain("| dev | 3 | 1/3 | 0 (0) | 1 (1) | 0 (0) | 0 (0) | 1 (1) |");
    const header = out.split("\n").find((l) => l.startsWith("| split"))!;
    const columns = header.split("|").map((c) => c.trim()).filter(Boolean);
    expect(columns).toEqual(["split", "briefs", "gates passed", ...FAILURE_CATEGORIES, "recall*", "precision*", "verdict agreement"]);
    // Aggregates only: no quote text.
    expect(out).not.toContain("twelve teams");
  });
});

// -- prompt v2 (#655) -----------------------------------------------------------

const RESUME = "- Owned the checkout API used by four storefront teams.\n- Product Manager, 2021–2025";

const briefV2 = (over: Partial<FitBriefResponseV2> = {}): FitBriefResponseV2 => ({
  bottom_line: "b",
  strengths: [{ jd_clause: "c", evidence: ["Owned the checkout API used by four storefront teams."], argument: "a" }],
  exposures: [{ jd_clause: "6+ years", evidence: ["Product Manager, 2021–2025"], gap: "g", handling: "h" }],
  positioning: "p",
  level_strategy: "l",
  homework: [],
  questions_to_ask: [],
  does_not_claim: [],
  verdict: "apply",
  rule_audit: [{ check: 1, outcome: "obeyed" }],
  dropped_points: [
    { kind: "strength", jd_clause: "writing", point: "Clear writer.", evidence: ["Wrote the PCI policy."], reason: "span_does_not_support" },
    { kind: "exposure", jd_clause: "PCI", point: "Certified.", evidence: [], reason: "claim_rule", check: 1 },
  ],
  ...over,
});

describe("evidence gate on v2 briefs", () => {
  it("gates every cited span, exposures included, against the canonical sources", () => {
    const ok = checkEvidence(briefV2(), [RESUME]);
    expect(ok).toEqual({ total: 2, unsupported: [] });
    const bad = briefV2({ exposures: [{ jd_clause: "x", evidence: ["Managed twelve teams."], gap: "g", handling: "h" }] });
    expect(checkEvidence(bad, [RESUME]).unsupported).toEqual(["Managed twelve teams."]);
    expect(scoreBrief({ evidence: checkEvidence(bad, [RESUME]), judge: judge(), generatedVerdict: "apply" }).failureCategories).toContain(
      "evidence-quote",
    );
  });

  it("never gates a dropped point's span, which is not in the brief", () => {
    // "Wrote the PCI policy." is in no source; it is only cited by a dropped point.
    expect(briefQuotes(briefV2())).not.toContain("Wrote the PCI policy.");
    expect(checkEvidence(briefV2(), [RESUME]).unsupported).toEqual([]);
  });

  it("counts an absence exposure as no quote, and a v1 brief exactly as before", () => {
    expect(checkEvidence(briefV2({ exposures: [{ jd_clause: "x", evidence: [], gap: "g", handling: "h" }] }), [RESUME]).total).toBe(1);
    expect(briefQuotes(brief(["one", "two"]))).toEqual(["one", "two"]);
  });
});

describe("judgedBrief", () => {
  it("passes a v1 brief through untouched, so the v1 judge input is unchanged", () => {
    const b = brief(["Owned the checkout API used by four storefront teams."]);
    expect(judgedBrief({ promptVersion: "v1", brief: b, inputTokens: 0, outputTokens: 0, latencyMs: 0 })).toBe(b);
  });

  it("projects a v2 brief to v1's exact shape: no exposure spans, rule_audit or dropped_points", () => {
    const out = judgedBrief({ promptVersion: "v2", brief: briefV2(), inputTokens: 0, outputTokens: 0, latencyMs: 0 });
    expect(FitBriefResponseV1Schema.safeParse(out).success).toBe(true);
    expect(Object.keys(out)).toEqual([
      "bottom_line",
      "strengths",
      "exposures",
      "positioning",
      "level_strategy",
      "homework",
      "questions_to_ask",
      "does_not_claim",
      "verdict",
    ]);
    expect(out.exposures).toEqual([{ jd_clause: "6+ years", gap: "g", handling: "h" }]);
    expect(JSON.stringify(out)).not.toMatch(/rule_audit|dropped_points|Clear writer|Product Manager, 2021/);
  });

  it("leaves level_strategy out when the v2 brief has none", () => {
    const { level_strategy: _l, ...rest } = briefV2();
    const out = judgedBrief({ promptVersion: "v2", brief: rest, inputTokens: 0, outputTokens: 0, latencyMs: 0 });
    expect("level_strategy" in out).toBe(false);
  });
});

describe("dropped points", () => {
  const v2Score = (dropped: FitBriefResponseV2["dropped_points"]) =>
    scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge(), generatedVerdict: "apply", dropped });

  it("counts them by reason, outside the closed failure categories", () => {
    const s = v2Score(briefV2().dropped_points);
    expect(s.droppedPoints).toEqual({ items: 2, byReason: { span_does_not_support: 1, no_span: 0, claim_rule: 1 } });
    expect(s.gatesPass).toBe(true);
    expect(FAILURE_CATEGORIES).toEqual(["evidence-quote", "extraction-paraphrase", "unsupported-claim", "claim-rule", "unscored"]);
  });

  it("rolls up briefs with a drop, items and reasons; a v1 run has no rollup", () => {
    const [dev] = aggregate([
      { split: "dev", score: v2Score(briefV2().dropped_points) },
      { split: "dev", score: v2Score([]) },
    ]);
    expect(dev!.droppedPoints).toEqual({ briefs: 1, items: 2, byReason: { span_does_not_support: 1, no_span: 0, claim_rule: 1 } });
    const v1 = scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge(), generatedVerdict: "apply" });
    expect(aggregate([{ split: "dev", score: v1 }])[0]!.droppedPoints).toBeUndefined();
  });
});

describe("short cited spans (v2 diagnostic)", () => {
  it("counts spans under four words, at the boundary and with stray whitespace", () => {
    expect(SHORT_SPAN_WORDS).toBe(4);
    expect(countShortSpans(["Led", " PCI ", "Owned the checkout", "Owned the checkout API", "Owned  the\ncheckout API daily"])).toEqual({
      spans: 5,
      short: 3,
    });
    expect(countShortSpans([])).toEqual({ spans: 0, short: 0 });
  });

  it("never touches the evidence gate: one-word spans found in the sources still pass", () => {
    const brief = { ...briefV2(), strengths: [{ jd_clause: "c", evidence: ["Led", "PCI"], argument: "a" }], exposures: [] };
    const evidence = checkEvidence(brief, ["Led the PCI audit for checkout."]);
    expect(evidence.unsupported).toEqual([]);
    const s = scoreBrief({ evidence, judge: judge(), generatedVerdict: "apply", dropped: [], citedSpans: briefQuotes(brief) });
    expect(s.gatesPass).toBe(true);
    expect(s.failureCategories).toEqual([]);
    expect(s.shortSpans).toEqual({ spans: 2, short: 2 });
  });

  it("rolls up by split and prints counts only; a v1 score has none", () => {
    const short = scoreBrief({ evidence: { total: 2, unsupported: [] }, judge: judge(), generatedVerdict: "apply", dropped: [], citedSpans: ["Led", "Owned the checkout API"] });
    const long = scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge(), generatedVerdict: "apply", dropped: [], citedSpans: ["Owned the checkout API"] });
    const [dev] = aggregate([{ split: "dev", score: short }, { split: "dev", score: long }, { split: "dev", score: null }]);
    expect(dev!.shortSpans).toEqual({ briefs: 1, spans: 3, short: 1 });
    const v1 = scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge(), generatedVerdict: "apply" });
    expect(v1.shortSpans).toBeUndefined();
    expect(aggregate([{ split: "dev", score: v1 }])[0]!.shortSpans).toBeUndefined();
    const out = formatAggregate([dev!], { model: "m", judgeModel: "j", evidenceMode: "resume", spentUsd: 0, incomplete: false });
    expect(out).toContain("Short cited spans (dev): 1 of 3 span(s) under 4 words, in 1 brief(s) (diagnostic only; the evidence gate is unchanged).");
    expect(out).not.toContain("Led");
  });
});

describe("formatAggregate across prompt versions", () => {
  const ok = scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge({ generated_points: [{ kind: "strength", index: 0, point: "g1", matches_reference: true }], reference_points: [{ kind: "strength", jd_clause: "c1", point: "p1", coverage: "covered" }] }), generatedVerdict: "apply" });
  const meta = {
    model: "claude-opus-5-5",
    effort: "high",
    generatorPrompt: "generation/fitBrief.v1",
    generatorRequest: "sha256:8f9a1d6d6a59",
    judgeModel: "claude-opus-5-5",
    judgeEffort: "high",
    judgePrompt: "judge sha256:5b48bb3edeed",
    corpus: "sha256:000000000000",
    evidenceMode: "resume",
    spentUsd: 1.5,
    maxUsd: 10,
    incomplete: false,
  };

  it("prints a v1 report byte-identically to the report before v2 existed", () => {
    // Captured from formatAggregate before the #655 change.
    expect(formatAggregate(aggregate([{ split: "dev", score: ok }, { split: "dev", score: null }]), meta)).toBe(
      "Fit-brief eval — model claude-opus-5-5 (effort high), corpus sha256:000000000000, evidence resume, judge claude-opus-5-5 (effort high); prompts generation/fitBrief.v1 (request sha256:8f9a1d6d6a59), judge sha256:5b48bb3edeed\n\n| split | briefs | gates passed | evidence-quote | extraction-paraphrase | unsupported-claim | claim-rule | unscored | recall* | precision* | verdict agreement |\n|---|---|---|---|---|---|---|---|---|---|---|\n| dev | 2 | 1/2 | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 1 (1) | 100.0% | 100.0% | 100.0% |\n\nFailure columns: briefs failing on the category (failing items). gates passed counts every brief, so an unscored brief is a gate failure.\n* model-graded by claude-opus-5-5; unsupported-claim and claim-rule are model-graded too.\nSpend (list-price estimate from usage records): $1.50.",
    );
  });

  it("names v2, its request and its check count in the header, and prints the self-audit counts only", () => {
    const v2 = scoreBrief({ evidence: { total: 1, unsupported: [] }, judge: judge(), generatedVerdict: "apply", dropped: briefV2().dropped_points });
    const out = formatAggregate(aggregate([{ split: "dev", score: v2 }]), {
      ...meta,
      generatorPrompt: "generation/fitBrief.v2",
      generatorRequest: "sha256:aaaaaaaaaaaa",
      claimRuleChecks: 7,
    });
    expect(out.split("\n")[0]).toMatch(/prompts generation\/fitBrief\.v2 \(request sha256:aaaaaaaaaaaa\), judge sha256:5b48bb3edeed, claim-rule checks 7$/);
    // v2's output budget, when given, sits before the check count (#655 round 2).
    const withBudget = formatAggregate(aggregate([{ split: "dev", score: v2 }]), {
      ...meta,
      generatorPrompt: "generation/fitBrief.v2",
      generatorRequest: "sha256:aaaaaaaaaaaa",
      generatorMaxTokens: 32_768,
      claimRuleChecks: 7,
    });
    expect(withBudget.split("\n")[0]).toMatch(/judge sha256:5b48bb3edeed, generator max_tokens 32768, claim-rule checks 7$/);
    expect(out).toContain("Self-audit dropped (dev): 2 point(s) in 1 brief(s) (span_does_not_support 1, no_span 0, claim_rule 1).");
    for (const leaked of ["Clear writer", "Certified", "Wrote the PCI policy", "writing"]) expect(out).not.toContain(leaked);
  });
});

describe("comparable", () => {
  const V1: FitBriefRunConfig = {
    model: "claude-opus-5-5",
    effort: "high",
    generatorPrompt: "generation/fitBrief.v1",
    generatorRequest: "sha256:8f9a1d6d6a59",
    judgeModel: "claude-opus-5-5",
    judgeEffort: "high",
    judgePrompt: "judge sha256:5b48bb3edeed",
    corpus: "sha256:bf240af90000",
    evidenceMode: "resume",
  };
  const V2: FitBriefRunConfig = {
    ...V1,
    generatorPrompt: "generation/fitBrief.v2",
    generatorRequest: "sha256:87bf32191ac1",
    generatorMaxTokens: 32_768,
    claimRuleChecks: 9,
  };

  it("accepts identical configs and the arms a matrix varies", () => {
    expect(comparable(V1, V1)).toEqual({ ok: true, differences: [] });
    const sonnet = { ...V1, model: "claude-sonnet-5-5", effort: "medium", generatorRequest: "sha256:35ab6febcd95" };
    expect(comparable(V1, sonnet)).toEqual({ ok: true, differences: ["model", "effort", "generatorRequest"] });
    expect(comparable(V1, { ...V1, evidenceMode: "units", extraction: "x", unitsFormat: "f", unitsSha256: "u" }).ok).toBe(true);
  });

  it("refuses a v1 run against a v2 run, naming both prompts and every difference", () => {
    const result = comparable(V1, V2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/generation\/fitBrief\.v1 vs generation\/fitBrief\.v2/);
    // The declared v2-minus-v1 contrast differs exactly here and nowhere else.
    expect(result.differences).toEqual(["generatorPrompt", "generatorRequest", "generatorMaxTokens", "claimRuleChecks"]);
    expect(comparable(V2, V1).ok).toBe(false);
  });

  it("refuses a different judge, corpus or in-place request change", () => {
    expect(comparable(V1, { ...V1, judgeModel: "claude-sonnet-5-5" })).toMatchObject({ ok: false, reason: expect.stringMatching(/judge/) });
    expect(comparable(V1, { ...V1, judgeEffort: "medium" })).toMatchObject({ ok: false, reason: expect.stringMatching(/judge/) });
    expect(comparable(V1, { ...V1, judgePrompt: "judge sha256:000000000000" })).toMatchObject({ ok: false });
    expect(comparable(V1, { ...V1, corpus: "sha256:111111111111" })).toMatchObject({ ok: false, reason: "different corpus inputs" });
    expect(comparable(V1, { ...V1, generatorRequest: "sha256:222222222222" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/request template changed/),
    });
  });

  it("refuses two v2 runs whose rules split differently", () => {
    expect(comparable(V2, { ...V2, claimRuleChecks: 8 })).toMatchObject({ ok: false, reason: expect.stringMatching(/claim-rule check/) });
  });

  it("refuses units-mode runs on different evidence", () => {
    const units = { ...V1, evidenceMode: "units", extraction: "x", unitsFormat: "f", unitsSha256: "u1" };
    expect(comparable(units, { ...units, unitsSha256: "u2" })).toMatchObject({ ok: false, reason: expect.stringMatching(/units-mode/) });
    expect(comparable(units, { ...units, unitsSource: "frozen" }).ok).toBe(true);
  });
});
