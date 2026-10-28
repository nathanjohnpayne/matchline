import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { UsageRecord } from "../../../functions/src/llm/cost.ts";
import type { FitBriefResponseV1 } from "../../../functions/src/prompts/generation/fitBrief.v1.schema.ts";

import type { FitBriefCorpus } from "./corpus.ts";
import type { JudgeResult } from "./judge.ts";
import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";

import {
  BudgetReachedError,
  guardClient,
  parseArgs,
  preflight,
  prepareOutDir,
  RUN_LOCK,
  runFitBriefEval,
  extractionConfigLabel,
  ExtractionTruncatedError,
  parseFrozenUnits,
  stopAfterTruncation,
  renderUnitEvidence,
  UNITS_FORMAT_FINGERPRINT,
  writePrivateFile,
  type FitBriefEvalDeps,
  type FitBriefEvalOptions,
} from "./run.ts";

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
  generated_points: [{ kind: "strength", index: 0, point: "g", matches_reference: true }],
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
    extractUnits: vi.fn(async () => [{ raw_text: "Owned the checkout API used by four storefront teams." }]),
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

  it("does not start the judge once generation reaches the bound, and reports incomplete (Codex P1, #581)", async () => {
    const d = deps();
    // Generation costs ~$1, so a $1 bound is reached before the judge.
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, maxUsd: 1 }, d);
    expect(d.generate).toHaveBeenCalledTimes(1);
    expect(d.judge).not.toHaveBeenCalled();
    expect(out.incomplete).toBe(true);
    expect([...d.files.values()].join()).toContain("spend bound reached");
  });

  it("says so when a call in flight overran the bound", async () => {
    const d = deps();
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, maxUsd: 1.5 }, d);
    expect(out.spentUsd).toBeGreaterThan(1.5);
    expect(out.report).toMatch(/exceeded --max-usd \$1\.50/);
  });

  it("refuses a split with no pairs instead of reporting an empty pass (Codex P1, #581)", async () => {
    const devOnly: FitBriefCorpus = { ...CORPUS, pairs: CORPUS.pairs.filter((p) => p.split === "dev") };
    await expect(runFitBriefEval(devOnly, { ...OPTIONS, split: "test" }, deps())).rejects.toThrow(
      /no pairs in split "test"/,
    );
  });

  it("makes no paid call at all when the bound is already reached, units extraction included", async () => {
    const d = deps();
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, evidence: "units", maxUsd: 0 }, d);
    expect(d.extractUnits).not.toHaveBeenCalled();
    expect(d.generate).not.toHaveBeenCalled();
    expect(out.incomplete).toBe(true);
  });

  it("reports the effort actually sent, including 5.5 profile defaults and the judge's", async () => {
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, model: "claude-sonnet-5-5" }, deps());
    expect(out.report).toContain("claude-sonnet-5-5 (effort high)");
    expect(out.report).toContain("judge claude-opus-5-5 (effort high)");
  });

  it("keeps per-attempt failure detail in the private artifact (Codex review, #581)", async () => {
    const d = deps({
      generate: vi.fn(async () => {
        throw Object.assign(new Error("Fit brief failed after 1 attempts."), {
          failures: [{ attempt: 0, kind: "transport_error", message: "401 invalid x-api-key" }],
        });
      }),
    });
    await runFitBriefEval(CORPUS, OPTIONS, d);
    const first = JSON.parse([...d.files.values()][0]!);
    expect(first.failures[0].message).toContain("401");
  });

  it("keeps the paid-for brief when only the judge fails (CodeRabbit, #581)", async () => {
    const d = deps({
      judge: vi.fn(async () => {
        throw new Error("judge refused");
      }),
    });
    await runFitBriefEval(CORPUS, OPTIONS, d);
    const first = JSON.parse([...d.files.values()][0]!);
    expect(first.error).toBe("judge refused");
    expect(first.brief.verdict).toBe("apply");
  });

  it("never lets a pair id shape the output path (CodeRabbit, #581)", async () => {
    const d = deps();
    const hostile: FitBriefCorpus = {
      ...CORPUS,
      pairs: [{ ...CORPUS.pairs[0]!, id: "../../../../etc/x" }],
    };
    await runFitBriefEval(hostile, OPTIONS, d);
    const [path] = [...d.files.keys()];
    expect(path!.startsWith("/private/out/")).toBe(true);
    expect(path!.slice("/private/out/".length)).not.toContain("/");
  });

  it("writes owner-only files by default (CodeRabbit, #581)", async () => {
    const out = mkdtempSync(join(tmpdir(), "fit-brief-out-"));
    try {
      const { writeFile: _ignored, ...noWriter } = deps();
      await runFitBriefEval(CORPUS, { ...OPTIONS, outDir: out }, noWriter);
      const files = readdirSync(out);
      expect(files.length).toBe(2);
      for (const f of files) expect(statSync(join(out, f)).mode & 0o077).toBe(0);

      // A file left from an earlier run with looser permissions is tightened (Codex P2, #581).
      const reused = join(out, files[0]!);
      writeFileSync(reused, "old");
      chmodSync(reused, 0o644);
      await runFitBriefEval(CORPUS, { ...OPTIONS, outDir: out }, noWriter);
      expect(statSync(reused).mode & 0o077).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
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

  it("records the generator and judge prompt revisions in the report and every artifact (Codex P2, #581)", async () => {
    const d = deps();
    const out = await runFitBriefEval(CORPUS, OPTIONS, d);
    expect(out.report).toMatch(/prompts generation\/fitBrief\.v\d+ \(request sha256:[0-9a-f]{12}\), judge sha256:[0-9a-f]{12}/);
    for (const text of d.files.values()) {
      expect(JSON.parse(text).config).toMatchObject({
        generatorPrompt: expect.stringMatching(/^generation\/fitBrief\.v\d+$/),
        generatorRequest: expect.stringMatching(/^sha256:[0-9a-f]{12}$/),
        judgePrompt: expect.stringMatching(/^judge sha256:[0-9a-f]{12}$/),
        evidenceMode: "resume",
      });
    }
  });

  it("fingerprints the corpus inputs, changing when any of them does (Codex P2, #581)", async () => {
    const corpusOf = async (c: FitBriefCorpus) => {
      const d = deps();
      const out = await runFitBriefEval(c, OPTIONS, d);
      const config = JSON.parse([...d.files.values()][0]!).config;
      expect(out.report).toContain(`corpus ${config.corpus}`);
      return config.corpus as string;
    };
    const base = await corpusOf(CORPUS);
    expect(base).toMatch(/^sha256:[0-9a-f]{12}$/);
    // The private text itself is never in the config.
    expect(base).not.toContain("storefront");
    expect(await corpusOf({ ...CORPUS, resumeText: CORPUS.resumeText + " (rev 2)" })).not.toBe(base);
    expect(
      await corpusOf({ ...CORPUS, pairs: CORPUS.pairs.map((p, i) => (i === 0 ? { ...p, referenceText: "Revised" } : p)) }),
    ).not.toBe(base);
  });

  it("saves the exact Units a units-mode run used, and records their hash (Codex P2, #581)", async () => {
    const d = deps({ extractionConfig: "claude-haiku-4-5, prompt extraction/resume.v3" });
    await runFitBriefEval(CORPUS, { ...OPTIONS, evidence: "units" }, d);
    const saved = JSON.parse(d.files.get("/private/out/units.json")!);
    expect(saved).toEqual({
      resume_sha256: createHash("sha256").update(CORPUS.resumeText).digest("hex"),
      extraction: "claude-haiku-4-5, prompt extraction/resume.v3",
      units: [{ raw_text: "Owned the checkout API used by four storefront teams." }],
    });
    const artifact = JSON.parse([...d.files].find(([k]) => k !== "/private/out/units.json")![1]);
    expect(artifact.config).toMatchObject({ unitsSource: "extracted", unitsSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("reuses frozen Units without extracting, under the extraction pin that made them (Codex P2, #581)", async () => {
    const d = deps({ extractionConfig: "current-pin" });
    const frozen = parseFrozenUnits(
      JSON.stringify({
        resume_sha256: createHash("sha256").update(CORPUS.resumeText).digest("hex"),
        extraction: "old-pin",
        units: [{ raw_text: "Owned the checkout API used by four storefront teams.", date_range: { start: "2021-03" } }],
      }),
      CORPUS.resumeText,
    );
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, evidence: "units", frozenUnits: frozen }, d);
    expect(d.extractUnits).not.toHaveBeenCalled();
    expect(out.report).toContain("extraction old-pin");
    expect(out.report).toMatch(/units frozen sha256:[0-9a-f]{12}\)/);
    const artifact = JSON.parse([...d.files].find(([k]) => k !== "/private/out/units.json")![1]);
    expect(artifact.config).toMatchObject({ unitsSource: "frozen", extraction: "old-pin" });
    expect(JSON.parse(vi.mocked(d.generate).mock.calls[0]![0].resumeText)).toEqual([
      { text: "Owned the checkout API used by four storefront teams.", dates_from_extraction: "2021-03 to present" },
    ]);
  });

  it("refuses frozen Units extracted from a different résumé", () => {
    const text = JSON.stringify({ resume_sha256: "0".repeat(64), extraction: "pin", units: [] });
    expect(() => parseFrozenUnits(text, CORPUS.resumeText)).toThrow(/different résumé/);
    expect(() => parseFrozenUnits(JSON.stringify({ extraction: "pin", units: [] }), CORPUS.resumeText)).toThrow(/Invalid/);
  });

  it("in units mode, the generator reads Units but the gates keep the canonical sources (Codex P1, #581)", async () => {
    const withInventory: FitBriefCorpus = { ...CORPUS, inventoryText: "Tools: Looker" };
    const d = deps({ extractUnits: vi.fn(async () => [{ raw_text: "Owned the checkout API used by twelve teams." }]) });
    const out = await runFitBriefEval(withInventory, { ...OPTIONS, evidence: "units" }, { ...d, extractionConfig: "claude-haiku-4-5, prompt extraction/resume.v3" });
    // The report names the extraction pin behind the evidence (Codex P2, #581).
    expect(out.report).toContain(
      `evidence units (extraction claude-haiku-4-5, prompt extraction/resume.v3, format ${UNITS_FORMAT_FINGERPRINT}, units extracted sha256:`,
    );
    const gen = vi.mocked(d.generate).mock.calls[0]![0];
    expect(JSON.parse(gen.resumeText)).toEqual([
      { text: "Owned the checkout API used by twelve teams.", dates_from_extraction: null },
    ]);
    // The inventory reaches the generator in both modes.
    expect(gen.inventoryText).toBe("Tools: Looker");
    // The judge grounds on the résumé and inventory, not the extracted Units.
    const sources = vi.mocked(d.judge).mock.calls[0]![0].sourcesText;
    expect(sources).toContain("four storefront teams");
    expect(sources).toContain("Tools: Looker");
    expect(sources).not.toContain("twelve teams");
  });

  it("stops at the bound inside a stage's retries, not only between stages (Codex P1, #581)", async () => {
    // Each internal attempt checks the guard, then costs ~$1.
    const d = deps({
      generate: vi.fn(async (_input, record, guard) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          guard();
          await record(usage("fit_brief"));
        }
        return { brief: BRIEF, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
      }),
    });
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, maxUsd: 1.5 }, d);
    expect(out.spentUsd).toBeLessThan(2.1);
    expect(d.judge).not.toHaveBeenCalled();
    expect(out.incomplete).toBe(true);
    // A sample stopped by the bound is unfinished, not a failed brief.
    expect(out.rows).toHaveLength(0);
  });

  it("stops before units extraction's retries pass the bound", async () => {
    const d = deps({
      // Each extraction attempt checks the guard, then costs ~$1, so the
      // guard itself must stop the second attempt (CodeRabbit on #581).
      extractUnits: vi.fn(async (_text, record, guard) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          guard();
          await record(usage("extraction"));
        }
        return [{ raw_text: "unreachable" }];
      }),
    });
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, evidence: "units", maxUsd: 0.5 }, d);
    expect(out.incomplete).toBe(true);
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("runs each pair once per sample", async () => {
    const d = deps();
    await runFitBriefEval(CORPUS, { ...OPTIONS, samples: 2 }, d);
    expect(d.generate).toHaveBeenCalledTimes(4);
  });
});

describe("writePrivateFile", () => {
  it("replaces a planted symlink instead of writing through it (Codex review, #581)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-brief-wpf-"));
    try {
      const target = join(dir, "elsewhere.json");
      writeFileSync(target, "public");
      const out = join(dir, "001-a-s0.json");
      symlinkSync(target, out);
      writePrivateFile(out, "private");
      expect(readFileSync(target, "utf8")).toBe("public");
      expect(lstatSync(out).isSymbolicLink()).toBe(false);
      expect(readFileSync(out, "utf8")).toBe("private");
      expect(statSync(out).mode & 0o077).toBe(0);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prepareOutDir", () => {
  it("claims the directory exclusively, so a concurrent run on it is refused (Codex P2, #581)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-brief-out-"));
    try {
      const run = join(dir, "run");
      prepareOutDir(run);
      expect(readdirSync(run)).toEqual([RUN_LOCK]);
      // A second run that raced past the emptiness check still loses the lock.
      expect(() => prepareOutDir(run)).toThrow(/not empty|already in use/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-empty directory without changing its permissions (Codex P1, #581)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-brief-out-"));
    try {
      chmodSync(dir, 0o755);
      writeFileSync(join(dir, "someone-elses-file"), "x");
      expect(() => prepareOutDir(dir)).toThrow(/is not empty/);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("refuses a directory that already holds an earlier run's files (Codex P2, #581)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-brief-out-"));
    try {
      writeFileSync(join(dir, "001-old-s1.json"), "{}");
      expect(() => prepareOutDir(dir)).toThrow(/is not empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("tightens an existing world-readable output directory (Codex P2, #581)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-brief-out-"));
    try {
      chmodSync(dir, 0o755);
      prepareOutDir(dir);
      expect(statSync(dir).mode & 0o077).toBe(0);
      const fresh = join(dir, "run-1");
      prepareOutDir(fresh);
      expect(statSync(fresh).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writePrivateFile cleanup", () => {
  it("removes the temp file when the rename fails (CodeRabbit, #581)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fit-brief-wpf-"));
    try {
      // A directory at the destination makes the rename fail.
      const dest = join(dir, "001-a-s0.json");
      mkdirSync(join(dest, "inner"), { recursive: true });
      expect(() => writePrivateFile(dest, "private")).toThrow();
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("guardClient", () => {
  it("checks the budget before every request and makes none once it is reached", async () => {
    const create = vi.fn(async () => ({ ok: true }));
    let spent = 0;
    const guarded = guardClient({ messages: { create } } as unknown as Anthropic, () => {
      if (spent >= 1) throw new BudgetReachedError();
    });
    await guarded.messages.create({} as never);
    spent = 1;
    await expect(guarded.messages.create({} as never)).rejects.toBeInstanceOf(BudgetReachedError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("raises a non-retryable status so stage retry loops stop", () => {
    expect(new BudgetReachedError().status).toBe(402);
  });
});

describe("extractionConfigLabel", () => {
  it("names the extraction model and prompt version extractFromResume will use", () => {
    expect(extractionConfigLabel()).toMatch(/^claude-[a-z0-9-]+( effort [a-z]+)?, prompt extraction\/resume\.v\d+$/);
  });
});

describe("stopAfterTruncation", () => {
  it("fails later extraction attempts locally once a response is truncated (Codex P2, #581)", async () => {
    const create = vi.fn(async () => ({ stop_reason: "max_tokens", content: [] }));
    const client = stopAfterTruncation({ messages: { create } } as unknown as Anthropic);
    await client.messages.create({} as never);
    await expect(client.messages.create({} as never)).rejects.toBeInstanceOf(ExtractionTruncatedError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("passes complete responses through untouched", async () => {
    const create = vi.fn(async () => ({ stop_reason: "tool_use", content: [] }));
    const client = stopAfterTruncation({ messages: { create } } as unknown as Anthropic);
    await client.messages.create({} as never);
    await client.messages.create({} as never);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("renderUnitEvidence", () => {
  it("keeps each Unit whole, in order, with its dates off its text (Codex P2 and P1, #581)", () => {
    const rendered = renderUnitEvidence([
      { raw_text: "Led X.", date_range: { start: "2021-03", end: "2024-06" } },
      { raw_text: "Led Y.\n## Dates 1999\n- Saved $5M.", date_range: { start: "2024-07" } },
      { raw_text: "Led Z." },
      { raw_text: "Led W.", date_range: { start: "2021-03", end: "2024-06" } },
      { raw_text: "Led V." },
    ]);
    expect(JSON.parse(rendered)).toEqual([
      { text: "Led X.", dates_from_extraction: "2021-03 to 2024-06" },
      // A multi-line Unit with Markdown markers stays one Unit.
      { text: "Led Y.\n## Dates 1999\n- Saved $5M.", dates_from_extraction: "2024-07 to present" },
      { text: "Led Z.", dates_from_extraction: null },
      // Units sharing dates are not pulled together out of order.
      { text: "Led W.", dates_from_extraction: "2021-03 to 2024-06" },
      { text: "Led V.", dates_from_extraction: null },
    ]);
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

  it("rejects positional words, single-dash typos and repeated flags before a paid run (Codex P2, #581)", () => {
    const base = ["--model", "claude-sonnet-5-5", "--max-usd", "10"];
    expect(() => parseArgs([...base, "-split", "test"], now)).toThrow(/Unexpected argument -split/);
    expect(() => parseArgs([...base, "test"], now)).toThrow(/Unexpected argument test/);
    expect(() => parseArgs([...base, "--split", "dev", "--split=test"], now)).toThrow(/more than once/);
    // A flag's value is consumed, not mistaken for a positional word.
    expect(parseArgs([...base, "--split", "test", "--samples=2"], now)).toMatchObject({ split: "test", samples: 2 });
  });

  it("accepts --units-from only with --evidence units", () => {
    const base = ["--model", "claude-sonnet-5-5", "--max-usd", "10"];
    expect(() => parseArgs([...base, "--units-from", "/tmp/u.json"], now)).toThrow(/needs --evidence units/);
    expect(parseArgs([...base, "--evidence", "units", "--units-from", "/tmp/u.json"], now).unitsFrom).toBe("/tmp/u.json");
  });

  it("rejects a value on --dry-run instead of silently running a paid job (Codex P2, #581)", () => {
    expect(() => parseArgs(["--model", "m", "--max-usd", "5", "--dry-run=true"], now)).toThrow(/takes no value/);
  });

  it("defaults judge effort only for a judge that accepts effort (Codex P2, #581)", () => {
    expect(parseArgs(["--model", "m", "--dry-run"], now).judgeEffort).toBe("high");
    const legacy = parseArgs(["--model", "m", "--dry-run", "--judge-model", "claude-sonnet-4-6"], now);
    expect(legacy.judgeEffort).toBeUndefined();
    expect(() => preflight({ ...OPTIONS, judgeModel: "claude-sonnet-4-6", judgeEffort: undefined })).not.toThrow();
  });

  it("rejects unknown flags and bad values", () => {
    expect(() => parseArgs(["--model", "m", "--max-usd", "1", "--splt", "dev"], now)).toThrow(/Unknown flag/);
    expect(() => parseArgs(["--model", "m", "--max-usd", "1", "--effort", "extreme"], now)).toThrow(/--effort/);
    expect(() => parseArgs(["--model", "m", "--max-usd", "1", "--split", "train"], now)).toThrow(/--split/);
    expect(() => parseArgs(["--model", "m", "--max-usd", "1", "--samples", "0"], now)).toThrow(/--samples/);
  });
});

describe("evidence failure classes in the run (units mode)", () => {
  const PARAPHRASE = "Owned the checkout API used by twelve teams.";
  const quoting = (evidence: string[]): FitBriefResponseV1 => ({ ...BRIEF, strengths: [{ jd_clause: "c", evidence, argument: "a" }] });

  it("carries extraction-paraphrase and unsupported-quote counts into each artifact and the aggregate", async () => {
    const d = deps({
      extractUnits: vi.fn(async () => [{ raw_text: PARAPHRASE }]),
      generate: vi.fn(async (_input, record) => {
        await record(usage("fit_brief"));
        return { brief: quoting([PARAPHRASE, "Ran payroll for a bank."]), inputTokens: 0, outputTokens: 0, latencyMs: 0 };
      }),
    });
    const out = await runFitBriefEval(CORPUS, { ...OPTIONS, evidence: "units" }, d);
    const artifacts = [...d.files].filter(([k]) => k !== "/private/out/units.json").map(([, v]) => JSON.parse(v));
    expect(artifacts).toHaveLength(2);
    for (const a of artifacts) {
      expect(a.evidence).toMatchObject({ extractionParaphrase: [PARAPHRASE], unsupportedQuote: ["Ran payroll for a bank."] });
      expect(a.score).toMatchObject({
        evidenceExtractionParaphrase: 1,
        evidenceUnsupportedQuote: 1,
        failureCategories: ["evidence-quote", "extraction-paraphrase"],
        gatesPass: false,
      });
    }
    expect(out.report).toContain("| dev | 2 | 0/2 | 2 (2) | 2 (2) | 0 (0) | 0 (0) | 0 (0) |");
    // stdout stays aggregates-only.
    expect(out.report).not.toContain("twelve teams");
    expect(out.report).not.toContain("payroll");
  });

  it("in résumé mode every failed quote is an evidence-quote failure", async () => {
    const d = deps({
      generate: vi.fn(async (_input, record) => {
        await record(usage("fit_brief"));
        return { brief: quoting([PARAPHRASE]), inputTokens: 0, outputTokens: 0, latencyMs: 0 };
      }),
    });
    const out = await runFitBriefEval(CORPUS, OPTIONS, d);
    const artifact = JSON.parse([...d.files.values()][0]!);
    expect(artifact.evidence.extractionParaphrase).toBeUndefined();
    expect(artifact.score.failureCategories).toEqual(["evidence-quote"]);
    expect(out.report).toContain("| dev | 2 | 0/2 | 2 (2) | 0 (0) | 0 (0) | 0 (0) | 0 (0) |");
  });

  it("counts an unscored brief against the printed pass rate and marks its artifact", async () => {
    let n = 0;
    const d = deps({
      generate: vi.fn(async (_input, record) => {
        n += 1;
        if (n === 2) throw new Error("boom");
        await record(usage("fit_brief"));
        return { brief: BRIEF, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
      }),
    });
    const out = await runFitBriefEval(CORPUS, OPTIONS, d);
    expect(out.report).toContain("| dev | 2 | 1/2 | 0 (0) | 0 (0) | 0 (0) | 0 (0) | 1 (1) |");
    const failedArtifact = [...d.files.values()].map((v) => JSON.parse(v)).find((a) => a.error !== undefined);
    expect(failedArtifact.failureCategories).toEqual(["unscored"]);
  });
});
