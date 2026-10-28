import { afterEach, describe, expect, it, vi } from "vitest";

import * as cost from "../../../functions/src/llm/cost.ts";
import { clearEffortOverrides, clearModelOverrides, setEffortOverrides, setModelOverrides } from "../../../functions/src/llm/config.ts";
import { extractClaims } from "../../../functions/src/validation/claimExtraction.ts";
import { checkTraceability } from "../../../functions/src/validation/traceability.ts";

import { loadValidationCases } from "./fixtures.ts";
import { classifierKeyFor, crossCheckSettings, missingClassifiers, servedModelStatus, startInvocation, type CallRecord } from "./instrument.ts";
import { replayKey, ReplayStore, type MiniFs } from "./replay.ts";
import { defaultValidationAnswer, makeCtx, scriptedClient, textMessage, toolMessage } from "./testSupport.ts";

afterEach(() => {
  clearModelOverrides();
  clearEffortOverrides();
  vi.restoreAllMocks();
});

const META = { variant: "baseline", caseId: "vc-x", repeat: 0, stage: "claim_extraction" as const, pass: "isolated" as const };
const CTX = { ownerUid: "eval-owner", assetId: "a", bulletId: "b1" };
const BULLET = { text: "Cut p99 latency 60% on the Postgres job queue.", source_unit_ids: ["u1"] };

function memFs(): MiniFs {
  const files = new Map<string, string>();
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p)!,
    writeFileSync: (p, d) => void files.set(p, d),
    mkdirSync: () => undefined,
  };
}

describe("instrumentClient", () => {
  it("records each attempt's wire settings and classifies no_tool_use, schema_error, tool_use", async () => {
    const answers = [textMessage("I think..."), toolMessage("record_claims", { claims: [] }), toolMessage("record_claims", { claims: [{ text: "The user cut p99 latency 60%." }] })];
    const raw = scriptedClient(() => answers.shift()!);
    const ctx = makeCtx({ rawClient: raw.client });
    const inv = startInvocation(ctx, META);
    await extractClaims(BULLET, { ...CTX, signal: inv.signal }, { client: inv.client, record: inv.record });
    const rec = inv.finish(true);
    expect(ctx.calls.map((c) => c.outcome)).toEqual(["no_tool_use", "schema_error", "tool_use"]);
    expect(ctx.calls.map((c) => c.attemptIndex)).toEqual([0, 1, 2]);
    for (const c of ctx.calls) {
      expect(c).toMatchObject({ maxTokens: 2048, toolChoice: "forced", effort: null, requestedModel: "claude-sonnet-4-6", tokenFidelity: "metered" });
      expect(c.attemptId.startsWith("eval-test/")).toBe(true);
    }
    expect(new Set(ctx.calls.map((c) => c.attemptId)).size).toBe(3);
    expect(rec).toMatchObject({ ok: true, attempts: 3 });
  });

  it("classifies a generation answer citing an ineligible Unit as invented_id", async () => {
    const raw = scriptedClient(() =>
      toolMessage("record_resume", { summary: { text: "x", source_unit_ids: ["u_not_in_snapshot"] }, bullets: [], skills: [] }, { model: "claude-haiku-4-5-20251001" }),
    );
    const ctx = makeCtx({ rawClient: raw.client, suite: "generation" });
    const inv = startInvocation(ctx, { ...META, stage: "generation", pass: "generation", eligibleUnitIds: new Set(["u_ok"]) });
    await inv.client.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 4096, messages: [], tool_choice: { type: "tool", name: "record_resume" } } as never);
    expect(ctx.calls[0]!.outcome).toBe("invented_id");
  });

  it("records a transport error with no usage and its attempt index", async () => {
    const answers: (Error | ReturnType<typeof toolMessage>)[] = [new Error("ECONNRESET"), toolMessage("record_claims", { claims: [{ text: "The user did a thing." }] })];
    const raw = scriptedClient(() => answers.shift()!);
    const ctx = makeCtx({ rawClient: raw.client });
    const inv = startInvocation(ctx, META);
    vi.useFakeTimers();
    try {
      const p = extractClaims(BULLET, { ...CTX, signal: inv.signal }, { client: inv.client, record: inv.record });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(ctx.calls[0]).toMatchObject({ outcome: "transport_error", usage: null, attemptIndex: 0 });
    expect(ctx.calls[1]).toMatchObject({ outcome: "tool_use", attemptIndex: 1 });
  });

  it("releases a failed request's budget hold and settles a response's", async () => {
    const answers: (Error | ReturnType<typeof toolMessage>)[] = [new Error("ECONNRESET"), toolMessage("record_claims", { claims: [{ text: "The user did a thing." }] })];
    const raw = scriptedClient(() => answers.shift()!);
    const ctx = makeCtx({ rawClient: raw.client, maxUsd: 100 });
    const inv = startInvocation(ctx, META);
    vi.useFakeTimers();
    try {
      const p = extractClaims(BULLET, { ...CTX, signal: inv.signal }, { client: inv.client, record: inv.record });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(ctx.ledger.reservedUsd).toBe(0);
    expect(ctx.ledger.spentUsd).toBeCloseTo(ctx.calls[1]!.modeledUsd!, 10);
  });

  it("checks the served model on api and trusts the CLI's own assertion", () => {
    expect(servedModelStatus("api", "claude-sonnet-4-6", "claude-sonnet-4-6")).toBe("ok");
    expect(servedModelStatus("api", "claude-sonnet-4-6", "claude-sonnet-4-6-20260101")).toBe("ok");
    expect(servedModelStatus("api", "claude-sonnet-4-6", "claude-sonnet-4-60")).toBe("mismatch");
    expect(servedModelStatus("api", "claude-sonnet-4-6", "claude-haiku-4-5")).toBe("mismatch");
    expect(servedModelStatus("api", "claude-sonnet-4-6", "")).toBe("missing");
    expect(servedModelStatus("api", "claude-sonnet-4-6", undefined)).toBe("missing");
    expect(servedModelStatus("claude-cli", "claude-sonnet-4-6", undefined)).toBe("cli-asserted");
  });

  it("marks CLI calls estimated", async () => {
    const raw = scriptedClient(defaultValidationAnswer);
    const ctx = makeCtx({ rawClient: raw.client, tokenSource: "claude-cli" });
    const inv = startInvocation(ctx, META);
    await extractClaims(BULLET, { ...CTX, signal: inv.signal }, { client: inv.client, record: inv.record });
    expect(ctx.calls[0]).toMatchObject({ servedModelStatus: "cli-asserted", tokenFidelity: "estimated" });
  });

  it("stops at the budget: aborts the run, rejects without calling the raw client, and the module does not retry", async () => {
    const raw = scriptedClient(defaultValidationAnswer);
    const ctx = makeCtx({ rawClient: raw.client, maxUsd: 0.000001 });
    const inv = startInvocation(ctx, META);
    await expect(
      extractClaims(BULLET, { ...CTX, signal: inv.signal }, { client: inv.client, record: inv.record }),
    ).rejects.toThrow(/Spend bound reached/);
    expect(ctx.runAbort.signal.aborted).toBe(true);
    expect(raw.create).not.toHaveBeenCalled();
    expect(ctx.calls.map((c) => c.outcome)).toEqual(["budget_reached"]);
    // The refused request was never sent: not an attempt.
    expect(inv.finish(false, new Error("Spend bound reached"))).toMatchObject({ attempts: 0, failureKinds: ["budget_reached"] });

    const inv2 = startInvocation(ctx, META);
    await expect(inv2.client.messages.create({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [] } as never)).rejects.toThrow(
      /Spend bound reached/,
    );
    expect(raw.create).not.toHaveBeenCalled();
  });

  it("replays a stored response without calling, reserving or settling, keeping the modeled cost", async () => {
    const fs = memFs();
    const live = scriptedClient(defaultValidationAnswer);
    const first = makeCtx({ rawClient: live.client, store: new ReplayStore({ mode: "fresh", fs, dir: "/r" }) });
    const inv1 = startInvocation(first, META);
    await extractClaims(BULLET, { ...CTX, signal: inv1.signal }, { client: inv1.client, record: inv1.record });

    const offline = scriptedClient(() => new Error("should not be called"));
    const second = makeCtx({ rawClient: offline.client, store: new ReplayStore({ mode: "replay", fs, dir: "/r" }), maxUsd: 0.000001 });
    const inv2 = startInvocation(second, META);
    await extractClaims(BULLET, { ...CTX, signal: inv2.signal }, { client: inv2.client, record: inv2.record });
    expect(offline.create).not.toHaveBeenCalled();
    expect(second.ledger.spentUsd).toBe(0);
    expect(second.calls[0]).toMatchObject({ replayed: true, replayedFromRunId: "eval-test" });
    expect(second.calls[0]!.modeledUsd).toBe(first.calls[0]!.modeledUsd);
    expect(second.calls[0]!.requestKey).toBe(
      replayKey({ tokenSource: "api", cliAdapterVersion: null, repeat: 0, body: live.create.mock.calls[0]![0] }),
    );
  });

  it("collects usage records stamped with the run id and never calls production recordUsage", async () => {
    const spy = vi.spyOn(cost, "recordUsage");
    const raw = scriptedClient(defaultValidationAnswer);
    const ctx = makeCtx({ rawClient: raw.client });
    const inv = startInvocation(ctx, META);
    await extractClaims(BULLET, { ...CTX, signal: inv.signal }, { client: inv.client, record: inv.record });
    expect(inv.usage).toHaveLength(1);
    expect(inv.usage[0]).toMatchObject({ runId: "eval-test", subtask: "claim_extraction", maxTokens: 2048 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("outcome classifiers", () => {
  it("key on the version the module imports (the PROMPT_CONFIG default), and every suite key has one", () => {
    expect(classifierKeyFor("traceability")).toBe("validation/traceability@v1");
    expect(classifierKeyFor("generation")).toBe("generation/resume@v1");
    expect(classifierKeyFor("extraction")).toBeNull();
    expect(missingClassifiers(["validation/claimExtraction", "validation/traceability", "validation/specificity", "generation/resume"])).toEqual([]);
  });
});

describe("settings cross-check", () => {
  const call = { attemptIndex: 0, attemptId: "r/a0", maxTokens: 1024, effort: null } as unknown as CallRecord;

  it("flags a usage record whose maxTokens or effort differs from the wire", () => {
    expect(crossCheckSettings([{ attempt: 0, maxTokens: 2048 } as cost.UsageRecord], [call])).toEqual([
      "r/a0: recorded maxTokens 2048 but sent 1024",
    ]);
    expect(crossCheckSettings([{ attempt: 0, maxTokens: 1024, effort: "low" } as cost.UsageRecord], [call])[0]).toMatch(/recorded effort low/);
    expect(crossCheckSettings([{ attempt: 0, maxTokens: 1024 } as cost.UsageRecord], [call])).toEqual([]);
  });

  it("reports no mismatch from the real modules on baseline or a Sonnet 5.5 variant", async () => {
    const lc = loadValidationCases({ ids: ["vc-02-equivalent-numeric-notation"] }).items[0]!;
    for (const variant of ["baseline", "t55"]) {
      if (variant === "t55") {
        setModelOverrides({ traceability: { provider: "anthropic", model: "claude-sonnet-5-5" }, claim_extraction: { provider: "anthropic", model: "claude-sonnet-5-5" } });
        setEffortOverrides({ traceability: "medium" });
      }
      const raw = scriptedClient(defaultValidationAnswer);
      const ctx = makeCtx({ rawClient: raw.client });
      const a = startInvocation(ctx, { ...META, variant });
      await extractClaims(BULLET, { ...CTX, signal: a.signal }, { client: a.client, record: a.record });
      a.finish(true);
      const b = startInvocation(ctx, { ...META, variant, stage: "traceability" });
      await checkTraceability({ id: "c", bullet_id: "b", text: "Built the MVP." }, lc.units, { ownerUid: "o", signal: b.signal }, { client: b.client, record: b.record });
      b.finish(true);
      expect(ctx.settingsMismatches, variant).toEqual([]);
      if (variant === "t55") expect(ctx.calls.find((c) => c.stage === "traceability")).toMatchObject({ effort: "medium", maxTokens: 2048, toolChoice: "auto" });
    }
  });
});
