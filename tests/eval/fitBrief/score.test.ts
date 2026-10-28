import { describe, expect, it } from "vitest";

import type { FitBriefResponseV1 } from "../../../functions/src/prompts/generation/fitBrief.v1.schema.ts";

import type { JudgeResult } from "./judge.ts";
import {
  aggregate,
  checkEvidence,
  classifyUnsupportedQuotes,
  evidenceUnits,
  FAILURE_CATEGORIES,
  formatAggregate,
  normalizeForMatch,
  scoreBrief,
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
