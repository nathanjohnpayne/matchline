import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearEffortOverrides,
  clearModelOverrides,
  effortFor,
  isStage,
  modelFor,
  setEffortOverrides,
  setModelOverrides,
  STAGES,
  VALIDATION_STAGES,
} from "./config.js";

/**
 * Per-stage model configuration (#489): the three validation subtasks
 * are distinct, separately overridable stages, and production defaults
 * are unchanged.
 */

const SONNET_46 = "claude-sonnet-4-6";
const HAIKU_45 = "claude-haiku-4-5-20251001";

afterEach(() => {
  clearModelOverrides();
  clearEffortOverrides();
});

describe("STAGES", () => {
  it("lists the three validation subtasks and no longer the single validation stage", () => {
    expect(STAGES).toContain("claim_extraction");
    expect(STAGES).toContain("traceability");
    expect(STAGES).toContain("specificity");
    expect(STAGES as readonly string[]).not.toContain("validation");
    for (const stage of VALIDATION_STAGES) expect(STAGES).toContain(stage);
  });

  it("rejects the old stage name and misspellings", () => {
    expect(isStage("validation")).toBe(false);
    expect(isStage("claim-extraction")).toBe(false);
    expect(isStage("traceabilty")).toBe(false);
    expect(isStage("traceability")).toBe(true);
  });
});

describe("defaults", () => {
  it("keeps the audited production defaults", () => {
    for (const stage of [...VALIDATION_STAGES, "extraction", "rationale"] as const) {
      expect(modelFor(stage), stage).toEqual({ provider: "anthropic", model: SONNET_46 });
    }
    expect(modelFor("generation")).toEqual({ provider: "anthropic", model: HAIKU_45 });
    expect(modelFor("requirement_parsing")).toEqual({ provider: "anthropic", model: HAIKU_45 });
    for (const stage of STAGES) expect(modelFor(stage).provider, stage).toBe("anthropic");
  });
});

describe("overrides", () => {
  it("a model override on one validation subtask leaves the other two on their defaults", () => {
    setModelOverrides({ specificity: { provider: "anthropic", model: HAIKU_45 } });
    expect(modelFor("specificity").model).toBe(HAIKU_45);
    expect(modelFor("claim_extraction").model).toBe(SONNET_46);
    expect(modelFor("traceability").model).toBe(SONNET_46);
  });

  it("an effort override on one validation subtask leaves the others unset", () => {
    setEffortOverrides({ traceability: "medium" });
    expect(effortFor("traceability")).toBe("medium");
    expect(effortFor("claim_extraction")).toBeUndefined();
    expect(effortFor("specificity")).toBeUndefined();
  });

  it("clearing restores every stage to its default and every effort to unset", () => {
    const before = Object.fromEntries(STAGES.map((s) => [s, modelFor(s)]));
    setModelOverrides({
      claim_extraction: { provider: "anthropic", model: HAIKU_45 },
      traceability: { provider: "anthropic", model: "claude-sonnet-5-5" },
    });
    setEffortOverrides({ traceability: "low", specificity: "high" });
    clearModelOverrides();
    clearEffortOverrides();
    for (const stage of STAGES) {
      expect(modelFor(stage), stage).toEqual(before[stage]);
      expect(effortFor(stage), stage).toBeUndefined();
    }
  });
});

describe("rationale entry", () => {
  it("is never read by production code", () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
        const text = readFileSync(path, "utf8");
        if (
          /modelFor\(\s*["']rationale["']\s*\)/.test(text) ||
          /effortFor\(\s*["']rationale["']/.test(text)
        ) {
          offenders.push(path);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
