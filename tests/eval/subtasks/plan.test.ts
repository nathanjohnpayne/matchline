import { afterEach, describe, expect, it } from "vitest";

import { clearEffortOverrides, clearModelOverrides } from "../../../functions/src/llm/config.ts";
import { clearPromptVersionOverrides } from "../../../functions/src/prompts/loader.ts";

import { SWEEP_SCOPES } from "../sweepScope.ts";

import { loadGenerationSnapshots, loadValidationCases } from "./fixtures.ts";
import { snapshotDefaults, withVariantOverrides } from "./overrides.ts";
import { largestUnits, MAX_ATTEMPTS, planGeneration, planValidation, project, TOKENIZER_55_FACTOR, traceabilityInput } from "./plan.ts";

afterEach(() => {
  clearModelOverrides();
  clearEffortOverrides();
  clearPromptVersionOverrides();
});

const cases = loadValidationCases({ ids: ["vc-02-equivalent-numeric-notation", "vc-14-adversarial-fabrication"] }).items;

async function planFor(models: Record<string, string> = {}, samples = 1) {
  const variant = {
    label: Object.keys(models).length === 0 ? "baseline" : "v",
    models: Object.fromEntries(Object.entries(models).map(([s, m]) => [s, { provider: "anthropic" as const, model: m }])),
  };
  return (await withVariantOverrides(variant, SWEEP_SCOPES.validation, {}, async (r) => planValidation(cases, r, samples))).value;
}

const count = (rows: Awaited<ReturnType<typeof planFor>>, pass: string, stage: string) =>
  rows.filter((r) => r.pass === pass && r.stage === stage).reduce((s, r) => s + r.count, 0);

describe("planValidation", () => {
  it("counts requests per the plan table", async () => {
    const rows = await planFor();
    // vc-02: 3 assertions, all with specificity labels; vc-14: 4 assertions, no specificity labels.
    expect(count(rows, "isolated", "claim_extraction")).toBe(2);
    expect(count(rows, "isolated", "traceability")).toBe(3 + 4);
    expect(count(rows, "isolated", "specificity")).toBe(3);
    expect(count(rows, "whole_asset", "claim_extraction")).toBe(2);
    expect(count(rows, "whole_asset", "traceability")).toBe(Math.max(6, 8) + Math.max(8, 8));
  });

  it("plans no traceability call for a case with no cited candidates", async () => {
    const noCited = cases.map((c) => ({ ...c, case: { ...c.case, item: { ...c.case.item, source_unit_ids: [] as string[] } } }));
    const { value } = await withVariantOverrides({ label: "baseline" }, SWEEP_SCOPES.validation, {}, async (r) => planValidation(noCited, r, 1));
    expect(count(value, "isolated", "traceability")).toBe(0);
  });

  it("doubles the output cap and scales input by 1.35 for a 5.5 model", async () => {
    const base = await planFor();
    const v55 = await planFor({ traceability: "claude-sonnet-5-5" });
    const b = base.find((r) => r.stage === "traceability" && r.pass === "isolated")!;
    const f = v55.find((r) => r.stage === "traceability" && r.pass === "isolated")!;
    expect(f.maxTokens).toBe(b.maxTokens * 2);
    expect(f.inputEstTokens).toBeGreaterThanOrEqual(Math.floor(b.inputEstTokens * TOKENIZER_55_FACTOR));
  });

  it("estimates traceability from the rendered evidence text, so it grows when a cited Unit gains tags", async () => {
    const vc02 = cases[0]!;
    const tagged = {
      ...vc02,
      units: vc02.units.map((u) => ({
        ...u,
        skills: [...u.skills, "distributed systems design at very large scale"],
        tools: [...u.tools, "Kubernetes", "Terraform", "Apache Kafka"],
        domains: [...u.domains, "payments infrastructure"],
        date_range: { start: "2019-03-01", end: "2021-06-30" },
      })),
    };
    const est = async (lc: typeof vc02) =>
      (await withVariantOverrides({ label: "baseline" }, SWEEP_SCOPES.validation, {}, async (r) => planValidation([lc], r, 1))).value.filter(
        (r) => r.stage === "traceability",
      );
    const before = await est(vc02);
    const after = await est(tagged);
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]!.inputEstTokens, after[i]!.pass).toBeGreaterThan(before[i]!.inputEstTokens);
    // The estimate reads the same text the module sends, with the fixed run date.
    const text = traceabilityInput("claim", tagged.units);
    expect(text.split("\n").find((l) => l.startsWith("tools: "))).toContain('"Kubernetes"');
    expect(text).toContain('date_range: { start: "2019-03-01", end: "2021-06-30" }');
    expect(text).toContain('Today: "2026-01-15"');
  });

  it("scales with samples", async () => {
    const one = project(await planFor({}, 1));
    const three = project(await planFor({}, 3));
    expect(three.requests).toBe(one.requests * 3);
    expect(three.worstCaseUsd).toBeCloseTo(one.worstCaseUsd * 3, 8);
  });
});

describe("project", () => {
  it("prices worst case as 3 attempts at the full cap and expected below it", async () => {
    const p = project(await planFor());
    expect(p.expectedUsd).toBeLessThan(p.worstCaseUsd);
    for (const r of p.rows) expect(r.worstCaseUsd).toBeGreaterThanOrEqual(r.expectedUsd * MAX_ATTEMPTS * 0.999);
  });
});

describe("planGeneration", () => {
  it("plans downstream validation on production defaults whatever the variant", async () => {
    const snaps = loadGenerationSnapshots().items;
    const defaults = snapshotDefaults();
    const { value } = await withVariantOverrides(
      { label: "gen-sonnet", models: { generation: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      SWEEP_SCOPES.generation,
      {},
      async (r) => planGeneration(snaps, r, defaults, 1),
    );
    expect(value.filter((r) => r.stage === "generation").every((r) => r.model === "claude-sonnet-4-6" && r.maxTokens === 4096)).toBe(true);
    const downstream = value.filter((r) => r.pass === "downstream");
    expect(downstream.every((r) => r.model === "claude-sonnet-4-6")).toBe(true);
    expect(count(downstream, "downstream", "claim_extraction")).toBe(26 * 2);
  });
});

describe("largestUnits", () => {
  it("picks the Units with the most evidence text, not the first ones", () => {
    const u = (id: string, raw: number, sum: number) => ({ id, raw_text: "r".repeat(raw), normalized_summary: "s".repeat(sum) });
    const units = [u("small", 10, 10), u("big", 300, 50), u("mid", 100, 100), u("huge", 50, 500)];
    expect(largestUnits(units, 2).map((x) => x.id)).toEqual(["huge", "big"]);
    expect(largestUnits(units, 9)).toHaveLength(4);
    expect(units.map((x) => x.id)).toEqual(["small", "big", "mid", "huge"]);
  });
});
