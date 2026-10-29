import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VALIDATION_STAGES } from "../../functions/src/llm/config.ts";

import { JD_PARSING_SCHEMA_VERSIONS } from "../../functions/src/parsing/jdResponseSchema.ts";
import { PROMPT_CONFIG } from "../../functions/src/prompts/config.ts";

import { loadClassifier } from "./subtasks/instrument.ts";
import { SWEEPABLE_PROMPT_KEYS, SWEEPABLE_STAGES } from "./sweep.ts";
import { assertGenerationVariantSupported, defaultPromptVersion, SWEEP_SCOPES, SWEEP_SUITES } from "./sweepScope.ts";

const PROMPTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "functions", "src", "prompts");

describe("SWEEP_SCOPES", () => {
  it("keeps the corpus scope exactly as the sweep had it", () => {
    expect(SWEEP_SCOPES.corpus.stages).toEqual(["extraction", "requirement_parsing"]);
    expect(SWEEP_SCOPES.corpus.stages).toEqual(SWEEPABLE_STAGES);
    expect(SWEEP_SCOPES.corpus.promptKeys).toEqual(SWEEPABLE_PROMPT_KEYS);
    expect(SWEEP_SCOPES.corpus.wiredSchemaVersion).toEqual({ "extraction/resume": "v1", "parsing/jd": "v1" });
  });

  it("lets JD parsing pick its schema by version, and no other key (#656)", () => {
    expect(SWEEP_SCOPES.corpus.dispatchedSchemaVersions).toEqual({ "parsing/jd": ["v1", "v2"] });
    expect(SWEEP_SCOPES.corpus.dispatchedSchemaVersions?.["parsing/jd"]).toEqual([...JD_PARSING_SCHEMA_VERSIONS]);
    expect(Object.isFrozen(SWEEP_SCOPES.corpus.dispatchedSchemaVersions)).toBe(true);
    expect(Object.isFrozen(SWEEP_SCOPES.corpus.dispatchedSchemaVersions?.["parsing/jd"])).toBe(true);
    expect(SWEEP_SCOPES.validation.dispatchedSchemaVersions).toBeUndefined();
    expect(SWEEP_SCOPES.generation.dispatchedSchemaVersions).toBeUndefined();
  });

  it("has a prompt file and a schema file for every dispatched JD parsing version", () => {
    for (const version of SWEEP_SCOPES.corpus.dispatchedSchemaVersions!["parsing/jd"]!) {
      expect(existsSync(join(PROMPTS_ROOT, "parsing", `jd.${version}.md`)), version).toBe(true);
      expect(existsSync(join(PROMPTS_ROOT, "parsing", `jd.${version}.schema.ts`)), version).toBe(true);
    }
  });

  it("scopes the validation suite to the three subtasks", () => {
    expect(SWEEP_SCOPES.validation.stages).toEqual([...VALIDATION_STAGES]);
    expect(SWEEP_SCOPES.generation.stages).toEqual(["generation"]);
  });

  it("wires the validation and generation schemas at the PROMPT_CONFIG default, each with an outcome classifier", async () => {
    // When a default moves (e.g. traceability or generation/resume to v2), the classifier is
    // loaded from that version's schema file; this fails only if the file is missing or does
    // not export exactly one *ResponseV<N>Schema, instead of every answer going `unclassified`
    // and the schema and invented-id metrics silently reading zero.
    const config = PROMPT_CONFIG as unknown as Record<string, Record<string, string>>;
    for (const suite of ["validation", "generation"] as const) {
      for (const key of SWEEP_SCOPES[suite].promptKeys) {
        const [stage, name] = key.split("/") as [string, string];
        expect(SWEEP_SCOPES[suite].wiredSchemaVersion[key], key).toBe(config[stage]![name]);
        expect(defaultPromptVersion(key), key).toBe(config[stage]![name]);
        expect(await loadClassifier(`${key}@${config[stage]![name]}`), `${key}@${config[stage]![name]}`).not.toBeNull();
      }
    }
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
