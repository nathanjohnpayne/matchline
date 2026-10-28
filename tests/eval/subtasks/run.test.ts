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
});

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
    expect(text).toMatch(/worst case \$\d/);
    expect(factory).not.toHaveBeenCalled();
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

