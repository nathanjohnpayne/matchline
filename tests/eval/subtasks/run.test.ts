import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../functions/src/firestore/admin.ts", () => ({
  getAdminDb: () => {
    throw new Error("the subtask suites must not touch Firestore");
  },
  initializeAdminAppForTests: () => {},
}));

import { clearEffortOverrides, clearModelOverrides, getEffortOverrides, getModelOverrides, modelFor } from "../../../functions/src/llm/config.ts";
import { clearPromptVersionOverrides, getPromptVersionOverrides } from "../../../functions/src/prompts/loader.ts";

import { main, type SubtaskDeps } from "./run.ts";
import { defaultValidationAnswer, scriptedClient } from "./testSupport.ts";

afterEach(() => {
  clearModelOverrides();
  clearEffortOverrides();
  clearPromptVersionOverrides();
  vi.useRealTimers();
});

/**
 * Run `p` with the modules' transport backoff on fake timers: failing
 * calls retry after real-time sleeps, which would make a test that
 * exercises them slow. Only timers are faked; `Date` is real.
 */
async function withFastBackoff<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let done = false;
  const p = start().finally(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(60_000);
  return p;
}

function deps(env: Record<string, string> = {}, extra: Partial<SubtaskDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const factory = vi.fn(() => scriptedClient(defaultValidationAnswer).client);
  const d: SubtaskDeps = {
    env,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    clientFactory: factory,
    git: () => ({ sha: "0000000", dirty: false }),
    ...extra,
  };
  return { d, out, err, factory };
}

describe("eval:subtasks CLI", () => {
  it("exits 2 on an unknown flag", async () => {
    const { d, err } = deps();
    expect(await main(["--suite", "validation", "--dryrun"], d)).toBe(2);
    expect(err.join("\n")).toMatch(/unknown flag "--dryrun"/);
  });

  it("exits 2 without a valid --suite", async () => {
    expect(await main(["--dry-run"], deps().d)).toBe(2);
    expect(await main(["--suite", "corpus", "--dry-run"], deps().d)).toBe(2);
  });

  it("reserves the baseline label", async () => {
    const { d, err } = deps();
    expect(await main(["--suite", "validation", "--dry-run", "--variant", "baseline:model.specificity=claude-haiku-4-5-20251001"], d)).toBe(2);
    expect(err.join("\n")).toMatch(/reserved/);
  });

  it("rejects the old single validation stage as unknown", async () => {
    const { d, err } = deps();
    expect(await main(["--suite", "validation", "--dry-run", "--variant", "x:model.validation=claude-sonnet-4-6"], d)).toBe(2);
    expect(err.join("\n")).toMatch(/unknown stage/);
  });

  it("exits 2 on an unknown --case id", async () => {
    const { d, err } = deps();
    expect(await main(["--suite", "validation", "--dry-run", "--case", "vc-99-nope"], d)).toBe(2);
    expect(err.join("\n")).toMatch(/unknown --case/);
  });

  it("dry-runs with an empty environment, prints the plan and never builds a client", async () => {
    const { d, out, factory } = deps();
    expect(await main(["--suite", "validation", "--dry-run", "--variant", "spec-haiku:model.specificity=claude-haiku-4-5-20251001"], d)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("DRY RUN (no requests sent)");
    expect(text).toContain("DRAFT LABELS");
    expect(text).toContain("fixtures");
    expect(text).toContain("variant spec-haiku");
    expect(text).toContain("planned requests");
    expect(text).toMatch(/expected \$\d/);
    expect(text).toMatch(/conservative estimate \$\d/);
    expect(text).toContain("not a bound");
    expect(factory).not.toHaveBeenCalled();
  });

  it("records the generation suite's judge at defaults, untouched by a variant's generation override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subtasks-"));
    try {
      const path = join(dir, "report.json");
      const { d } = deps({}, { writeFile: (p, data) => writeFileSync(p, data) });
      const argv = ["--suite", "generation", "--dry-run", "--report-json", path, "--variant", "gen-sonnet:model.generation=claude-sonnet-4-6"];
      expect(await main(argv, d)).toBe(0);
      const rec = JSON.parse(readFileSync(path, "utf8"));
      expect(Object.keys(rec.judge.stages)).toEqual(["claim_extraction", "traceability", "specificity"]);
      for (const s of Object.values(rec.judge.stages) as { model: string }[]) expect(s.model).toBe(modelFor("traceability").model);
      expect(Object.keys(rec.judge.promptVersions)).toEqual(["validation/claimExtraction", "validation/traceability", "validation/specificity"]);
      expect(rec.judge.promptVersions["validation/traceability"].fingerprint).toMatch(/^v\d+:[0-9a-f]{16}$/);
      // Validation runs have no separate judge: the validator is under test in variants[].resolved.
      const vpath = join(dir, "v.json");
      expect(await main(["--suite", "validation", "--dry-run", "--report-json", vpath], d)).toBe(0);
      expect(JSON.parse(readFileSync(vpath, "utf8")).judge).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 with no key and no --dry-run or --replay", async () => {
    const { d, err, factory } = deps();
    expect(await main(["--suite", "validation"], d)).toBe(2);
    expect(err.join("\n")).toMatch(/set ANTHROPIC_API_KEY or use --dry-run/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("exits 2 on a live api run without --max-usd", async () => {
    const { d, err, factory } = deps({ ANTHROPIC_API_KEY: "sk-test" });
    expect(await main(["--suite", "validation"], d)).toBe(2);
    expect(err.join("\n")).toMatch(/needs --max-usd/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("exits 1 before any request when the worst case exceeds --max-usd", async () => {
    const { d, err, factory } = deps({ ANTHROPIC_API_KEY: "sk-test" });
    expect(await main(["--suite", "validation", "--max-usd", "0.01"], d)).toBe(1);
    expect(err.join("\n")).toMatch(/exceeds --max-usd/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not hold an offline replay (no key) to the monthly caps: it cannot spend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subtasks-"));
    try {
      const path = join(dir, "report.json");
      const { d, err, factory } = deps({}, { replayDir: join(dir, "replay"), writeFile: (p, data) => writeFileSync(p, data) });
      // The generation suite's conservative estimate is over the $25 cap, so a metered projection would refuse.
      const code = await withFastBackoff(() => main(["--suite", "generation", "--replay", "--report-json", path], d));
      expect(err.join("\n")).not.toMatch(/monthly cap/);
      expect(factory).not.toHaveBeenCalled();
      const rec = JSON.parse(readFileSync(path, "utf8"));
      expect(rec.guards.offlineReplay).toBe(true);
      expect(rec.guards.capChecks.find((c: { provider: string }) => c.provider === "anthropic").projectedUsd).toBe(0);
      expect(rec.plan.worstCaseUsd).toBeGreaterThan(25);
      // Every replay missed, so nothing was measured: the run is incomplete, not a success.
      expect(rec.variants[0].validity).toBe("incomplete: all_failed");
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cap check for a replay that has a key (a miss can go live)", async () => {
    const { d, err, factory } = deps({ ANTHROPIC_API_KEY: "sk-test" });
    expect(await main(["--suite", "generation", "--replay", "--max-usd", "100"], d)).toBe(1);
    expect(err.join("\n")).toMatch(/monthly cap/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("exits 1 when every call fails and nothing was measured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subtasks-"));
    try {
      const path = join(dir, "report.json");
      const failing = scriptedClient(() => new Error("401 invalid x-api-key"));
      const { d } = deps({ ANTHROPIC_API_KEY: "sk-revoked" }, {
        clientFactory: () => failing.client,
        replayDir: join(dir, "replay"),
        writeFile: (p, data) => writeFileSync(p, data),
      });
      const code = await withFastBackoff(() =>
        main(["--suite", "validation", "--case", "vc-02-equivalent-numeric-notation", "--max-usd", "100", "--report-json", path], d),
      );
      expect(code).toBe(1);
      const rec = JSON.parse(readFileSync(path, "utf8"));
      expect(rec.variants[0].validity).toBe("incomplete: all_failed");
      expect(failing.create).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a mocked live run: baseline first, overrides cleared after, report written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subtasks-"));
    try {
      const path = join(dir, "report.json");
      const writes: string[] = [];
      const { d, out } = deps({ ANTHROPIC_API_KEY: "sk-test" }, {
        replayDir: join(dir, "replay"),
        writeFile: (p, data) => {
          writes.push(p);
          writeFileSync(p, data);
        },
      });
      const code = await main(
        ["--suite", "validation", "--case", "vc-02-equivalent-numeric-notation", "--max-usd", "100", "--report-json", path,
          "--variant", "spec-haiku:model.specificity=claude-haiku-4-5-20251001"],
        d,
      );
      expect(code).toBe(0);
      const rec = JSON.parse(readFileSync(path, "utf8"));
      expect(rec.variants.map((v: { label: string }) => v.label)).toEqual(["baseline", "spec-haiku"]);
      expect(rec.calls[0].variant).toBe("baseline");
      expect(rec.calls.length).toBeGreaterThan(0);
      expect(out.join("\n")).toContain("results — variant baseline");
      expect(getModelOverrides()).toEqual({});
      expect(getEffortOverrides()).toEqual({});
      expect(getPromptVersionOverrides()).toEqual({});
      expect(modelFor("specificity").model).toBe("claude-sonnet-4-6");
      expect(writes).toEqual([path]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

