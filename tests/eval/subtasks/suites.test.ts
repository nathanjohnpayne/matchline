import { afterEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({ touched: 0 }));
vi.mock("../../../functions/src/firestore/admin.ts", () => ({
  getAdminDb: () => {
    firestore.touched++;
    throw new Error("the subtask suites must not touch Firestore");
  },
  initializeAdminAppForTests: () => {},
}));

import { clearEffortOverrides, clearModelOverrides, setModelOverrides } from "../../../functions/src/llm/config.ts";
import { clearPromptVersionOverrides } from "../../../functions/src/prompts/loader.ts";

import { SWEEP_SCOPES } from "../sweepScope.ts";

import { loadGenerationSnapshots, loadValidationCases } from "./fixtures.ts";
import { schemaValidity } from "./metrics.ts";
import { snapshotDefaults, withVariantOverrides } from "./overrides.ts";
import { runGenerationSuite, runValidationSuite } from "./suites.ts";
import { defaultValidationAnswer, makeCtx, scriptedClient, textMessage, toolMessage, type RequestBody } from "./testSupport.ts";

afterEach(() => {
  clearModelOverrides();
  clearEffortOverrides();
  clearPromptVersionOverrides();
  firestore.touched = 0;
});

const cases = loadValidationCases({ ids: ["vc-02-equivalent-numeric-notation", "vc-09-missing-cited-evidence"] }).items;
const sparse = loadGenerationSnapshots({ ids: ["gs-sparse-sofia-openai"] }).items;

function userOf(b: RequestBody): string {
  return b.messages[0]!.content;
}

describe("runValidationSuite", () => {
  it("grades each subtask in isolation against gold inputs and the item's cited Units", async () => {
    const raw = scriptedClient((b) => {
      if (b.tools[0]!.name === "record_claims") {
        return toolMessage("record_claims", { claims: [{ text: "MODEL-EXTRACTED CLAIM that must not reach traceability" }] });
      }
      return defaultValidationAnswer(b);
    });
    const ctx = makeCtx({ rawClient: raw.client });
    const results = await runValidationSuite(cases, "baseline", 0, ctx);
    const bodies = raw.create.mock.calls.map((c) => c[0] as RequestBody);

    const gold = cases.flatMap((c) => c.case.gold.assertions.map((a) => a.text));
    const isolatedTrace = ctx.calls.filter((c) => c.stage === "traceability" && c.pass === "isolated");
    expect(isolatedTrace).toHaveLength(gold.length);
    const traceBodies = bodies.filter((b) => b.tools[0]!.name === "record_traceability");
    for (const text of gold) expect(traceBodies.some((b) => userOf(b).includes(JSON.stringify(text))), text).toBe(true);
    // Only the whole-asset pass (the production orchestrator) feeds extracted claims to traceability.
    const wholeTrace = ctx.calls.filter((c) => c.stage === "traceability" && c.pass === "whole_asset");
    expect(traceBodies.filter((b) => userOf(b).includes("MODEL-EXTRACTED"))).toHaveLength(wholeTrace.length);
    expect(traceBodies).toHaveLength(gold.length + wholeTrace.length);
    // vc-09's uncited SOC 2 Unit never reaches a traceability request.
    for (const b of traceBodies) expect(userOf(b)).not.toContain("[Unit u_soc2]");

    // Specificity only for assertions with a specificity label (all of these have one).
    const isolatedSpec = ctx.calls.filter((c) => c.stage === "specificity" && c.pass === "isolated");
    expect(isolatedSpec).toHaveLength(gold.length);

    // The whole-asset pass sends nothing for the empty summary: exactly one extraction per case.
    expect(ctx.calls.filter((c) => c.stage === "claim_extraction" && c.pass === "whole_asset")).toHaveLength(cases.length);

    expect(results.map((r) => r.asset?.ok)).toEqual([true, true]);
    expect(bodies.every((b) => b.model === "claude-sonnet-4-6")).toBe(true);
    expect(firestore.touched).toBe(0);
  });

  it("skips specificity for assertions with no specificity label", async () => {
    const adv = loadValidationCases({ ids: ["vc-14-adversarial-fabrication"] }).items;
    const raw = scriptedClient(defaultValidationAnswer);
    const ctx = makeCtx({ rawClient: raw.client });
    await runValidationSuite(adv, "baseline", 0, ctx);
    expect(ctx.calls.filter((c) => c.stage === "specificity" && c.pass === "isolated")).toHaveLength(0);
  });

  it("routes only specificity to Haiku under a model.specificity variant", async () => {
    const raw = scriptedClient(defaultValidationAnswer);
    const ctx = makeCtx({ rawClient: raw.client });
    await withVariantOverrides(
      { label: "spec-haiku", models: { specificity: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } } },
      SWEEP_SCOPES.validation,
      {},
      () => runValidationSuite(cases.slice(0, 1), "spec-haiku", 0, ctx),
    );
    for (const c of ctx.calls) {
      expect(c.requestedModel, c.stage).toBe(c.stage === "specificity" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6");
    }
  });

  it("records siblings the call pool cancelled as cancelled, not as hard failures", async () => {
    // vc-03 whole-asset pass: four extracted claims; one claim's traceability check
    // genuinely fails (no tool call, three times) while the other three are in flight.
    const vc03 = loadValidationCases({ ids: ["vc-03-swapped-employer-project"] }).items;
    const create = vi.fn((body: RequestBody, opts?: { signal?: AbortSignal }) => {
      const tool = body.tools[0]!.name;
      const user = body.messages[0]!.content;
      if (tool === "record_claims") {
        return Promise.resolve(
          toolMessage("record_claims", { claims: ["FAILING claim one.", "Healthy claim two.", "Healthy claim three.", "Healthy claim four."].map((text) => ({ text })) }),
        );
      }
      if (tool === "record_traceability" && user.includes("FAILING")) return Promise.resolve(textMessage("I cannot call tools."));
      if (tool === "record_traceability" && user.includes("Healthy claim")) {
        // Like the SDK: in flight until the signal aborts, then an abort error.
        return new Promise((_, reject) => {
          const abort = () => reject(Object.assign(new Error("Request was aborted."), { name: "AbortError" }));
          if (opts?.signal?.aborted) abort();
          opts?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return Promise.resolve(defaultValidationAnswer(body));
    });
    const ctx = makeCtx({ rawClient: { messages: { create } } as never });
    // The isolated pass checks gold assertion text, so its traceability calls get the default answers.
    const [result] = await runValidationSuite(vc03, "baseline", 0, ctx);
    expect(result!.asset).toMatchObject({ ok: false });

    const whole = ctx.invocations.filter((i) => i.pass === "whole_asset" && i.stage === "traceability");
    expect(whole.map((i) => i.failureKinds).sort()).toEqual([["cancelled"], ["cancelled"], ["cancelled"], ["no_tool_use", "no_tool_use", "no_tool_use"]]);
    const m = schemaValidity(whole, ctx.calls.filter((c) => c.pass === "whole_asset" && c.stage === "traceability"));
    expect(m.invocations).toBe(1);
    expect(m.hardFail).toEqual({ num: 1, den: 1, value: 1 });
    expect(m.errorRate).toBe(1);
    expect(m.cancelled).toBe(3);
    expect(m.hardFailKinds).toEqual({ no_tool_use: 3 });
  });

  it("marks remaining cases skipped once the budget is reached and makes no further calls", async () => {
    const raw = scriptedClient(defaultValidationAnswer);
    const ctx = makeCtx({ rawClient: raw.client, maxUsd: 0.000001 });
    const results = await runValidationSuite(cases, "baseline", 0, ctx);
    expect(raw.create).not.toHaveBeenCalled();
    expect(results[1]!.skipped).toBe("budget_reached");
    expect(ctx.runAbort.signal.aborted).toBe(true);
  });
});

function resumeAnswer(ids: string[]) {
  return toolMessage(
    "record_resume",
    {
      summary: { text: "Founder-engineer who built Threadline from scratch.", source_unit_ids: [ids[0]!] },
      bullets: ids.map((id) => ({ text: `Shipped work grounded in ${id}.`, source_unit_ids: [id] })),
      skills: [],
    },
    { model: "claude-haiku-4-5-20251001" },
  );
}

describe("runGenerationSuite", () => {
  it("generates from frozen inputs and validates on production defaults", async () => {
    const raw = scriptedClient((b) => (b.tools[0]!.name === "record_resume" ? resumeAnswer(["u_threadline_mvp"]) : defaultValidationAnswer(b)));
    const ctx = makeCtx({ rawClient: raw.client, suite: "generation" });
    const defaults = snapshotDefaults();
    const [flow] = await withVariantOverrides(
      { label: "gen-sonnet", models: { generation: { provider: "anthropic", model: "claude-sonnet-4-6" } } },
      SWEEP_SCOPES.generation,
      {},
      () => runGenerationSuite(sparse, "gen-sonnet", 0, ctx, defaults),
    ).then((r) => r.value);
    expect(flow!.generated).toBe(true);
    expect(flow!.completed).toBe(true);
    const validation = ctx.calls.filter((c) => c.pass === "downstream");
    expect(validation.length).toBeGreaterThan(0);
    expect(validation.every((c) => c.requestedModel === "claude-sonnet-4-6")).toBe(true);
    expect(ctx.calls.find((c) => c.stage === "generation")!.requestedModel).toBe("claude-sonnet-4-6");
    expect(firestore.touched).toBe(0);
    expect(flow!.spans!.e2eMs).toBeGreaterThan(0);
    expect(flow!.spans!.e2eMs).toBeGreaterThanOrEqual(flow!.spans!.generationMs!);
  });

  it("refuses to grade with a leaked validation override: the flow is not completed", async () => {
    const raw = scriptedClient((b) => (b.tools[0]!.name === "record_resume" ? resumeAnswer(["u_threadline_mvp"]) : defaultValidationAnswer(b)));
    const ctx = makeCtx({ rawClient: raw.client, suite: "generation" });
    const defaults = snapshotDefaults();
    setModelOverrides({ traceability: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } });
    const [flow] = await runGenerationSuite(sparse, "baseline", 0, ctx, defaults);
    expect(flow!.generated).toBe(true);
    expect(flow!.completed).toBe(false);
    expect(flow!.downstream).toMatchObject({ ok: false });
    expect(ctx.calls.some((c) => c.pass === "downstream")).toBe(false);
  });

  it("records GenerationError failure kinds after three invalid answers", async () => {
    const raw = scriptedClient(() => resumeAnswer(["u_invented"]));
    const ctx = makeCtx({ rawClient: raw.client, suite: "generation" });
    const [flow] = await runGenerationSuite(sparse, "baseline", 0, ctx, snapshotDefaults());
    expect(flow!.generated).toBe(false);
    expect(flow!.completed).toBe(false);
    expect(flow!.attempts).toBe(3);
    // The pipeline's own GenerationError kinds are recorded as given (one per attempt); which
    // kind the pipeline names is its business. The harness's classification is the stable signal.
    expect(flow!.failureKinds).toHaveLength(3);
    for (const k of flow!.failureKinds) expect(typeof k).toBe("string");
    expect(ctx.calls.map((c) => c.outcome)).toEqual(["invented_id", "invented_id", "invented_id"]);
  });

  it("takes flow spans from the injected clock", async () => {
    let t = 1_000;
    const raw = scriptedClient((b) => (b.tools[0]!.name === "record_resume" ? resumeAnswer(["u_threadline_mvp"]) : defaultValidationAnswer(b)));
    const ctx = makeCtx({ rawClient: raw.client, suite: "generation", clock: () => (t += 5) });
    const [flow] = await runGenerationSuite(sparse, "baseline", 0, ctx, snapshotDefaults());
    expect(flow!.spans!.e2eMs % 5).toBe(0);
    expect(flow!.spans!.validationMs).not.toBeNull();
  });
});
