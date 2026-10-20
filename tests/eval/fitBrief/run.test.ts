import { describe, expect, it, vi } from "vitest";

import type { UsageRecord } from "../../../functions/src/llm/cost.ts";
import type { FitBriefResponseV1 } from "../../../functions/src/prompts/generation/fitBrief.v1.schema.ts";

import type { FitBriefCorpus } from "./corpus.ts";
import type { JudgeResult } from "./judge.ts";
import { parseArgs, preflight, runFitBriefEval, type FitBriefEvalDeps, type FitBriefEvalOptions } from "./run.ts";

// Synthetic corpus only.
const CORPUS: FitBriefCorpus = {
  resumeText: "- Owned the checkout API used by four storefront teams.",
  claimRulesText: "Never claim PCI certification.",
  pairs: [
    { id: "secret-role-alpha", split: "dev", jdText: "JD alpha text", referenceText: "Reference alpha" },
    { id: "secret-role-beta", split: "dev", jdText: "JD beta text", referenceText: "Reference beta" },
    { id: "secret-role-gamma", split: "test", jdText: "JD gamma text", referenceText: "Reference gamma" },
  ],
};

const BRIEF: FitBriefResponseV1 = {
  bottom_line: "b",
  strengths: [{ jd_clause: "c", evidence: ["Owned the checkout API used by four storefront teams."], argument: "a" }],
  exposures: [],
  positioning: "p",
  homework: [],
  questions_to_ask: [],
  does_not_claim: [],
  verdict: "apply",
};

const JUDGEMENT: JudgeResult = {
  reference_points: [{ kind: "strength", jd_clause: "c", point: "p", coverage: "covered" }],
  generated_points: [{ kind: "strength", point: "g", matches_reference: true }],
  unsupported_candidate_claims: [],
  claim_rule_violations: [],
  reference_verdict: "apply",
};

const OPTIONS: FitBriefEvalOptions = {
  model: "claude-sonnet-4-6",
  judgeModel: "claude-opus-5-5",
  judgeEffort: "high",
  evidence: "resume",
  split: "dev",
  samples: 1,
  maxUsd: 100,
  outDir: "/private/out",
  runId: "run-1",
};

// Each call "costs" $1 on Sonnet 4.6 list price: 0 in, 66,667 out ≈ $1.00.
const usage = (stage: string): UsageRecord => ({
  stage,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputTokens: 0,
  outputTokens: 66_667,
  latencyMs: 1,
});

function deps(over: Partial<FitBriefEvalDeps> = {}): FitBriefEvalDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    generate: vi.fn(async (_input, record) => {
      await record(usage("fit_brief"));
      return { brief: BRIEF, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    }),
    judge: vi.fn(async (_args, record) => {
      await record(usage("fit_brief_judge"));
      return JUDGEMENT;
    }),
    extractUnits: vi.fn(async () => ["Owned the checkout API used by four storefront teams."]),
    writeFile: (p, d) => void files.set(p, d),
    ...over,
  };
}

describe("runFitBriefEval", () => {
  it("runs the selected split, writes per-pair files privately, and prints aggregates only", async () => {
    const d = deps();
    const out = await runFitBriefEval(CORPUS, OPTIONS, d);

    expect(d.generate).toHaveBeenCalledTimes(2);
    expect(out.rows).toHaveLength(2);
    expect(out.incomplete).toBe(false);
    expect(out.spentUsd).toBeCloseTo(4, 1);
    expect([...d.files.keys()].every((k) => k.startsWith("/private/out/"))).toBe(true);
    expect([...d.files.values()].join()).toContain("secret-role-alpha");
    // The printed report never carries a pair id or corpus text.
    for (const leaked of ["secret-role", "JD alpha", "Reference alpha", "checkout API"]) {
      expect(out.report).not.toContain(leaked);
    }
  });

  it("passes claim rules to the generator and the judge", async () => {
    const d = deps();
    await runFitBriefEval(CORPUS, OPTIONS, d);
    expect(vi.mocked(d.generate).mock.calls[0]![0].claimRulesText).toContain("PCI");
    expect(vi.mocked(d.judge).mock.calls[0]![0].claimRulesText).toContain("PCI");
  });

  it("stops at the spend bound and reports the run as incomplete", async () => {
    const d = deps();
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, split: "all", maxUsd: 2 }, d);
    expect(d.generate).toHaveBeenCalledTimes(1);
    expect(out.incomplete).toBe(true);
    expect(out.report).toMatch(/INCOMPLETE/);
  });

  it("counts a failed brief and keeps going", async () => {
    const d = deps({
      generate: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const out = await runFitBriefEval(CORPUS, OPTIONS, d);
    expect(out.rows.every((r) => r.score === null)).toBe(true);
    expect([...d.files.values()].join()).toContain("boom");
  });

  it("in units mode, grounds the brief and the evidence check on extracted Units", async () => {
    const d = deps();
    await runFitBriefEval(CORPUS, { ...OPTIONS, evidence: "units" }, d);
    expect(d.extractUnits).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.generate).mock.calls[0]![0].resumeText).toBe(
      "- Owned the checkout API used by four storefront teams.",
    );
  });

  it("runs each pair once per sample", async () => {
    const d = deps();
    await runFitBriefEval(CORPUS, { ...OPTIONS, samples: 2 }, d);
    expect(d.generate).toHaveBeenCalledTimes(4);
  });
});

describe("preflight", () => {
  it("refuses an unpriced or unprofiled model before any spend", () => {
    expect(() => preflight({ ...OPTIONS, model: "claude-unknown" })).toThrow(/No rate registered/);
  });

  it("refuses an effort the model does not accept", () => {
    expect(() => preflight({ ...OPTIONS, effort: "low" })).toThrow(/does not accept effort low/);
  });

  it("accepts the defaults", () => {
    expect(() => preflight(OPTIONS)).not.toThrow();
  });
});

describe("parseArgs", () => {
  const now = new Date("2026-10-28T12:00:00Z");

  it("requires --model and, for a paid run, --max-usd", () => {
    expect(() => parseArgs([], now)).toThrow(/--model is required/);
    expect(() => parseArgs(["--model", "claude-sonnet-5-5"], now)).toThrow(/--max-usd is required/);
    expect(parseArgs(["--model", "claude-sonnet-5-5", "--dry-run"], now).dryRun).toBe(true);
  });

  it("defaults the judge, split, evidence and private output directory", () => {
    const o = parseArgs(["--model", "claude-sonnet-5-5", "--max-usd", "10"], now);
    expect(o).toMatchObject({
      judgeModel: "claude-opus-5-5",
      judgeEffort: "high",
      split: "dev",
      evidence: "resume",
      samples: 1,
      maxUsd: 10,
    });
    expect(o.outDir).toMatch(/\.matchline\/eval-private\/fit-brief\/fit-brief-2026-10-28T12-00-00-000Z$/);
  });

  it("rejects unknown flags and bad values", () => {
    expect(() => parseArgs(["--model", "m", "--max-usd", "1", "--splt", "dev"], now)).toThrow(/Unknown flag/);
    expect(() => parseArgs(["--model", "m", "--max-usd", "1", "--effort", "extreme"], now)).toThrow(/--effort/);
    expect(() => parseArgs(["--model", "m", "--max-usd", "1", "--split", "train"], now)).toThrow(/--split/);
    expect(() => parseArgs(["--model", "m", "--max-usd", "1", "--samples", "0"], now)).toThrow(/--samples/);
  });
});
