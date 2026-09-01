/**
 * Model-sweep tests (#389).
 *
 * The corpus runner is injected, so these are pure and offline.
 *
 * Priority invariants:
 *   1. An unpriced model refuses to sweep — otherwise it reports $0.00
 *      and wins the cost comparison by default.
 *   2. Overrides never leak between variants, even when one throws.
 *   3. The Pareto frontier and the recommendation are honest: nothing
 *      clearing the bar returns null rather than the least-bad option.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearModelOverrides,
  getModelOverrides,
  modelFor,
} from "../../functions/src/llm/config.ts";
import {
  clearPromptVersionOverrides,
  getPromptVersionOverrides,
} from "../../functions/src/prompts/loader.ts";

import type { RunForFixtureResult } from "./runForFixture.ts";
import {
  assertModelsPriced,
  assertPromptSchemasCompatible,
  assertPromptsExist,
  formatSweepReport,
  paretoFrontier,
  parseVariantFlag,
  parseVariants,
  recommend,
  rollUpVariant,
  runSweep,
  runVariant,
  type SweepVariant,
  type VariantResult,
} from "./sweep.ts";

afterEach(() => {
  clearModelOverrides();
  clearPromptVersionOverrides();
  vi.restoreAllMocks();
});

function fixtureResult(
  overrides: Partial<RunForFixtureResult> = {},
): RunForFixtureResult {
  return {
    resumeFixtureId: "nathan-2026",
    jdFixtureId: "google-compute-spm-2026",
    extractionAccuracy: 0.5,
    matchAccuracy: 0.2,
    latencyMs: 1000,
    costUsd: 0,
    modeledCostUsd: 0.4,
    cacheHits: 4,
    cacheMisses: 0,
    extractedUnitCount: 20,
    parsedRequirementCount: 15,
    matchCount: 300,
    ok: true,
    error: null,
    ...overrides,
  };
}

function variantResult(overrides: Partial<VariantResult> = {}): VariantResult {
  return {
    label: "v",
    tokenSource: "api",
    models: {},
    promptVersions: {},
    extractionAccuracy: 0.5,
    matchAccuracy: 0.5,
    modeledCostUsd: 1,
    modeledCostPerFlowUsd: 0.25,
    flows: 4,
    failures: 0,
    ...overrides,
  };
}

describe("assertModelsPriced", () => {
  it("passes for models that have a rates.ts entry", () => {
    expect(() =>
      assertModelsPriced([
        {
          label: "haiku-extraction",
          models: {
            extraction: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          },
        },
      ]),
    ).not.toThrow();
  });

  it("refuses to start when a swept model has no rates entry", () => {
    // `priceFor` swallows unknown models to 0 by design (telemetry must
    // never break a pipeline), so an unpriced variant would report
    // $0.00 and win the Pareto comparison outright. Catch it up front.
    expect(() =>
      assertModelsPriced([
        {
          label: "mystery",
          models: {
            extraction: { provider: "anthropic", model: "claude-not-in-rates" },
          },
        },
      ]),
    ).toThrow(/no rates.ts entry for claude-not-in-rates/);
  });

  it("reports every missing model at once, sorted", () => {
    expect(() =>
      assertModelsPriced([
        { label: "a", models: { extraction: { provider: "anthropic", model: "zzz" } } },
        { label: "b", models: { generation: { provider: "anthropic", model: "aaa" } } },
      ]),
    ).toThrow(/aaa, zzz/);
  });

  it("allows variants that only override prompts", () => {
    expect(() =>
      assertModelsPriced([
        { label: "prompt-only", promptVersions: { "extraction/resume": "v1" } },
      ]),
    ).not.toThrow();
  });
});

describe("assertPromptSchemasCompatible", () => {
  // Codex P2: prompts version their Zod schema alongside the Markdown,
  // but extraction and JD parsing import the v1 schema statically. A v2
  // prompt with a different schema would RUN as v2 while being
  // constrained and validated against v1 — the table would credit a
  // version that never really shaped the output.
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "matchline-schema-test-"));
    mkdirSync(join(root, "extraction"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const wired = () =>
    writeFileSync(join(root, "extraction", "resume.v1.schema.ts"), "export const A = 1;\n");

  it("allows the wired version itself", () => {
    wired();
    expect(() =>
      assertPromptSchemasCompatible(
        [{ label: "a", promptVersions: { "extraction/resume": "v1" } }],
        {},
        root,
      ),
    ).not.toThrow();
  });

  it("allows a version that ships no schema of its own", () => {
    // It reuses the wired schema, so nothing diverges.
    wired();
    expect(() =>
      assertPromptSchemasCompatible(
        [{ label: "a", promptVersions: { "extraction/resume": "v2" } }],
        {},
        root,
      ),
    ).not.toThrow();
  });

  it("allows a byte-identical schema", () => {
    wired();
    writeFileSync(join(root, "extraction", "resume.v2.schema.ts"), "export const A = 1;\n");
    expect(() =>
      assertPromptSchemasCompatible(
        [{ label: "a", promptVersions: { "extraction/resume": "v2" } }],
        {},
        root,
      ),
    ).not.toThrow();
  });

  it("refuses a version whose schema differs from the wired one", () => {
    wired();
    writeFileSync(join(root, "extraction", "resume.v2.schema.ts"), "export const A = 2;\n");
    expect(() =>
      assertPromptSchemasCompatible(
        [{ label: "a", promptVersions: { "extraction/resume": "v2" } }],
        {},
        root,
      ),
    ).toThrow(/schema the pipeline does not enforce/);
  });

  it("checks command-wide --prompt overrides too", () => {
    wired();
    writeFileSync(join(root, "extraction", "resume.v2.schema.ts"), "export const A = 2;\n");
    expect(() =>
      assertPromptSchemasCompatible([], { "extraction/resume": "v2" }, root),
    ).toThrow(/schema the pipeline does not enforce/);
  });
});

describe("runVariant", () => {
  it("applies model overrides for the duration of the run", async () => {
    let seenDuringRun: string | undefined;
    const variant: SweepVariant = {
      label: "haiku-extraction",
      models: {
        extraction: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      },
    };

    await runVariant(variant, {
      runCorpus: async () => {
        seenDuringRun = modelFor("extraction").model;
        return [fixtureResult()];
      },
    });

    expect(seenDuringRun).toBe("claude-haiku-4-5-20251001");
    // Restored afterwards, so the next variant starts clean.
    expect(modelFor("extraction").model).toBe("claude-sonnet-4-6");
    expect(getModelOverrides()).toEqual({});
  });

  it("records the full effective config, not just the explicit overrides", async () => {
    // Codex P2: a variant that overrides one stage used to record ONLY
    // that stage, so a saved report carried no trace of the
    // requirement_parsing model or either prompt version that also
    // produced its numbers — and stopped being reproducible the moment
    // config.ts or PROMPT_CONFIG moved.
    const result = await runVariant(
      {
        label: "haiku-extraction",
        models: {
          extraction: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        },
      },
      { runCorpus: async () => [fixtureResult()] },
    );

    // The explicit override is recorded...
    expect(result.models.extraction?.model).toBe("claude-haiku-4-5-20251001");
    // ...and so is the default that silently participated.
    expect(result.models.requirement_parsing?.model).toBe(
      modelFor("requirement_parsing").model,
    );
    // Both sweepable prompt versions are pinned, not just overridden ones.
    expect(Object.keys(result.promptVersions).sort()).toEqual([
      "extraction/resume",
      "parsing/jd",
    ]);
    for (const v of Object.values(result.promptVersions)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it("applies prompt overrides and clears them afterwards", async () => {
    let seen: Readonly<Record<string, string>> = {};
    await runVariant(
      { label: "v2-prompt", promptVersions: { "extraction/resume": "v1" } },
      {
        runCorpus: async () => {
          seen = getPromptVersionOverrides();
          return [fixtureResult()];
        },
      },
    );
    expect(seen).toEqual({ "extraction/resume": "v1" });
    expect(getPromptVersionOverrides()).toEqual({});
  });

  it("layers variant prompt overrides on top of command-wide ones", async () => {
    // Codex P2: setPromptVersionOverrides REPLACES, so a `--prompt`
    // flag passed alongside `--variant` was silently dropped for every
    // variant — the run used the default prompt while the report
    // header claimed the override.
    //
    // Distinct versions on purpose: with the same value on both keys
    // this test cannot tell "layered" from "replaced". `runVariant`
    // does not touch the filesystem — the prompt-file existence check
    // is a `runSweep` pre-flight — so a not-yet-authored version is
    // fine here.
    let seen: Readonly<Record<string, string>> = {};
    const result = await runVariant(
      { label: "v", promptVersions: { "extraction/resume": "v2" } },
      {
        runCorpus: async () => {
          seen = getPromptVersionOverrides();
          return [fixtureResult()];
        },
      },
      { basePromptVersions: { "parsing/jd": "v1" } },
    );
    expect(seen).toEqual({ "parsing/jd": "v1", "extraction/resume": "v2" });
    expect(result.promptVersions).toEqual({ "parsing/jd": "v1", "extraction/resume": "v2" });
  });

  it("lets a variant override win over the command-wide value", async () => {
    let seen: Readonly<Record<string, string>> = {};
    await runVariant(
      { label: "v", promptVersions: { "extraction/resume": "v1" } },
      {
        runCorpus: async () => {
          seen = getPromptVersionOverrides();
          return [fixtureResult()];
        },
      },
      { basePromptVersions: { "extraction/resume": "v1" } },
    );
    expect(seen["extraction/resume"]).toBe("v1");
  });

  it("clears overrides even when the corpus run throws", async () => {
    // A leaked override would silently attribute this variant's config
    // to the NEXT variant's numbers — a ranking corruption that would
    // be nearly impossible to spot in the output table.
    await expect(
      runVariant(
        {
          label: "boom",
          models: { extraction: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } },
          promptVersions: { "extraction/resume": "v1" },
        },
        {
          runCorpus: async () => {
            throw new Error("corpus exploded");
          },
        },
      ),
    ).rejects.toThrow("corpus exploded");

    expect(getModelOverrides()).toEqual({});
    expect(getPromptVersionOverrides()).toEqual({});
    expect(modelFor("extraction").model).toBe("claude-sonnet-4-6");
  });

  it("replaces rather than merges overrides across variants", async () => {
    const deps = { runCorpus: async () => [fixtureResult()] };
    await runVariant(
      { label: "a", models: { generation: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      deps,
    );
    let seenGeneration: string | undefined;
    await runVariant(
      { label: "b", models: { extraction: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } } },
      {
        runCorpus: async () => {
          seenGeneration = modelFor("generation").model;
          return [fixtureResult()];
        },
      },
    );
    // Variant b never set `generation`, so it must be back to default.
    expect(seenGeneration).toBe("claude-haiku-4-5-20251001"); // config.ts default
  });
});

describe("rollUpVariant", () => {
  it("averages accuracy and sums modeled cost", () => {
    const rolled = rollUpVariant({ label: "v" }, [
      fixtureResult({ extractionAccuracy: 0.4, matchAccuracy: 0.2, modeledCostUsd: 0.4 }),
      fixtureResult({ extractionAccuracy: 0.6, matchAccuracy: 0.4, modeledCostUsd: 0.6 }),
    ]);
    expect(rolled.extractionAccuracy).toBeCloseTo(0.5, 10);
    expect(rolled.matchAccuracy).toBeCloseTo(0.3, 10);
    expect(rolled.modeledCostUsd).toBeCloseTo(1.0, 10);
    expect(rolled.modeledCostPerFlowUsd).toBeCloseTo(0.5, 10);
    expect(rolled.flows).toBe(2);
  });

  it("counts failed cells as 0 accuracy but keeps their partial cost", () => {
    // A variant that crashes half the corpus must not be flattered by
    // averaging over only its survivors.
    const rolled = rollUpVariant({ label: "v" }, [
      fixtureResult({ extractionAccuracy: 0.8, matchAccuracy: 0.8, modeledCostUsd: 0.5 }),
      fixtureResult({ ok: false, error: "boom", extractionAccuracy: 0, matchAccuracy: 0, modeledCostUsd: 0.2 }),
    ]);
    expect(rolled.extractionAccuracy).toBeCloseTo(0.4, 10);
    expect(rolled.failures).toBe(1);
    expect(rolled.modeledCostUsd).toBeCloseTo(0.7, 10);
  });

  it("returns null accuracy for an empty corpus rather than 0", () => {
    const rolled = rollUpVariant({ label: "v" }, []);
    expect(rolled.extractionAccuracy).toBeNull();
    expect(rolled.matchAccuracy).toBeNull();
    expect(rolled.modeledCostPerFlowUsd).toBeNull();
  });

  it("defaults the token source to api", () => {
    expect(rollUpVariant({ label: "v" }, [fixtureResult()]).tokenSource).toBe("api");
    expect(
      rollUpVariant({ label: "v", tokenSource: "claude-cli" }, [fixtureResult()]).tokenSource,
    ).toBe("claude-cli");
  });
});

describe("paretoFrontier", () => {
  it("keeps a variant that is cheaper at equal quality", () => {
    const frontier = paretoFrontier([
      variantResult({ label: "cheap", extractionAccuracy: 0.5, matchAccuracy: 0.5, modeledCostPerFlowUsd: 0.1 }),
      variantResult({ label: "pricey", extractionAccuracy: 0.5, matchAccuracy: 0.5, modeledCostPerFlowUsd: 0.9 }),
    ]);
    expect(frontier.has("cheap")).toBe(true);
    expect(frontier.has("pricey")).toBe(false);
  });

  it("keeps both when one is better and the other cheaper", () => {
    const frontier = paretoFrontier([
      variantResult({ label: "good", extractionAccuracy: 0.9, matchAccuracy: 0.9, modeledCostPerFlowUsd: 0.9 }),
      variantResult({ label: "cheap", extractionAccuracy: 0.4, matchAccuracy: 0.4, modeledCostPerFlowUsd: 0.1 }),
    ]);
    expect(frontier).toEqual(new Set(["good", "cheap"]));
  });

  it("does not trade extraction accuracy against match accuracy", () => {
    // An averaged score would wrongly discard "balanced": its lower
    // extraction score is offset by a higher match score, so neither
    // variant is better on both independent quality axes.
    const frontier = paretoFrontier([
      variantResult({
        label: "extract",
        extractionAccuracy: 0.9,
        matchAccuracy: 0.7,
        modeledCostPerFlowUsd: 0.1,
      }),
      variantResult({
        label: "balanced",
        extractionAccuracy: 0.8,
        matchAccuracy: 0.8,
        modeledCostPerFlowUsd: 0.1,
      }),
    ]);
    expect(frontier).toEqual(new Set(["extract", "balanced"]));
  });

  it("excludes variants with no successful flows", () => {
    // A run that produced nothing isn't cheap, it's broken — it must
    // not sit on the frontier at $0.
    const frontier = paretoFrontier([
      variantResult({ label: "ok", extractionAccuracy: 0.5, matchAccuracy: 0.5, modeledCostPerFlowUsd: 0.5 }),
      variantResult({ label: "broken", extractionAccuracy: null, matchAccuracy: null, modeledCostPerFlowUsd: 0, flows: 0 }),
    ]);
    expect(frontier.has("broken")).toBe(false);
    expect(frontier.has("ok")).toBe(true);
  });

  it("excludes an all-failure variant even though it has numeric zero accuracy", () => {
    // Codex P2: the null-accuracy filter did NOT cover this, despite
    // the comment claiming it did. `rollUpVariant` maps failed cells
    // to 0, not null, so a corpus where EVERY fixture failed had
    // flows > 0 and numeric zeros — and if it failed early, near-zero
    // cost put it on the frontier as an attractive tradeoff.
    const frontier = paretoFrontier([
      variantResult({
        label: "all-failed",
        extractionAccuracy: 0,
        matchAccuracy: 0,
        modeledCostPerFlowUsd: 0.001,
        flows: 4,
        failures: 4,
      }),
      variantResult({
        label: "works",
        extractionAccuracy: 0.5,
        matchAccuracy: 0.5,
        modeledCostPerFlowUsd: 0.5,
        flows: 4,
        failures: 0,
      }),
    ]);
    expect(frontier.has("all-failed")).toBe(false);
    expect(frontier.has("works")).toBe(true);
  });

  it("keeps a partially-failing variant, which is still a real datapoint", () => {
    const frontier = paretoFrontier([
      variantResult({ label: "partial", flows: 4, failures: 3, extractionAccuracy: 0.2, matchAccuracy: 0.2, modeledCostPerFlowUsd: 0.1 }),
    ]);
    expect(frontier.has("partial")).toBe(true);
  });
});

describe("recommend", () => {
  it("never recommends an all-failure variant", () => {
    // Codex P2: paretoFrontier excluded these but recommend() did not,
    // so the two disagreed on what counts as a usable result.
    expect(
      recommend([
        variantResult({
          label: "all-failed",
          extractionAccuracy: 0.9,
          matchAccuracy: 0.9,
          modeledCostPerFlowUsd: 0.1,
          flows: 4,
          failures: 4,
        }),
      ]),
    ).toBeNull();
  });

  it("never recommends a partially failing variant", () => {
    expect(
      recommend([
        variantResult({
          label: "flaky-but-high-scoring",
          extractionAccuracy: 0.95,
          matchAccuracy: 0.95,
          modeledCostPerFlowUsd: 0.1,
          flows: 4,
          failures: 1,
        }),
      ]),
    ).toBeNull();
  });

  it("returns null when nothing clears the 80/80 bar", () => {
    // The honest answer for #177's current baseline. Returning the
    // least-bad option here would read as "ship this".
    expect(
      recommend([
        variantResult({ label: "a", extractionAccuracy: 0.48, matchAccuracy: 0.19 }),
        variantResult({ label: "b", extractionAccuracy: 0.52, matchAccuracy: 0.24 }),
      ]),
    ).toBeNull();
  });

  it("picks the cheapest variant clearing both gates", () => {
    const pick = recommend([
      variantResult({ label: "expensive", extractionAccuracy: 0.9, matchAccuracy: 0.9, modeledCostPerFlowUsd: 0.8 }),
      variantResult({ label: "cheap", extractionAccuracy: 0.82, matchAccuracy: 0.81, modeledCostPerFlowUsd: 0.2 }),
    ]);
    expect(pick?.label).toBe("cheap");
  });

  it("rejects a variant that clears quality but blows the cost bar", () => {
    expect(
      recommend([
        variantResult({ label: "pricey", extractionAccuracy: 0.9, matchAccuracy: 0.9, modeledCostPerFlowUsd: 1.5 }),
      ]),
    ).toBeNull();
  });

  it("requires BOTH gates, not their average", () => {
    // extraction 0.95 + match 0.60 averages above 0.8 but fails #177.
    expect(
      recommend([
        variantResult({ label: "lopsided", extractionAccuracy: 0.95, matchAccuracy: 0.6 }),
      ]),
    ).toBeNull();
  });
});

describe("parseVariantFlag", () => {
  // Codex P2: the label reaches the Markdown results table, a
  // backticked recommendation line, and the duplicate-label check.
  // Restricting the grammar at parse time closes all three at once.
  it.each([
    ["a|b", "a pipe splits the table row into extra cells"],
    ["a\nb", "a newline breaks the table apart"],
    ["a`b", "a backtick escapes the recommendation code span"],
    ["a b", "a space is outside the documented grammar"],
  ])("rejects a label containing %j — %s", (label) => {
    expect(() =>
      parseVariantFlag(`${label}:model.extraction=claude-haiku-4-5-20251001`, "api"),
    ).toThrow(/label must be alphanumeric/);
  });

  it("accepts the label shapes the docs use", () => {
    for (const label of ["v2-prompt", "both", "haiku_extract", "haiku-4.5"]) {
      expect(() =>
        parseVariantFlag(`${label}:model.extraction=claude-haiku-4-5-20251001`, "api"),
      ).not.toThrow();
    }
  });

  it("parses a model override", () => {
    const v = parseVariantFlag(
      "haiku-extract:model.extraction=claude-haiku-4-5-20251001",
      "claude-cli",
    );
    expect(v.label).toBe("haiku-extract");
    expect(v.tokenSource).toBe("claude-cli");
    expect(v.models?.extraction).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("parses a prompt override", () => {
    const v = parseVariantFlag("v2:prompt.extraction/resume=v1", "api");
    expect(v.promptVersions).toEqual({ "extraction/resume": "v1" });
  });

  it("parses several clauses in one variant", () => {
    const v = parseVariantFlag(
      "both:model.extraction=claude-haiku-4-5-20251001,prompt.extraction/resume=v1",
      "api",
    );
    expect(v.models?.extraction?.model).toBe("claude-haiku-4-5-20251001");
    expect(v.promptVersions).toEqual({ "extraction/resume": "v1" });
  });

  it.each([
    ["no label separator", "model.extraction=x"],
    ["blank label", " :model.extraction=x"],
    ["no clause equals", "label:model.extraction"],
    ["empty value", "label:model.extraction="],
    ["unknown key prefix", "label:temperature=0.5"],
  ] as const)("rejects %s", (_why, spec) => {
    expect(() => parseVariantFlag(spec, "api")).toThrow();
  });

  // -- Codex round 1 regressions ------------------------------------

  it("rejects a misspelled stage instead of silently running the default", () => {
    // Codex P2: `model.extracton` parsed fine, was pricing-validated,
    // and appeared in the report — but `modelFor("extraction")` never
    // read it, so the corpus ran the DEFAULT model and the results
    // were attributed to the named variant. A mislabeling sweep is
    // worse than one that refuses to start.
    expect(() => parseVariantFlag("v:model.extracton=claude-sonnet-4-6", "api")).toThrow(
      /unknown stage "extracton"/,
    );
  });

  it("rejects a stage the eval corpus never exercises", () => {
    // Codex P2: `generation` / `validation` aren't wired into
    // runForFixture, so overriding them changes nothing while still
    // showing up in the table.
    expect(() => parseVariantFlag("v:model.generation=claude-sonnet-4-6", "api")).toThrow(
      /not exercised by the eval corpus/,
    );
    expect(() => parseVariantFlag("v:model.validation=claude-sonnet-4-6", "api")).toThrow(
      /not exercised by the eval corpus/,
    );
  });

  it("accepts the two stages the corpus does exercise", () => {
    expect(() =>
      parseVariantFlag("a:model.extraction=claude-haiku-4-5-20251001", "api"),
    ).not.toThrow();
    expect(() =>
      parseVariantFlag("b:model.requirement_parsing=claude-sonnet-4-6", "api"),
    ).not.toThrow();
  });

  it("rejects a prompt key the corpus never resolves", () => {
    // Codex P2 round 2: same silent-mislabel hazard as the stage
    // check — the corpus would run the DEFAULT prompt while the
    // table credited the variant.
    expect(() => parseVariantFlag("v:prompt.extracton/resume=v2", "api")).toThrow(
      /not exercised by the eval corpus/,
    );
    expect(() =>
      parseVariantFlag("v:prompt.validation/traceability=v2", "api"),
    ).toThrow(/not exercised by the eval corpus/);
  });

  it("accepts the two prompt keys the corpus does resolve", () => {
    expect(() => parseVariantFlag("a:prompt.extraction/resume=v1", "api")).not.toThrow();
    expect(() => parseVariantFlag("b:prompt.parsing/jd=v1", "api")).not.toThrow();
  });

  it("rejects a prompt version containing path separators", () => {
    // Codex P2: the version is interpolated into a filesystem path, so
    // this resolves to the REAL parsing/jd.v1 prompt — the sweep would
    // run the JD prompt while crediting an extraction variant.
    expect(() =>
      parseVariantFlag("v:prompt.extraction/resume=x/../../parsing/jd.v1", "api"),
    ).toThrow(/path traversal/);
    expect(() => parseVariantFlag("v:prompt.extraction/resume=../v1", "api")).toThrow(
      /path traversal/,
    );
  });

  it("still accepts ordinary version strings", () => {
    expect(() => parseVariantFlag("a:prompt.extraction/resume=v1", "api")).not.toThrow();
    expect(() => parseVariantFlag("b:prompt.parsing/jd=v1-rc1", "api")).not.toThrow();
  });

  it("rejects an OpenAI model with the real reason", () => {
    // The pipeline rejects OpenAI models before calling a token-source
    // adapter, so fail at parse time rather than mislabeling a sweep.
    expect(() => parseVariantFlag("g:model.extraction=gpt-5.6-sol", "claude-cli")).toThrow(
      /hard-require provider "anthropic"/,
    );
  });
});

describe("parseVariants", () => {
  it("collects repeated flags in both forms", () => {
    const vs = parseVariants(
      [
        "--variant", "a:model.extraction=claude-sonnet-4-6",
        "--variant=b:model.extraction=claude-haiku-4-5-20251001",
      ],
      "api",
    );
    expect(vs.map((v) => v.label)).toEqual(["a", "b"]);
  });

  it("returns empty when no variants are given, leaving normal mode intact", () => {
    expect(parseVariants(["--full", "--samples", "3"], "api")).toEqual([]);
  });

  it("rejects a duplicate label", () => {
    // The Pareto set is keyed on label, so a duplicate would silently
    // drop a row from the frontier.
    expect(() =>
      parseVariants(
        ["--variant=a:model.extraction=claude-sonnet-4-6", "--variant=a:model.extraction=claude-haiku-4-5-20251001"],
        "api",
      ),
    ).toThrow(/used more than once/);
  });

  it("rejects a missing value instead of swallowing the next flag", () => {
    expect(() => parseVariants(["--variant", "--full"], "api")).toThrow(
      /requires a value/,
    );
  });
});

describe("assertPromptsExist", () => {
  // Codex P2: a nonexistent version used to fail only once its variant
  // ran — after earlier variants had already spent a full corpus.
  it("passes for versions that exist on disk", () => {
    expect(() =>
      assertPromptsExist([{ label: "a", promptVersions: { "extraction/resume": "v1" } }]),
    ).not.toThrow();
  });

  it("refuses to start when a version file is missing", () => {
    expect(() =>
      assertPromptsExist([{ label: "b", promptVersions: { "extraction/resume": "v22" } }]),
    ).toThrow(/not found/);
  });

  it("checks command-wide overrides too", () => {
    expect(() =>
      assertPromptsExist([], { "parsing/jd": "v99" }),
    ).toThrow(/not found/);
  });

  it("reports every missing file at once", () => {
    try {
      assertPromptsExist([
        { label: "a", promptVersions: { "extraction/resume": "v22" } },
        { label: "b", promptVersions: { "parsing/jd": "v33" } },
      ]);
      throw new Error("expected throw");
    } catch (err) {
      const m = (err as Error).message;
      expect(m).toContain("v22");
      expect(m).toContain("v33");
    }
  });
});

describe("runSweep", () => {
  it("validates pricing before running anything", async () => {
    let ran = false;
    await expect(
      runSweep(
        [{ label: "bad", models: { extraction: { provider: "anthropic", model: "no-rates" } } }],
        {
          runCorpus: async () => {
            ran = true;
            return [fixtureResult()];
          },
        },
      ),
    ).rejects.toThrow(/no rates.ts entry/);
    // The guard must fire BEFORE any tokens are spent.
    expect(ran).toBe(false);
  });

  it("runs variants sequentially and returns both results and report", async () => {
    // Sequential matters: variants mutate shared module state, so
    // concurrency would interleave configs across variants.
    const order: string[] = [];
    const { results, report } = await runSweep(
      [
        { label: "a", models: { extraction: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
        { label: "b", models: { extraction: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } } },
      ],
      {
        runCorpus: async () => {
          order.push(modelFor("extraction").model);
          return [fixtureResult()];
        },
      },
    );
    expect(order).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
    expect(results.map((r) => r.label)).toEqual(["a", "b"]);
    expect(report).toContain("# Model sweep");
  });
});

describe("formatSweepReport", () => {
  it("sorts by cost, marks the frontier, and states the no-winner case", () => {
    const out = formatSweepReport([
      variantResult({ label: "sonnet", extractionAccuracy: 0.52, matchAccuracy: 0.24, modeledCostPerFlowUsd: 0.51 }),
      variantResult({ label: "haiku", extractionAccuracy: 0.45, matchAccuracy: 0.2, modeledCostPerFlowUsd: 0.17 }),
    ]);
    expect(out.indexOf("haiku")).toBeLessThan(out.indexOf("sonnet"));
    expect(out).toContain("No variant clears");
    expect(out).toContain("✅");
  });

  it("names the recommendation when one clears", () => {
    const out = formatSweepReport([
      variantResult({ label: "winner", extractionAccuracy: 0.85, matchAccuracy: 0.82, modeledCostPerFlowUsd: 0.3 }),
    ]);
    expect(out).toContain("Recommendation: `winner`");
  });

  it("carries both caveats so a reader can't take the table at face value", () => {
    const out = formatSweepReport([variantResult()]);
    // Latency is not measurable through a CLI run...
    expect(out).toMatch(/Latency is NOT ranked/);
    // ...and the ranking needs an API confirmation before config.ts moves.
    expect(out).toMatch(/Confirm the top finalists on the metered API/);
    // Cost provenance must be stated, since the CLI reports a different number.
    expect(out).toMatch(/modeled/i);
  });

  it("flags variants with failed flows", () => {
    const out = formatSweepReport([variantResult({ label: "flaky", failures: 2, flows: 4 })]);
    expect(out).toContain("2/4 failed");
  });

  it("renders the flow count for successful variants too", () => {
    // Codex P2: `flows` used to appear only in the failure suffix, so a
    // one-fixture smoke run and a full-corpus run serialized
    // identically. The report is meant to be pasted as experiment
    // evidence, and a recommendation's sample size is part of that
    // evidence.
    const smoke = formatSweepReport([variantResult({ label: "smoke", failures: 0, flows: 1 })]);
    const full = formatSweepReport([variantResult({ label: "full", failures: 0, flows: 100 })]);

    const row = (out: string, label: string): string =>
      out.split("\n").find((l) => l.startsWith(`| ${label} |`)) ?? "";

    expect(row(smoke, "smoke")).toContain("| 1 |");
    expect(row(full, "full")).toContain("| 100 |");
    // The whole point: the two rows must be distinguishable.
    expect(row(smoke, "smoke")).not.toBe(row(full, "full"));
  });
});
