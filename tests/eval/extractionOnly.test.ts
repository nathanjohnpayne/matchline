/**
 * Extraction-only mode (#648). The Anthropic client is mocked; the OpenAI
 * client must never be touched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnthropicClient as Anthropic } from "../../functions/src/llm/anthropic.ts";
import { modelFor } from "../../functions/src/llm/config.ts";
import { priceFor } from "../../functions/src/llm/cost.ts";
import type { OpenAIClient as OpenAI } from "../../functions/src/llm/openai.ts";

import { loadLabels } from "./analyze.ts";
import { analyzeRecords } from "./analysis/analyzeRecords.ts";
import { extractionMetrics } from "./analysis/metrics.ts";
import {
  assertExtractionOnlyVariants,
  assertNoSentinelCollision,
  enumerateLabeledResumes,
  EXTRACTION_ONLY_JD_ID,
  extractionOnlyAdjust,
  runExtractionOnly,
  type ExtractionOnlyOptions,
} from "./extractionOnly.ts";
import { parseFlowsJsonl, type FlowRecord } from "./flowRecord.ts";
import { loadExpectedUnits, loadResumeText } from "./loadFixtures.ts";
import { DEFAULT_CAPS, HARD_THRESHOLD_FRACTION } from "./projection.ts";
import { FlowRecorder, type InvocationInput } from "./recorder.ts";
import { estimatePlannedSpend, extractionOnlyEstimate } from "./run.ts";
import { runExtractionForFixture, type RunForFixtureResult } from "./runForFixture.ts";
import { parseVariants } from "./sweep.ts";

const FIXTURES = join(process.cwd(), "tests", "fixtures");

function ids(dir: string, ext: string): string[] {
  return readdirSync(join(FIXTURES, dir))
    .filter((f) => f.endsWith(ext) && !f.startsWith(".") && f.toLowerCase() !== `readme${ext}`)
    .map((f) => f.slice(0, -ext.length));
}

/** Extraction tool input: two Units built from a résumé's own labels, so metrics are non-trivial. */
function extractionFor(resumeId: string): { units: Record<string, unknown>[] } {
  const eu = loadExpectedUnits(resumeId).expected_units.slice(0, 2);
  return {
    units: eu.map((e) => ({
      raw_text: e.normalized_summary,
      normalized_summary: e.normalized_summary,
      unit_type: "project",
      skills: [...e.skills],
      tools: [...(e.tools ?? [])],
      domains: [...(e.domains ?? [])],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified",
      confidence_score: 0.9,
    })),
  };
}

/** Anthropic mock answering every extraction with Units for the résumé in the prompt. */
function mockAnthropic(resumes: readonly string[]): Anthropic & { messages: { create: ReturnType<typeof vi.fn> } } {
  const texts = resumes.map((id) => [id, loadResumeText(id)] as const);
  let n = 0;
  return {
    messages: {
      create: vi.fn(async (params: { model: string; messages: { content: unknown }[] }) => {
        const body = JSON.stringify(params.messages);
        const match = texts.find(([, text]) => body.includes(JSON.stringify(text.slice(0, 80)).slice(1, -1)));
        n += 1;
        return {
          id: `msg_${n}`,
          type: "message",
          role: "assistant",
          model: params.model,
          content: [{ type: "tool_use", id: `toolu_${n}`, name: "tool", input: extractionFor(match?.[0] ?? resumes[0]!) }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      }),
    },
  } as unknown as Anthropic & { messages: { create: ReturnType<typeof vi.fn> } };
}

function throwingOpenAi(): OpenAI & { embeddings: { create: ReturnType<typeof vi.fn> } } {
  return {
    embeddings: {
      create: vi.fn(() => {
        throw new Error("OpenAI must not be called");
      }),
    },
  } as unknown as OpenAI & { embeddings: { create: ReturnType<typeof vi.fn> } };
}

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[k];
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], { env, stdio: ["ignore", "pipe", "pipe"] });
  return dir;
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "matchline-extraction-only-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("enumerateLabeledResumes", () => {
  it("pairs résumés with labels, lists the unlabeled, ignores READMEs and dotfiles", () => {
    for (const d of ["resumes", "expected-units"]) mkdirSync(join(base, d), { recursive: true });
    for (const id of ["a", "b", "c"]) writeFileSync(join(base, "resumes", `${id}.txt`), "x");
    writeFileSync(join(base, "resumes", "README.txt"), "x");
    writeFileSync(join(base, "resumes", ".hidden.txt"), "x");
    for (const id of ["b", "a"]) writeFileSync(join(base, "expected-units", `${id}.json`), "{}");
    expect(enumerateLabeledResumes(base)).toEqual({ labeled: ["a", "b"], unlabeled: ["c"] });
    writeFileSync(join(base, "expected-units", "d.json"), "{}");
    expect(() => enumerateLabeledResumes(base)).toThrow(/without a résumé fixture: d/);
  });

  it("reads the real fixtures: every résumé with an expected-units label", () => {
    const resumes = new Set(ids("resumes", ".txt"));
    const both = ids("expected-units", ".json").filter((id) => resumes.has(id)).sort();
    const { labeled } = enumerateLabeledResumes(FIXTURES);
    expect(labeled).toEqual(both);
    expect(labeled.length).toBeGreaterThan(4); // more than the 4 cells that have expected-matches
  });
});

describe("guards", () => {
  it("refuses a fixture that collides with the sentinel JD id", () => {
    expect(() => assertNoSentinelCollision(FIXTURES)).not.toThrow();
    mkdirSync(join(base, "jds"), { recursive: true });
    writeFileSync(join(base, "jds", `${EXTRACTION_ONLY_JD_ID}.txt`), "x");
    expect(() => assertNoSentinelCollision(base)).toThrow(/collide with the extraction-only sentinel/);
    rmSync(join(base, "jds"), { recursive: true });
    mkdirSync(join(base, "expected-matches"), { recursive: true });
    writeFileSync(join(base, "expected-matches", `r__${EXTRACTION_ONLY_JD_ID}.json`), "{}");
    expect(() => assertNoSentinelCollision(base)).toThrow(/expected-matches\/r__extraction-only\.json/);
    expect(EXTRACTION_ONLY_JD_ID).not.toContain("_");
  });

  it("refuses requirement-parsing knobs in variants and command-wide prompts", () => {
    expect(() => assertExtractionOnlyVariants(parseVariants(["--variant", "a:prompt.extraction/resume=v1"], "api"), {})).not.toThrow();
    expect(() =>
      assertExtractionOnlyVariants(parseVariants(["--variant", "a:model.requirement_parsing=claude-haiku-4-5-20251001"], "api"), {}),
    ).toThrow(/a: model\.requirement_parsing/);
    expect(() => assertExtractionOnlyVariants(parseVariants(["--variant", "a:prompt.parsing/jd=v1"], "api"), {})).toThrow(
      /a: prompt\.parsing\/jd/,
    );
    expect(() => assertExtractionOnlyVariants([], { "parsing/jd": "v1" })).toThrow(/--prompt parsing\/jd/);
  });

  it("extractionOnlyAdjust nulls the match fields and drops the parsing stage", () => {
    const record = {
      stages: { extraction: { model: "m" }, requirement_parsing: { model: "h" } },
      matchAccuracy: 0,
      matchCount: 0,
      extractionAccuracy: 0.5,
    } as unknown as FlowRecord;
    const out = extractionOnlyAdjust(record);
    expect(out.matchAccuracy).toBeNull();
    expect(out.matchCount).toBeNull();
    expect(Object.keys(out.stages)).toEqual(["extraction"]);
    expect(out.extractionAccuracy).toBe(0.5);
  });
});

describe("runExtractionForFixture", () => {
  // A labelled résumé with no expected-matches label at all: extraction-only must not need one.
  const matched = new Set(ids("expected-matches", ".json").map((c) => c.split("__")[0]));
  const unmatched = enumerateLabeledResumes(FIXTURES).labeled.find((id) => !matched.has(id));

  it("extracts and scores once, without a JD, embeddings or parsing", async () => {
    const resume = unmatched ?? "nathan-2026";
    const anthropic = mockAnthropic([resume]);
    const openai = throwingOpenAi();
    const result = await runExtractionForFixture(
      { resumeFixtureId: resume, jdFixtureId: EXTRACTION_ONLY_JD_ID },
      { anthropicClient: anthropic, openaiClient: openai },
    );
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
    expect(openai.embeddings.create).not.toHaveBeenCalled();
    expect(result.extractedUnitCount).toBe(2);
    expect(result.extractionAccuracy).toBeGreaterThan(0);
    expect([result.matchAccuracy, result.parsedRequirementCount, result.matchCount]).toEqual([0, 0, 0]);
    const extractionCost = priceFor(modelFor("extraction").model, { inputTokens: 100, outputTokens: 50 });
    expect(result.costUsd).toBeCloseTo(extractionCost, 12);
    expect(result.modeledCostUsd).toBeCloseTo(extractionCost, 12);
    const unmetered = await runExtractionForFixture(
      { resumeFixtureId: resume, jdFixtureId: EXTRACTION_ONLY_JD_ID },
      { anthropicClient: mockAnthropic([resume]), openaiClient: openai, anthropicIsMetered: false },
    );
    expect(unmetered.costUsd).toBe(0);
    expect(unmetered.modeledCostUsd).toBeCloseTo(extractionCost, 12);
  });

  it("refuses a real JD id, and captures a failure with its partial cost", async () => {
    await expect(
      runExtractionForFixture({ resumeFixtureId: "nathan-2026", jdFixtureId: "google-compute-spm-2026" }, {
        anthropicClient: mockAnthropic(["nathan-2026"]),
        openaiClient: throwingOpenAi(),
      }),
    ).rejects.toThrow(/must be "extraction-only"/);
    const failed = await runExtractionForFixture(
      { resumeFixtureId: "no-such-resume", jdFixtureId: EXTRACTION_ONLY_JD_ID },
      { anthropicClient: mockAnthropic(["nathan-2026"]), openaiClient: throwingOpenAi() },
    );
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/no-such-resume/);
    expect(failed.costUsd).toBe(0);
  });
});

describe("runExtractionOnly", () => {
  const labeled = enumerateLabeledResumes(FIXTURES).labeled;
  const apiEstimate = (flows: number) => ({ ...estimatePlannedSpend("full", flows), openaiUsd: 0 });
  const INVOCATION: InvocationInput = {
    argv: ["--extraction-only"],
    tokenSource: "api",
    cacheMode: "bypass",
    samples: 1,
    mode: "extraction-only",
    promptOverrides: {},
    variants: [],
  };

  function options(extra: Partial<ExtractionOnlyOptions> = {}): ExtractionOnlyOptions {
    return { fixturesDir: FIXTURES, samples: 1, variants: [], promptOverrides: {}, tokenSource: "api", estimate: apiEstimate, ...extra };
  }

  it("runs every labelled résumé, records extraction-only flows and prints extractionMetrics", async () => {
    const root = gitRepo(join(base, "repo"));
    const dir = join(base, "records");
    const recorder = FlowRecorder.prepare(dir, INVOCATION, { root, head: { sha: null, dirty: null } });
    const variants = parseVariants(["--variant", "a:prompt.extraction/resume=v1", "--variant", "b:prompt.extraction/resume=v1"], "api");
    const anthropic = mockAnthropic(labeled);
    const outcome = await runExtractionOnly(options({ variants, recorder }), { anthropicClient: anthropic, anthropicIsMetered: true });
    recorder.finish();
    expect(outcome.stderr).toBe("");
    expect(outcome.code).toBe(0);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(labeled.length * 2);

    const flows = parseFlowsJsonl(readFileSync(join(dir, "flows.jsonl"), "utf8"), dir);
    expect(flows).toHaveLength(labeled.length * 2);
    for (const f of flows) {
      expect(f.jdId).toBe(EXTRACTION_ONLY_JD_ID);
      expect(f.cell).toBe(`${f.resumeId}__extraction-only`);
      expect(f.matchAccuracy).toBeNull();
      expect(f.matchCount).toBeNull();
      expect(f.requirements).toBeNull();
      expect(f.parsedRequirementCount).toBeNull();
      expect(new Set(f.calls.map((c) => c.step))).toEqual(new Set(["extraction"]));
      expect(Object.keys(f.stages)).toEqual(["extraction"]);
      expect(f.units).toHaveLength(2);
    }
    expect([...new Set(flows.map((f) => f.variant))]).toEqual(["a", "b"]);
    expect(JSON.parse(readFileSync(join(dir, "invocation.json"), "utf8")).mode).toBe("extraction-only");

    // The printed metrics are extractionMetrics on the recorded flows.
    for (const f of flows) {
      const printed = outcome.flows.find((o) => o.variant === f.variant && o.resumeId === f.resumeId)!;
      const labels = { expectedUnits: loadExpectedUnits(f.resumeId).expected_units, resumeText: loadResumeText(f.resumeId) };
      expect(printed.metrics).toEqual(extractionMetrics(f, labels));
    }
    expect(outcome.stdout).toContain("| résumé | flows | failed | extraction accuracy | Unit precision | extracted Units | summary tokens | grounding share |");
    expect(outcome.stdout).toContain(`| **all (${labeled.length})** |`);

    // eval:analyze --task extraction reads them and compares the two arms.
    const analysisLabels = loadLabels(flows, "extraction");
    const analysis = analyzeRecords(flows, { task: "extraction", incumbent: "a", candidates: ["b"], labels: analysisLabels, seed: 1 });
    expect(analysis.arms.map((a) => a.label)).toEqual(["a", "b"]);
    expect(analysis.comparisons.length).toBeGreaterThan(0);
    expect(new Set(analysis.comparisons.map((c) => c.candidate))).toEqual(new Set(["b"]));
  });

  it("refuses before any call when the projection exceeds a cap", async () => {
    const root = gitRepo(join(base, "repo"));
    const dir = join(base, "records");
    const recorder = FlowRecorder.prepare(dir, INVOCATION, { root, head: { sha: null, dirty: null } });
    const anthropic = mockAnthropic(labeled);
    const outcome = await runExtractionOnly(options({ samples: 1000, recorder }), { anthropicClient: anthropic, anthropicIsMetered: true });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/projection exceeds a monthly cap\. .* Nothing ran/);
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
    // A subscription CLI source plans no Anthropic spend.
    const cli = await runExtractionOnly(options({ samples: 1000, estimate: () => ({ anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 }) }), {
      anthropicClient: anthropic,
      anthropicIsMetered: false,
      run: async (input): Promise<RunForFixtureResult> => fakeResult(input.resumeFixtureId, true),
    });
    expect(cli.code).toBe(0);
  });

  it("projection guard boundary: 45 api flows run, 46 are refused against the $25 cap", async () => {
    // One labelled résumé, so the flow count is the sample count.
    const one = join(base, "fixtures");
    for (const d of ["resumes", "expected-units"]) mkdirSync(join(one, d), { recursive: true });
    writeFileSync(join(one, "resumes", "nathan-2026.txt"), loadResumeText("nathan-2026"));
    writeFileSync(join(one, "expected-units", "nathan-2026.json"), readFileSync(join(FIXTURES, "expected-units", "nathan-2026.json")));
    expect(DEFAULT_CAPS.anthropicUsd).toBe(25);

    // The estimate the CLI passes (run.ts), driven at the boundary.
    const estimate = extractionOnlyEstimate("api");
    expect(estimate(45).anthropicUsd).toBeCloseTo(23.625, 9);
    expect(estimate(46).anthropicUsd).toBeCloseTo(24.15, 9);
    expect(estimate(46).openaiUsd).toBe(0);
    const run = vi.fn(async (input: { resumeFixtureId: string }): Promise<RunForFixtureResult> => fakeResult(input.resumeFixtureId, true));
    const deps = { anthropicClient: mockAnthropic(["nathan-2026"]), anthropicIsMetered: true, run };

    const allowed = await runExtractionOnly(options({ fixturesDir: one, samples: 45, estimate }), deps);
    expect(allowed.code).toBe(0);
    expect(run).toHaveBeenCalledTimes(45);
    const a = allowed.capChecks.find((c) => c.provider === "anthropic")!;
    expect(a).toMatchObject({ cap: 25, exceedsCap: false });
    expect(a.projectedUsd).toBeLessThanOrEqual(25 * HARD_THRESHOLD_FRACTION);

    const refused = await runExtractionOnly(options({ fixturesDir: one, samples: 46, estimate }), deps);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/1 résumé\(s\) x 46 sample\(s\) x 1 arm\(s\) = 46 flows, and the projection exceeds a monthly cap/);
    expect(run).toHaveBeenCalledTimes(45); // nothing ran for the refused run
    const r = refused.capChecks.find((c) => c.provider === "anthropic")!;
    expect(r).toMatchObject({ cap: 25, exceedsCap: true });
    expect(r.projectedUsd).toBeGreaterThan(25 * HARD_THRESHOLD_FRACTION);

    // claude-cli plans no Anthropic spend, so the same 46 flows run.
    const cli = await runExtractionOnly(
      options({ fixturesDir: one, samples: 46, tokenSource: "claude-cli", estimate: extractionOnlyEstimate("claude-cli") }),
      { ...deps, anthropicIsMetered: false },
    );
    expect(cli.code).toBe(0);
    expect(run).toHaveBeenCalledTimes(45 + 46);
  });

  it("exits 1 when every flow failed", async () => {
    const outcome = await runExtractionOnly(options(), {
      anthropicClient: mockAnthropic(labeled),
      anthropicIsMetered: true,
      run: async (input): Promise<RunForFixtureResult> => fakeResult(input.resumeFixtureId, false),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/all \d+ flow\(s\) failed/);
    expect(outcome.stdout).toContain(`| **all (${labeled.length})** | ${labeled.length} | ${labeled.length} |`);
  });
});

function fakeResult(resumeId: string, ok: boolean): RunForFixtureResult {
  return {
    resumeFixtureId: resumeId,
    jdFixtureId: EXTRACTION_ONLY_JD_ID,
    extractionAccuracy: ok ? 0.5 : 0,
    matchAccuracy: 0,
    latencyMs: 1,
    costUsd: 0,
    modeledCostUsd: 0,
    cacheHits: 0,
    cacheMisses: 1,
    extractedUnitCount: 0,
    parsedRequirementCount: 0,
    matchCount: 0,
    ok,
    error: ok ? null : "boom",
  };
}
