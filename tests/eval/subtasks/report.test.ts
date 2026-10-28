import { describe, expect, it } from "vitest";

import type { CallRecord } from "./instrument.ts";
import { clusteredRate, costMetrics, wallTime } from "./metrics.ts";
import { CAVEAT, comparable, formatSubtaskReport, labelStatus, rate, type RunRecord, type VariantRecord } from "./report.ts";

const resolved = {
  label: "baseline",
  stages: {
    traceability: { provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 1024, toolChoice: "forced" as const, outputBudgetFactor: 1 },
    specificity: { provider: "anthropic", model: "claude-sonnet-5-5", maxTokens: 1024, toolChoice: "auto" as const, effort: "high" as const, outputBudgetFactor: 2 },
  },
  promptVersions: {
    "validation/traceability": { version: "v1", fingerprint: "v1:0123456789abcdef" },
    "validation/specificity": { version: "v1", fingerprint: "v1:fedcba9876543210" },
  },
};

const call: CallRecord = {
  runId: "eval-1", attemptId: "a", suite: "validation", pass: "isolated", variant: "baseline", caseId: "c", repeat: 0, stage: "traceability",
  invocationId: "i", attemptIndex: 0, requestedModel: "claude-sonnet-4-6", servedModel: "claude-sonnet-4-6", servedModelStatus: "ok",
  maxTokens: 1024, toolChoice: "forced", effort: null, requestKey: "k", startedAtMs: 0, endedAtMs: 100, outcome: "tool_use",
  usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 30, cacheCreationInputTokens: 4 }, replayed: true,
  replayedFromRunId: "eval-0", tokenFidelity: "metered", modeledUsd: 0.002,
};

function variant(p: Partial<VariantRecord> = {}): VariantRecord {
  return {
    label: "baseline", validity: "valid", resolved, servedModels: { traceability: ["claude-sonnet-4-6"] }, concurrency: 6, budgetMs: null,
    metrics: null, wallTime: wallTime([call], ["traceability"], null), usage: costMetrics([call], 1), notes: [], ...p,
  };
}

function record(p: Partial<RunRecord> = {}): RunRecord {
  return {
    schema_version: 1, runId: "eval-20261028T190112Z-3fa9c1", suite: "validation", startedAt: "s", finishedAt: "f", dryRun: false,
    git: { sha: "05272fc0000", dirty: false }, tokenSource: "api", tokenFidelity: "metered", cacheMode: "fresh", samples: 1,
    labels: {
      status: "draft",
      fixtureSetHash: "sha256:9c41aaaa",
      files: [{ path: "validation-cases/vc-01-x.json", sha256: "1f0a".padEnd(64, "0"), label_version: 1, review_status: "draft-pending-owner-review", labeled_by: "claude-draft" }],
      primary: [{ id: "vc-01-x", path: "validation-cases/vc-01-x.json", derivedFrom: null }],
    },
    schemas: { "validation/traceability@v1": "5e3d".padEnd(64, "0") },
    judge: null,
    variants: [variant(), variant({ label: "bad", validity: "invalid: served-model" })],
    guards: { maxUsd: 5, projected: { expectedUsd: 1, worstCaseUsd: 2, requests: 10 }, capChecks: [], offlineReplay: false, spentUsd: 0.5, budgetReached: false },
    plan: null, invocations: [], calls: [call], caveat: CAVEAT, ...p,
  };
}

describe("formatSubtaskReport", () => {
  const text = formatSubtaskReport(record());

  it("carries the run metadata header", () => {
    expect(text).toContain("eval-20261028T190112Z-3fa9c1");
    expect(text).toContain("token source: api (metered)");
    expect(text).toContain("cache: fresh (never reads earlier runs)");
    expect(text).toContain("DRAFT LABELS");
    expect(text).toContain("validation-cases/vc-01-x.json");
    expect(text).toContain("sha256:9c41aaaa");
    expect(text).toContain("v1:0123456789abcdef");
    expect(text).toContain("5e3d");
    expect(text).toContain("Onboarding extraction is not part of this suite");
  });

  it("shows the settings as sent on the wire", () => {
    expect(text).toMatch(/specificity\s+claude-sonnet-5-5\s+-\s+high\s+1024\s+auto/);
    expect(text).toMatch(/traceability\s+claude-sonnet-4-6\s+claude-sonnet-4-6\s+-\s+1024\s+forced/);
  });

  it("marks invalid variants not comparable", () => {
    expect(text).toContain("variant bad   validity: invalid: served-model — not comparable");
  });

  it("separates provider cache tokens from local replay, and labels wall time a span", () => {
    expect(text).toContain("provider cache tokens: read 30, write 4");
    expect(text).toContain("local replay: 1 calls");
    expect(text).toContain("span, not sum");
    expect(text).toContain(`caveat: ${CAVEAT}`);
  });

  it("keys wall time by pass and stage", () => {
    const live = { ...call, replayed: false, replayedFromRunId: null };
    const out = formatSubtaskReport(record({ variants: [variant({ wallTime: wallTime([live], ["traceability"], [250]) })] }));
    expect(out).toContain("isolated/traceability: span p50 100ms");
    expect(out).toContain("end to end (validateAsset, whole-asset pass): p50 250ms");
  });

  it("labels the per-flow cost and reports the isolated pass on its own line", () => {
    const whole = { ...call, pass: "whole_asset" as const, replayed: false, modeledUsd: 0.01 };
    const v = variant({ usage: costMetrics([call, whole], 1, { label: "validated asset (whole-asset pass)", passes: ["whole_asset"] }) });
    const out = formatSubtaskReport(record({ variants: [v] }));
    expect(out).toContain("cost per validated asset (whole-asset pass) $0.0100 (n=1)");
    expect(out).toContain("isolated pass (evaluation only, not a production cost) modeled $0.0020");
    expect(out).not.toContain("cost per completed flow");
    const none = formatSubtaskReport(record({ variants: [variant({ usage: costMetrics([call], 0) })] }));
    expect(none).toContain("cost per completed flow n/a (none completed) (n=0)");
  });

  it("drops the DRAFT banner only when every file is owner-reviewed", () => {
    const owner = record({
      labels: { ...record().labels, status: "owner-reviewed", files: record().labels.files.map((f) => ({ ...f, review_status: "owner-reviewed" })) },
    });
    expect(formatSubtaskReport(owner)).not.toContain("DRAFT LABELS");
    expect(labelStatus([{ review_status: "owner-reviewed" }, { review_status: "draft-pending-owner-review" }])).toBe("mixed");
  });

  it("round-trips the record through JSON", () => {
    const r = record();
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("rate", () => {
  it("prints distinct units, a Wilson interval, and pooled samples only when repeats exist", () => {
    const once = clusteredRate([{ unit: "a", hit: false }, { unit: "b", hit: false }, { unit: "c", hit: false }, { unit: "d", hit: false }]);
    expect(rate(once, "assertions")).toMatch(/^0\.0% \(0\/4 assertions, 95% CI 0\.0%–49\.0%\)$/);
    const thrice = clusteredRate(["a", "b", "c", "d"].flatMap((unit) => [0, 1, 2].map(() => ({ unit, hit: false }))));
    expect(rate(thrice, "assertions")).toBe(`${rate(once, "assertions").slice(0, -1)}; 0/12 samples)`);
    expect(rate(clusteredRate([]), "cases")).toBe("— (0/0 cases)");
  });
});

describe("comparable", () => {
  const judge = { stages: resolved.stages, promptVersions: resolved.promptVersions };
  const gen = (p: Partial<RunRecord> = {}) => record({ suite: "generation", judge, ...p });

  it("is false when the fixture set, token source or replay mode differ, true otherwise", () => {
    const a = record();
    expect(comparable(a, record())).toEqual({ ok: true, caveats: [] });
    expect(comparable(a, record({ labels: { ...a.labels, fixtureSetHash: "sha256:other" } })).ok).toBe(false);
    expect(comparable(a, record({ tokenSource: "claude-cli" })).ok).toBe(false);
    expect(comparable(a, record({ cacheMode: "replay" })).ok).toBe(false);
    expect(comparable(a, record({ cacheMode: "bypass" }))).toEqual({ ok: true, caveats: [] });
  });

  it("is false when the sample count or an enforced schema differs", () => {
    const a = record();
    expect(comparable(a, record({ samples: 3 }))).toEqual({ ok: false, reason: "different samples per case (1 vs 3)" });
    const schemas = { "validation/traceability@v1": "9999".padEnd(64, "0") };
    expect(comparable(a, record({ schemas }))).toEqual({ ok: false, reason: "different enforced tool schema for validation/traceability@v1" });
    // A schema present in one run only (e.g. the default moved to a new version) also refuses.
    expect(comparable(a, record({ schemas: { ...a.schemas, "validation/traceability@v2": "5e3d".padEnd(64, "0") } })).ok).toBe(false);
  });

  it("is false when the baseline prompt fingerprint changed (a prompt edited in place)", () => {
    const edited = {
      ...resolved,
      promptVersions: { ...resolved.promptVersions, "validation/traceability": { version: "v1", fingerprint: "v1:aaaaaaaaaaaaaaaa" } },
    };
    const c = comparable(record(), record({ variants: [variant({ resolved: edited })] }));
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(/^variant baseline: different prompt for validation\/traceability \(v1:0123456789abcdef vs v1:aaaaaaaaaaaaaaaa\)/);
  });

  it("is false when the baseline stage settings changed, or a run has no baseline", () => {
    const sonnet55 = { ...resolved, stages: { ...resolved.stages, traceability: { ...resolved.stages.traceability, model: "claude-sonnet-5-5" } } };
    const c = comparable(record(), record({ variants: [variant({ resolved: sonnet55 })] }));
    expect(c).toEqual({ ok: false, reason: "variant baseline: different settings for stage traceability (model, effort, max_tokens or tool choice)" });
    expect(comparable(record(), record({ variants: [variant({ label: "other" })] }))).toEqual({ ok: false, reason: "a run has no baseline variant" });
  });

  it("is false when the generation suite's judge differs or is missing", () => {
    expect(comparable(gen(), gen())).toEqual({ ok: true, caveats: [] });
    const judged = { ...judge, promptVersions: { ...judge.promptVersions, "validation/traceability": { version: "v2", fingerprint: "v2:bbbbbbbbbbbbbbbb" } } };
    const c = comparable(gen(), gen({ judge: judged }));
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toMatch(/^judge: different prompt for validation\/traceability/);
      expect(c.reason).toContain("different validators");
    }
    const effort = { ...judge, stages: { ...judge.stages, traceability: { ...judge.stages.traceability, effort: "low" as const } } };
    expect(comparable(gen(), gen({ judge: effort })).ok).toBe(false);
    expect(comparable(gen(), gen({ judge: null }))).toEqual({ ok: false, reason: "a generation run did not record its judge (the pinned validator)" });
  });

  it("allows a different git sha but returns it as a caveat", () => {
    const c = comparable(record(), record({ git: { sha: "abcdef01234", dirty: false } }));
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.caveats[0]).toMatch(/^different or unknown git state \(05272fc vs abcdef0\)/);
  });

  it("prints the judge in the generation header", () => {
    const out = formatSubtaskReport(gen());
    expect(out).toContain("judge (baseline validator, pinned to production defaults");
    expect(out).toMatch(/traceability\s+claude-sonnet-4-6\s+-\s+1024\s+forced\s+validation\/traceability v1:0123456789abcdef/);
  });
});
