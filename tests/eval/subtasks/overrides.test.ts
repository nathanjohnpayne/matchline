import { afterEach, describe, expect, it, vi } from "vitest";

import { runGenerationPipeline } from "../../../functions/src/generation/pipeline.ts";
import {
  clearEffortOverrides,
  clearModelOverrides,
  getEffortOverrides,
  getModelOverrides,
  modelFor,
  setEffortOverrides,
  setModelOverrides,
  STAGES,
} from "../../../functions/src/llm/config.ts";
import { clearPromptVersionOverrides, getPromptVersionOverrides } from "../../../functions/src/prompts/loader.ts";
import { extractClaims } from "../../../functions/src/validation/claimExtraction.ts";
import { checkSpecificity } from "../../../functions/src/validation/specificity.ts";
import { checkTraceability } from "../../../functions/src/validation/traceability.ts";

import { defaultPromptVersion, SWEEP_SCOPES } from "../sweepScope.ts";

import { loadGenerationSnapshots, loadValidationCases, toGenerationInputs } from "./fixtures.ts";
import {
  assertValidationAtDefaults,
  snapshotDefaults,
  STAGE_REQUEST_TABLE,
  withVariantOverrides,
} from "./overrides.ts";
import { defaultValidationAnswer, scriptedClient, toolMessage, type RequestBody } from "./testSupport.ts";

const HAIKU = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" };
const SONNET_55 = { provider: "anthropic" as const, model: "claude-sonnet-5-5" };
const VALIDATION = SWEEP_SCOPES.validation;

afterEach(() => {
  clearModelOverrides();
  clearEffortOverrides();
  clearPromptVersionOverrides();
});

function expectClean(): void {
  expect(getModelOverrides()).toEqual({});
  expect(getEffortOverrides()).toEqual({});
  expect(getPromptVersionOverrides()).toEqual({});
}

describe("withVariantOverrides", () => {
  it("installs only the variant's overrides inside fn and restores defaults after", async () => {
    const defaults = Object.fromEntries(STAGES.map((s) => [s, modelFor(s)]));
    await withVariantOverrides({ label: "spec-haiku", models: { specificity: HAIKU } }, VALIDATION, {}, async () => {
      expect(modelFor("specificity")).toEqual(HAIKU);
      expect(modelFor("traceability").model).toBe("claude-sonnet-4-6");
      expect(modelFor("claim_extraction").model).toBe("claude-sonnet-4-6");
    });
    expectClean();
    for (const s of STAGES) expect(modelFor(s)).toEqual(defaults[s]);
  });

  it("restores after fn throws and propagates the error", async () => {
    await expect(
      withVariantOverrides({ label: "x", models: { traceability: HAIKU } }, VALIDATION, {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expectClean();
    expect(modelFor("traceability").model).toBe("claude-sonnet-4-6");
  });

  it("refuses to start when an earlier override leaked, without running fn", async () => {
    setModelOverrides({ claim_extraction: HAIKU });
    const fn = vi.fn(async () => {});
    await expect(withVariantOverrides({ label: "x" }, VALIDATION, {}, fn)).rejects.toThrow(/override leaked/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses an unsupported effort during resolution, before fn, leaving the maps empty", async () => {
    const fn = vi.fn(async () => {});
    await expect(
      withVariantOverrides({ label: "x", efforts: { traceability: "low" } }, VALIDATION, {}, fn),
    ).rejects.toThrow(/does not accept an effort setting/);
    expect(fn).not.toHaveBeenCalled();
    expectClean();
  });

  it("refuses a base prompt key or stage outside the scope", async () => {
    await expect(withVariantOverrides({ label: "x" }, VALIDATION, { "extraction/resume": "v1" }, async () => {})).rejects.toThrow(
      /prompt\.extraction\/resume not exercised by suite validation/,
    );
    await expect(
      withVariantOverrides({ label: "x", models: { extraction: HAIKU } }, VALIDATION, {}, async () => {}),
    ).rejects.toThrow(/model\.extraction not exercised/);
    expectClean();
  });

  it("resolves every scope stage with the settings toolCallRequest sends", async () => {
    const { resolved } = await withVariantOverrides(
      { label: "t55", models: { traceability: SONNET_55 } },
      VALIDATION,
      {},
      async () => {},
    );
    expect(Object.keys(resolved.stages).sort()).toEqual(["claim_extraction", "specificity", "traceability"]);
    expect(resolved.stages.claim_extraction).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      maxTokens: 2048,
      toolChoice: "forced",
      outputBudgetFactor: 1,
    });
    expect(resolved.stages.traceability).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      maxTokens: 2048,
      toolChoice: "auto",
      effort: "high",
      outputBudgetFactor: 2,
    });
    const wired = defaultPromptVersion("validation/traceability");
    expect(resolved.promptVersions["validation/traceability"]!.fingerprint).toMatch(new RegExp(`^${wired}:[0-9a-f]{16}$`));
  });
});

describe("assertValidationAtDefaults", () => {
  it("passes on defaults and throws on any validation override or effort", () => {
    const defaults = snapshotDefaults();
    expect(() => assertValidationAtDefaults(defaults)).not.toThrow();
    setModelOverrides({ specificity: HAIKU });
    expect(() => assertValidationAtDefaults(defaults)).toThrow(/not pinned to production defaults/);
    clearModelOverrides();
    setEffortOverrides({ claim_extraction: "low" });
    expect(() => assertValidationAtDefaults(defaults)).toThrow(/not pinned to production defaults/);
  });
});

describe("STAGE_REQUEST_TABLE", () => {
  const sent = (create: ReturnType<typeof scriptedClient>["create"]) => create.mock.calls[0]![0] as RequestBody;
  const record = async () => 0;
  const lc = loadValidationCases({ ids: ["vc-02-equivalent-numeric-notation"] }).items[0]!;
  const claim = { id: "c", bullet_id: "b", text: "Built the Threadline MVP solo in 14 months." };

  it("matches what each validation module sends on defaults", async () => {
    const ce = scriptedClient(defaultValidationAnswer);
    await extractClaims({ text: lc.case.item.text, source_unit_ids: ["u_threadline_mvp"] }, { ownerUid: "o", assetId: "a", bulletId: "b" }, { client: ce.client, record });
    const tr = scriptedClient(defaultValidationAnswer);
    await checkTraceability(claim, lc.units, { ownerUid: "o" }, { client: tr.client, record });
    const sp = scriptedClient(defaultValidationAnswer);
    await checkSpecificity(claim, { ownerUid: "o" }, { client: sp.client, record });
    for (const [stage, c] of [["claim_extraction", ce], ["traceability", tr], ["specificity", sp]] as const) {
      const body = sent(c.create);
      expect(body.max_tokens, stage).toBe(STAGE_REQUEST_TABLE[stage]!.baseMaxTokens);
      expect(body.tools[0]!.name, stage).toBe(STAGE_REQUEST_TABLE[stage]!.toolName);
    }
  });

  it("matches what the generation pipeline sends", async () => {
    const snap = loadGenerationSnapshots({ ids: ["gs-sparse-sofia-openai"] }).items[0]!;
    const inputs = toGenerationInputs(snap.snapshot, snap.resumeText, snap.jdText);
    const g = scriptedClient(() =>
      toolMessage("record_resume", {
        summary: { text: "Founder-engineer.", source_unit_ids: ["u_threadline_mvp"] },
        bullets: [],
        skills: [],
      }, { model: "claude-haiku-4-5-20251001" }),
    );
    await runGenerationPipeline({ ownerUid: "o", applicationId: "a" }, { client: g.client, record, loadInputs: async () => inputs });
    const body = sent(g.create);
    expect(body.max_tokens).toBe(STAGE_REQUEST_TABLE.generation!.baseMaxTokens);
    expect(body.tools[0]!.name).toBe(STAGE_REQUEST_TABLE.generation!.toolName);
  });
});
