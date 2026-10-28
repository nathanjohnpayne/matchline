import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearEffortOverrides, clearModelOverrides, modelFor, setEffortOverrides } from "../../functions/src/llm/config.ts";
import type { UsageRecord } from "../../functions/src/llm/cost.ts";
import { profileFor } from "../../functions/src/llm/modelProfile.ts";

import { repoRoot } from "./fitBrief/corpus.ts";
import { parseFlowsJsonl } from "./flowRecord.ts";
import {
  assertRecordDirOutsideRepo,
  captureStageConfig,
  describeVariants,
  FlowRecorder,
  parseRecordDir,
  recordingRunner,
  type FlowRunner,
  type InvocationInput,
} from "./recorder.ts";
import { assertKnownFlags } from "./run.ts";
import type { RunForFixtureResult } from "./runForFixture.ts";
import { runVariant, type SweepVariant } from "./sweep.ts";

const INVOCATION: InvocationInput = {
  argv: ["--record", "/x"],
  tokenSource: "api",
  cacheMode: "bypass",
  samples: 2,
  mode: "full",
  promptOverrides: {},
  variants: [],
};

const result = (resume: string, jd: string, ok = true): RunForFixtureResult => ({
  resumeFixtureId: resume,
  jdFixtureId: jd,
  extractionAccuracy: ok ? 0.5 : 0,
  matchAccuracy: ok ? 0.4 : 0,
  latencyMs: 10,
  costUsd: 0,
  modeledCostUsd: 0.01,
  cacheHits: 0,
  cacheMisses: 4,
  extractedUnitCount: 1,
  parsedRequirementCount: 1,
  matchCount: 1,
  ok,
  error: ok ? null : "boom",
});

/** A fake flow that fills the trace the way runForFixture would. */
const fakeRun: FlowRunner = async (input, deps) => {
  const usage: UsageRecord = { stage: "extraction", provider: "anthropic", model: "m", latencyMs: 3, inputTokens: 1, outputTokens: 1, attempt: 0, maxTokens: 10 };
  deps.trace?.calls.push({ step: "extraction", replayed: false, usage });
  if (deps.trace) deps.trace.units = [{ raw_text: "u" }];
  return result(input.resumeFixtureId, input.jdFixtureId);
};

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "matchline-recorder-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  clearEffortOverrides();
  clearModelOverrides();
});

/** Hermetic git: no global or system config, and no repository inherited from a hook environment. */
function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[k];
  return execFileSync("git", ["-C", cwd, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** A fresh git repository at `dir` (the recorder refuses a root git cannot describe). */
function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function clock(): { now: () => Date } {
  let t = Date.parse("2026-10-28T09:00:00.000Z");
  return { now: () => new Date((t += 1000)) };
}

describe("parseRecordDir", () => {
  it("reads both forms and is undefined when absent", () => {
    expect(parseRecordDir(["--full"])).toBeUndefined();
    expect(parseRecordDir(["--record", "/a"])).toBe("/a");
    expect(parseRecordDir(["--full", "--record=/b"])).toBe("/b");
  });

  it("refuses a missing value or a repeat", () => {
    expect(() => parseRecordDir(["--record"])).toThrow(/requires a directory/);
    expect(() => parseRecordDir(["--record", "--full"])).toThrow(/requires a directory/);
    expect(() => parseRecordDir(["--record="])).toThrow(/requires a directory/);
    expect(() => parseRecordDir(["--record", "/a", "--record=/b"])).toThrow(/more than once/);
  });

  it("is a known flag to the harness's closed allowlist", () => {
    expect(() => assertKnownFlags(["--record", "/tmp/x", "--full"])).not.toThrow();
    expect(() => assertKnownFlags(["--record=/tmp/x"])).not.toThrow();
    expect(() => assertKnownFlags(["--recrod", "/tmp/x"])).toThrow(/Unrecognized/);
  });
});

describe("FlowRecorder.prepare", () => {
  it("refuses a directory inside this repository, before writing anything", () => {
    const inside = join(repoRoot(), "tests", "eval", ".records-should-not-exist");
    expect(() => FlowRecorder.prepare(inside, INVOCATION)).toThrow(/inside this repository/);
    expect(existsSync(inside)).toBe(false);
  });

  it("refuses a directory inside an injected root, and accepts one outside it", () => {
    const root = gitRepo(join(base, "repo"));
    expect(() => FlowRecorder.prepare(join(root, "out"), INVOCATION, { root })).toThrow(/--record .* inside this repository/);
    expect(() => FlowRecorder.prepare(join(base, "out"), INVOCATION, { root, head: { sha: null, dirty: null } })).not.toThrow();
  });

  it("refuses a directory inside another worktree or the main checkout of the same repository", () => {
    const main = gitRepo(join(base, "main"));
    writeFileSync(join(main, "README"), "x\n");
    git(main, "add", "README");
    git(main, "-c", "user.name=Recorder Test", "-c", "user.email=recorder-test@example.invalid", "commit", "-q", "-m", "init");
    const wt = join(base, "wt");
    git(main, "worktree", "add", "-q", wt);
    // Run from the main checkout: a path in the second worktree is refused.
    expect(() => assertRecordDirOutsideRepo(join(wt, "records", "run-1"), "--record", main)).toThrow(
      /--record .* resolves inside this repository \(the checkout or worktree at .*wt\)/,
    );
    expect(() => FlowRecorder.prepare(join(wt, "out"), INVOCATION, { root: main, head: { sha: null, dirty: null } })).toThrow(
      /inside this repository/,
    );
    // Run from the second worktree: a path in the main checkout is refused.
    expect(() => assertRecordDirOutsideRepo(join(main, "out"), "--record", wt)).toThrow(/resolves inside this repository/);
    expect(() => assertRecordDirOutsideRepo(join(main, "out"), "--record", main)).toThrow(/resolves inside this repository/);
    // A sibling directory of both is outside.
    expect(() => assertRecordDirOutsideRepo(join(base, "elsewhere", "out"), "--record", main)).not.toThrow();
    expect(() => assertRecordDirOutsideRepo(join(base, "elsewhere", "out"), "--out", wt)).not.toThrow();
    expect(existsSync(join(base, "elsewhere"))).toBe(false);
  });

  it("refuses (fails closed) when git cannot list the repository's checkouts", () => {
    const notARepo = join(base, "plain");
    mkdirSync(notARepo);
    expect(() => assertRecordDirOutsideRepo(join(base, "elsewhere"), "--record", notARepo)).toThrow(
      /--record .* cannot confirm it is outside this repository, because `git rev-parse .*` failed/,
    );
  });

  it("refuses a directory that already holds a record", () => {
    const dir = join(base, "used");
    mkdirSync(dir);
    writeFileSync(join(dir, "flows.jsonl"), "");
    expect(() => FlowRecorder.prepare(dir, INVOCATION, { head: { sha: null, dirty: null } })).toThrow(
      /already holds flows\.jsonl/,
    );
  });
});

describe("recordingRunner", () => {
  it("returns the runner untouched without a recorder", () => {
    expect(recordingRunner(undefined, "api", fakeRun)).toBe(fakeRun);
  });

  it("writes invocation.json and one line per flow, labelled, sampled and timed", async () => {
    const root = gitRepo(mkdtempSync(join(tmpdir(), "matchline-root-")));
    try {
      const dir = join(base, "rec");
      const recorder = FlowRecorder.prepare(dir, INVOCATION, {
        root,
        clock: clock(),
        head: { sha: "abc123", dirty: false },
        invocationId: "inv-fixed",
      });
      // Nothing on disk until a flow is recorded.
      expect(existsSync(dir)).toBe(false);
      const run = recordingRunner(recorder, "api", fakeRun);
      const deps = { anthropicClient: {} as never, openaiClient: {} as never };
      await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
      await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
      recorder.setVariant("b");
      await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
      await run({ resumeFixtureId: "r2", jdFixtureId: "j1" }, deps);
      recorder.finish([
        {
          label: "b",
          tokenSource: "api",
          models: { extraction: { provider: "anthropic", model: "claude-haiku-4-5" } },
          promptVersions: { "extraction/resume": "v1" },
          efforts: {},
          extractionAccuracy: 0.5,
          matchAccuracy: 0.4,
          modeledCostUsd: 0.02,
          modeledCostPerFlowUsd: 0.01,
          flows: 2,
          failures: 0,
        },
      ]);

      const flows = parseFlowsJsonl(readFileSync(join(dir, "flows.jsonl"), "utf8"), "flows.jsonl");
      expect(flows.map((f) => [f.variant, f.cell, f.sampleIndex])).toEqual([
        ["default", "r1__j1", 0],
        ["default", "r1__j1", 1],
        ["b", "r1__j1", 0],
        ["b", "r2__j1", 0],
      ]);
      expect(flows.every((f) => f.invocationId === "inv-fixed")).toBe(true);
      expect(flows[0]!.startedAt < flows[0]!.finishedAt).toBe(true);
      expect(flows[0]!.units).toEqual([{ raw_text: "u" }]);
      expect(flows[0]!.stages.extraction).toMatchObject({ model: modelFor("extraction").model });

      const inv = JSON.parse(readFileSync(join(dir, "invocation.json"), "utf8"));
      expect(inv).toMatchObject({
        invocationId: "inv-fixed",
        headSha: "abc123",
        dirty: false,
        argv: ["--record", "/x"],
        tokenSource: "api",
        cacheMode: "bypass",
        samples: 2,
        flowCount: 4,
        startedAt: "2026-10-28T09:00:01.000Z",
      });
      expect(inv.finishedAt).toMatch(/^2026-10-28T09:00:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps invocation.json's flowCount current after each flow, with finishedAt null until finish", async () => {
    const root = gitRepo(mkdtempSync(join(tmpdir(), "matchline-root-")));
    try {
      const dir = join(base, "killed");
      const recorder = FlowRecorder.prepare(dir, INVOCATION, { root, clock: clock(), head: { sha: null, dirty: null } });
      const run = recordingRunner(recorder, "api", fakeRun);
      const deps = { anthropicClient: {} as never, openaiClient: {} as never };
      await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
      await run({ resumeFixtureId: "r2", jdFixtureId: "j1" }, deps);
      // No finish(): as if the run were killed here.
      const inv = JSON.parse(readFileSync(join(dir, "invocation.json"), "utf8"));
      expect(inv).toMatchObject({ flowCount: 2, finishedAt: null });
      expect(readFileSync(join(dir, "flows.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
      // The temp file is renamed over invocation.json, never left behind.
      expect(readdirSync(dir).sort()).toEqual(["flows.jsonl", "invocation.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finish is a no-op when nothing was recorded", () => {
    const root = gitRepo(mkdtempSync(join(tmpdir(), "matchline-root-")));
    try {
      const dir = join(base, "empty");
      const recorder = FlowRecorder.prepare(dir, INVOCATION, { root, head: { sha: null, dirty: null } });
      recorder.finish();
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recordingRunner per-variant token source and write failures", () => {
  let root: string;
  beforeEach(() => {
    root = gitRepo(mkdtempSync(join(tmpdir(), "matchline-root-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const deps = { anthropicClient: {} as never, openaiClient: {} as never };

  it("records the variant's own token source and the effort that source sends", async () => {
    setEffortOverrides({ extraction: "low" });
    const dir = join(base, "rec");
    const recorder = FlowRecorder.prepare(dir, INVOCATION, { root, clock: clock(), head: { sha: null, dirty: null } });
    const run = recordingRunner(recorder, "api", fakeRun);
    recorder.setVariant("cli-arm", "claude-cli");
    await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
    recorder.setVariant("api-arm");
    await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
    const flows = parseFlowsJsonl(readFileSync(join(dir, "flows.jsonl"), "utf8"), "flows.jsonl");
    expect(flows[0]).toMatchObject({ variant: "cli-arm", tokenSource: "claude-cli" });
    expect(flows[0]!.stages.extraction).toMatchObject({ effortRequested: "low", effortSent: null });
    expect(flows[1]).toMatchObject({ variant: "api-arm", tokenSource: "api" });
    expect(flows[1]!.stages.extraction).toMatchObject({ effortRequested: "low", effortSent: "low" });
  });

  it("prints a write failure, turns recording off and keeps returning results", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = join(base, "rec");
    const recorder = FlowRecorder.prepare(dir, INVOCATION, { root, clock: clock(), head: { sha: null, dirty: null } });
    const traced: boolean[] = [];
    const spy: FlowRunner = async (input, d) => {
      traced.push(d.trace !== undefined);
      return fakeRun(input, d);
    };
    const run = recordingRunner(recorder, "api", spy);
    await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
    // Break the record file: appending to a directory fails.
    rmSync(join(dir, "flows.jsonl"));
    mkdirSync(join(dir, "flows.jsonl"));
    const second = await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
    expect(second.ok).toBe(true);
    expect(recorder.disabled).toBe(true);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/recording is off for the rest of this run/));
    const third = await run({ resumeFixtureId: "r2", jdFixtureId: "j1" }, deps);
    expect(third.ok).toBe(true);
    expect(traced).toEqual([true, true, false]);
    expect(recorder.flowCount).toBe(1);
    recorder.finish();
    const inv = JSON.parse(readFileSync(join(dir, "invocation.json"), "utf8"));
    expect(inv.flowCount).toBe(1);
    expect(inv.finishedAt).not.toBeNull();
    expect(inv.recordingError).toMatch(/EISDIR|illegal operation|directory/i);
  });

  it("does not abort the run when the record directory cannot be created", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = join(base, "not-a-dir");
    writeFileSync(dir, "a file where the directory should be");
    const recorder = FlowRecorder.prepare(dir, INVOCATION, { root, clock: clock(), head: { sha: null, dirty: null } });
    const run = recordingRunner(recorder, "api", fakeRun);
    const out = await run({ resumeFixtureId: "r1", jdFixtureId: "j1" }, deps);
    expect(out.ok).toBe(true);
    expect(recorder.disabled).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
    // Nothing was opened, so finish leaves the path alone.
    recorder.finish();
    expect(readFileSync(dir, "utf8")).toBe("a file where the directory should be");
  });
});

describe("captureStageConfig / describeVariants", () => {
  it("records the requested effort, and sends none for a CLI token source", () => {
    setEffortOverrides({ extraction: "low" });
    const api = captureStageConfig("api");
    expect(api.extraction).toMatchObject({ effortRequested: "low", effortSent: "low", promptVersion: "v1" });
    expect(api.extraction!.promptFingerprint).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(captureStageConfig("claude-cli").extraction).toMatchObject({ effortRequested: "low", effortSent: null });
    const parsingDefault = profileFor(modelFor("requirement_parsing").model).defaultEffort ?? null;
    expect(api.requirement_parsing).toMatchObject({ effortRequested: null, effortSent: parsingDefault });
  });

  it("describes a plain run as one default arm and a sweep by its variants", () => {
    const plain = describeVariants([], "api", { "parsing/jd": "v1" });
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ label: "default", requested: { promptVersions: { "parsing/jd": "v1" } } });
    expect(plain[0]!.stages?.extraction).toBeDefined();
    const sweep = describeVariants(
      [{ label: "h", models: { extraction: { provider: "anthropic", model: "claude-haiku-4-5" } }, efforts: { extraction: "low" } }],
      "api",
      {},
    );
    expect(sweep[0]).toMatchObject({ label: "h", tokenSource: "api", requested: { efforts: { extraction: "low" } } });
  });
});

describe("runVariant --record hook", () => {
  it("hands the variant to runCorpus while its overrides are installed", async () => {
    const variant: SweepVariant = { label: "haiku", models: { extraction: { provider: "anthropic", model: "claude-haiku-5-5" } } };
    const runCorpus = vi.fn(async (v: SweepVariant) => {
      expect(v.label).toBe("haiku");
      expect(modelFor("extraction").model).toBe("claude-haiku-5-5");
      return [result("r1", "j1")];
    });
    await runVariant(variant, { runCorpus });
    expect(runCorpus).toHaveBeenCalledWith(variant);
  });
});
