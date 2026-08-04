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

import { afterEach, describe, expect, it, vi } from "vitest";

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
        { label: "prompt-only", promptVersions: { "extraction/resume": "v2" } },
      ]),
    ).not.toThrow();
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

  it("applies prompt overrides and clears them afterwards", async () => {
    let seen: Readonly<Record<string, string>> = {};
    await runVariant(
      { label: "v2-prompt", promptVersions: { "extraction/resume": "v2" } },
      {
        runCorpus: async () => {
          seen = getPromptVersionOverrides();
          return [fixtureResult()];
        },
      },
    );
    expect(seen).toEqual({ "extraction/resume": "v2" });
    expect(getPromptVersionOverrides()).toEqual({});
  });

  it("layers variant prompt overrides on top of command-wide ones", async () => {
    // Codex P2: setPromptVersionOverrides REPLACES, so a `--prompt`
    // flag passed alongside `--variant` was silently dropped for every
    // variant — the run used the default prompt while the report
    // header claimed the override.
    let seen: Readonly<Record<string, string>> = {};
    const result = await runVariant(
      { label: "v", promptVersions: { "extraction/resume": "v2" } },
      {
        runCorpus: async () => {
          seen = getPromptVersionOverrides();
          return [fixtureResult()];
        },
      },
      { basePromptVersions: { "parsing/jd": "v3" } },
    );
    expect(seen).toEqual({ "parsing/jd": "v3", "extraction/resume": "v2" });
    expect(result.promptVersions).toEqual({ "parsing/jd": "v3", "extraction/resume": "v2" });
  });

  it("lets a variant override win over the command-wide value", async () => {
    let seen: Readonly<Record<string, string>> = {};
    await runVariant(
      { label: "v", promptVersions: { "extraction/resume": "v2" } },
      {
        runCorpus: async () => {
          seen = getPromptVersionOverrides();
          return [fixtureResult()];
        },
      },
      { basePromptVersions: { "extraction/resume": "v9" } },
    );
    expect(seen["extraction/resume"]).toBe("v2");
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
          promptVersions: { "extraction/resume": "v9" },
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
    const v = parseVariantFlag("v2:prompt.extraction/resume=v2", "api");
    expect(v.promptVersions).toEqual({ "extraction/resume": "v2" });
  });

  it("parses several clauses in one variant", () => {
    const v = parseVariantFlag(
      "both:model.extraction=claude-haiku-4-5-20251001,prompt.extraction/resume=v2",
      "api",
    );
    expect(v.models?.extraction?.model).toBe("claude-haiku-4-5-20251001");
    expect(v.promptVersions).toEqual({ "extraction/resume": "v2" });
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
    expect(() => parseVariantFlag("a:prompt.extraction/resume=v2", "api")).not.toThrow();
    expect(() => parseVariantFlag("b:prompt.parsing/jd=v2", "api")).not.toThrow();
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
    expect(() => parseVariantFlag("a:prompt.extraction/resume=v2", "api")).not.toThrow();
    expect(() => parseVariantFlag("b:prompt.parsing/jd=v2-rc1", "api")).not.toThrow();
  });

  it("rejects an OpenAI model with the real reason", () => {
    // Codex P1: inferring provider "openai" produced an override no
    // pipeline can consume — extractFromResume throws on a
    // non-anthropic provider BEFORE the injected CLI client is
    // called. So the advertised codex-cli sweep had no viable model
    // configuration at all. Fail at parse time with the cause.
    expect(() => parseVariantFlag("g:model.extraction=gpt-5.6-sol", "codex-cli")).toThrow(
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
});
