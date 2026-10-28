import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VALIDATION_STAGES } from "../../functions/src/llm/config.ts";

import { SWEEPABLE_PROMPT_KEYS, SWEEPABLE_STAGES } from "./sweep.ts";
import { assertGenerationVariantSupported, SWEEP_SCOPES, SWEEP_SUITES } from "./sweepScope.ts";

const PROMPTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "functions", "src", "prompts");

describe("SWEEP_SCOPES", () => {
  it("keeps the corpus scope exactly as the sweep had it", () => {
    expect(SWEEP_SCOPES.corpus.stages).toEqual(["extraction", "requirement_parsing"]);
    expect(SWEEP_SCOPES.corpus.stages).toEqual(SWEEPABLE_STAGES);
    expect(SWEEP_SCOPES.corpus.promptKeys).toEqual(SWEEPABLE_PROMPT_KEYS);
    expect(SWEEP_SCOPES.corpus.wiredSchemaVersion).toEqual({ "extraction/resume": "v1", "parsing/jd": "v1" });
  });

  it("scopes the validation suite to the three subtasks", () => {
    expect(SWEEP_SCOPES.validation.stages).toEqual([...VALIDATION_STAGES]);
    expect(SWEEP_SCOPES.generation.stages).toEqual(["generation"]);
  });

  it("never lists the reserved rationale stage", () => {
    for (const suite of SWEEP_SUITES) expect(SWEEP_SCOPES[suite].stages).not.toContain("rationale");
  });

  it("names only prompt keys whose v1 prompt exists", () => {
    for (const suite of SWEEP_SUITES) {
      for (const key of SWEEP_SCOPES[suite].promptKeys) {
        const [stage, name] = key.split("/") as [string, string];
        expect(existsSync(join(PROMPTS_ROOT, stage, `${name}.v1.md`)), key).toBe(true);
      }
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SWEEP_SCOPES.validation.stages)).toBe(true);
    expect(Object.isFrozen(SWEEP_SCOPES.generation)).toBe(true);
  });
});

describe("assertGenerationVariantSupported", () => {
  const model = (m: string) => ({ label: "v", models: { generation: { provider: "anthropic" as const, model: m } } });

  it("refuses any effort on generation", () => {
    expect(() => assertGenerationVariantSupported({ label: "v", efforts: { generation: "low" } })).toThrow(
      /does not apply model profiles/,
    );
  });

  it("refuses models that need a profile the pipeline does not apply", () => {
    for (const m of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]) {
      expect(() => assertGenerationVariantSupported(model(m)), m).toThrow(/does not apply model profiles/);
    }
  });

  it("accepts the legacy forced-tool models and no override at all", () => {
    expect(() => assertGenerationVariantSupported(model("claude-haiku-4-5-20251001"))).not.toThrow();
    expect(() => assertGenerationVariantSupported(model("claude-sonnet-4-6"))).not.toThrow();
    expect(() => assertGenerationVariantSupported({ label: "v" })).not.toThrow();
  });
});
