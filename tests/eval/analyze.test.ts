import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { flowsPath, loadFlows, parseAnalyzeArgs, runAnalyze } from "./analyze.ts";
import { repoRoot } from "./fitBrief/corpus.ts";
import { buildFlowRecord } from "./flowRecord.ts";
import { newFlowTrace } from "./flowTrace.ts";
import { loadExpectedMatches, loadExpectedUnits } from "./loadFixtures.ts";

describe("parseAnalyzeArgs", () => {
  it("reads several records directories, the task, incumbent, candidates and seed", () => {
    expect(
      parseAnalyzeArgs(["--records", "/a", "/b", "--task", "jd", "--incumbent", "base", "--candidates", "x, y", "--records=/c", "--seed", "7", "--out", "/o"]),
    ).toEqual({ records: ["/a", "/b", "/c"], task: "jd", incumbent: "base", candidates: ["x", "y"], out: "/o", seed: 7 });
    expect(parseAnalyzeArgs(["--records", "/a", "--task=extraction", "--incumbent=base"]).seed).toBe(20261028);
  });

  it("refuses missing, unknown, repeated or malformed flags", () => {
    const ok = ["--records", "/a", "--task", "jd", "--incumbent", "base"];
    expect(() => parseAnalyzeArgs(["--task", "jd", "--incumbent", "b"])).toThrow(/--records requires/);
    expect(() => parseAnalyzeArgs(["--records", "--task", "jd"])).toThrow(/--records requires a value/);
    expect(() => parseAnalyzeArgs([...ok.slice(0, 2), "--task", "units", "--incumbent", "b"])).toThrow(/extraction\|jd/);
    expect(() => parseAnalyzeArgs(ok.slice(0, 4))).toThrow(/--incumbent is required/);
    expect(() => parseAnalyzeArgs([...ok, "--incumbnt", "x"])).toThrow(/Unknown flag/);
    expect(() => parseAnalyzeArgs([...ok, "stray"])).toThrow(/Unexpected argument/);
    expect(() => parseAnalyzeArgs([...ok, "--task", "jd"])).toThrow(/more than once/);
    expect(() => parseAnalyzeArgs([...ok, "--candidates", ","])).toThrow(/at least one label/);
    expect(() => parseAnalyzeArgs([...ok, "--seed", "1.5"])).toThrow(/--seed/);
  });
});

describe("runAnalyze", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "matchline-analyze-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** Write one invocation's flows for the public nathan × google cell. */
  function writeRecords(dir: string, variant: string, invocationId: string, unitsKept: number, samples: number): void {
    mkdirSync(dir, { recursive: true });
    const expected = loadExpectedUnits("nathan-2026").expected_units;
    const reqs = loadExpectedMatches("nathan-2026", "google-compute-spm-2026").expected_requirements;
    const lines: string[] = [];
    for (let i = 0; i < samples; i++) {
      const trace = newFlowTrace();
      trace.units = expected.slice(0, unitsKept - (i % 2)).map((e) => ({
        raw_text: e.normalized_summary,
        normalized_summary: e.normalized_summary,
        skills: e.skills,
      }));
      trace.requirements = reqs.map((r) => ({ normalized_requirement: r.text, must_have: r.must_have }));
      trace.calls.push({
        step: "extraction",
        replayed: false,
        usage: { stage: "extraction", provider: "anthropic", model: "claude-sonnet-4-6", latencyMs: 900 + i, inputTokens: 1000, outputTokens: 500, attempt: 0, maxTokens: 16000 },
      });
      const flow = buildFlowRecord(
        {
          invocationId,
          variant,
          stages: {},
          embeddingModel: "text-embedding-3-small",
          resumeId: "nathan-2026",
          jdId: "google-compute-spm-2026",
          sampleIndex: i,
          startedAt: "2026-10-28T00:00:00.000Z",
          finishedAt: "2026-10-28T00:00:01.000Z",
        },
        {
          resumeFixtureId: "nathan-2026",
          jdFixtureId: "google-compute-spm-2026",
          extractionAccuracy: 0,
          matchAccuracy: 0.5,
          latencyMs: 1000,
          costUsd: 0,
          modeledCostUsd: 0.02,
          cacheHits: 0,
          cacheMisses: 4,
          extractedUnitCount: 0,
          parsedRequirementCount: 0,
          matchCount: 1,
          ok: true,
          error: null,
        },
        trace,
      );
      lines.push(JSON.stringify(flow));
    }
    writeFileSync(join(dir, "flows.jsonl"), `${lines.join("\n")}\n`);
  }

  it("pools invocations by label, prints Markdown, and writes the JSON beside the first records", () => {
    const a = join(base, "run-a");
    const b = join(base, "run-b");
    writeRecords(a, "sonnet", "inv-a", 22, 4);
    writeRecords(b, "haiku", "inv-b", 11, 4);
    const out = runAnalyze(parseAnalyzeArgs(["--records", a, b, "--task", "extraction", "--incumbent", "sonnet"]));
    expect(out.jsonPath).toBe(join(a, "analysis-extraction.json"));
    const json = JSON.parse(readFileSync(out.jsonPath, "utf8"));
    expect(json.arms.map((x: { label: string }) => x.label)).toEqual(["sonnet", "haiku"]);
    expect(json.comparisons.find((c: { metric: string }) => c.metric === "extraction_accuracy").diff).toBeLessThan(0);
    expect(out.markdown).toContain("# eval:analyze — extraction task");
    // Re-running gives byte-identical JSON.
    const again = runAnalyze(parseAnalyzeArgs(["--records", a, b, "--task", "extraction", "--incumbent", "sonnet", "--out", join(base, "o2")]));
    expect(readFileSync(again.jsonPath, "utf8")).toBe(readFileSync(out.jsonPath, "utf8"));

    const jd = runAnalyze(parseAnalyzeArgs(["--records", a, b, "--task", "jd", "--incumbent", "sonnet"]));
    const jdJson = JSON.parse(readFileSync(jd.jsonPath, "utf8"));
    expect(jdJson.arms[0].aggregate.requirement_set_accuracy).toBe(1);
  });

  it("refuses an --out inside the repository", () => {
    const a = join(base, "run-a");
    writeRecords(a, "sonnet", "inv-a", 22, 2);
    expect(() =>
      runAnalyze(parseAnalyzeArgs(["--records", a, "--task", "extraction", "--incumbent", "sonnet", "--out", join(repoRoot(), "tests", "eval", ".analysis-out")])),
    ).toThrow(/inside this repository/);
  });

  it("refuses an --out inside another worktree of the same repository", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[k];
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync("git", ["-C", cwd, ...args], { env, stdio: "ignore" });
    };
    const main = join(base, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "README"), "x\n");
    git(main, "add", "README");
    git(main, "-c", "user.name=Analyze Test", "-c", "user.email=analyze-test@example.invalid", "commit", "-q", "-m", "init");
    const wt = join(base, "wt");
    git(main, "worktree", "add", "-q", wt);
    const a = join(base, "run-a");
    writeRecords(a, "sonnet", "inv-a", 22, 2);
    const out = join(wt, "analysis");
    expect(() =>
      runAnalyze(parseAnalyzeArgs(["--records", a, "--task", "extraction", "--incumbent", "sonnet", "--out", out]), { root: main }),
    ).toThrow(/--out .* resolves inside this repository \(the checkout or worktree at /);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses the same flow identity pooled twice", () => {
    const a = join(base, "run-a");
    const b = join(base, "run-b");
    writeRecords(a, "sonnet", "inv-a", 22, 2);
    writeRecords(b, "haiku", "inv-b", 11, 2);
    // The same directory twice, and a directory plus its own flows.jsonl.
    expect(() => loadFlows([a, a])).toThrow(/same flow more than once.*inv-a sonnet nathan-2026__google-compute-spm-2026 #0/);
    expect(() => loadFlows([a, join(a, "flows.jsonl"), b])).toThrow(/same flow more than once/);
    expect(() =>
      runAnalyze(parseAnalyzeArgs(["--records", a, b, a, "--task", "extraction", "--incumbent", "sonnet", "--out", join(base, "o3")])),
    ).toThrow(/same flow more than once/);
    // Distinct invocations of the same arm pool as before.
    const c = join(base, "run-c");
    writeRecords(c, "sonnet", "inv-c", 22, 2);
    expect(loadFlows([a, b, c])).toHaveLength(6);
  });

  it("accepts a flows.jsonl path and names a directory that holds none", () => {
    const a = join(base, "run-a");
    writeRecords(a, "sonnet", "inv-a", 22, 1);
    expect(flowsPath(join(a, "flows.jsonl"))).toBe(join(a, "flows.jsonl"));
    expect(loadFlows([join(a, "flows.jsonl")])).toHaveLength(1);
    expect(() => loadFlows([join(base, "empty")])).toThrow(/no flows\.jsonl found/);
  });
});
