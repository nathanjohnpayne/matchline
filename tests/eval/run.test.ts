import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkCaps, DEFAULT_CAPS, shouldBlock } from "./projection.js";

import {
  SMOKE_JD,
  SMOKE_RESUME,
  aggregateSampledFixture,
  computeFlowCount,
  estimatePlannedSpend,
  filterToLabeledPairs,
  liveStageFraction,
  offlineOnlyClient,
  parsePromptOverrides,
  parseSamples,
  resolvePromptVersionsForReport,
  scaleSpendByProvider,
  selectFixturesForMode,
  toFixtureResult,
} from "./run.js";
import type { RunForFixtureResult } from "./runForFixture.js";

function makeOrchestratorResult(
  overrides: Partial<RunForFixtureResult> = {},
): RunForFixtureResult {
  return {
    resumeFixtureId: "alice",
    jdFixtureId: "role",
    extractionAccuracy: 0.85,
    matchAccuracy: 0.75,
    latencyMs: 1234,
    costUsd: 0.05,
    modeledCostUsd: 0.05,
    cacheHits: 0,
    cacheMisses: 4,
    extractedUnitCount: 10,
    parsedRequirementCount: 8,
    matchCount: 25,
    ok: true,
    error: null,
    ...overrides,
  };
}

describe("liveStageFraction", () => {
  // Codex P1: the guard projected all flows at the flat $0.75
  // estimate regardless of cache state, so a fully warm 10x10 corpus
  // — which performs ZERO paid calls — exceeded the Anthropic cap and
  // exited 1, breaking the headline offline matching-tuning workflow.
  it("returns 0 for a fully warm run", () => {
    expect(liveStageFraction({ hits: 40, misses: 0 })).toBe(0);
  });

  it("returns 1 for a fully cold run", () => {
    expect(liveStageFraction({ hits: 0, misses: 40 })).toBe(1);
  });

  it("returns the miss share for a partially warm run", () => {
    expect(liveStageFraction({ hits: 30, misses: 10 })).toBeCloseTo(0.25, 10);
  });

  it("stays conservative when nothing was recorded", () => {
    // Cache bypassed, or no fixtures ran — keep the pre-#389 estimate.
    expect(liveStageFraction({ hits: 0, misses: 0 })).toBe(1);
  });

  // Codex P2 round 2: the aggregate ratio is not a safe proxy for a
  // single provider. Embeddings (OpenAI) hitting while extraction and
  // parsing (Anthropic) miss reads as 50% warm, which would halve the
  // Anthropic projection even though every Anthropic call ran live.
  it("scales each provider by its OWN miss rate", () => {
    const stats = {
      hits: 2,
      misses: 2,
      hitsByProvider: { openai: 2 },
      missesByProvider: { anthropic: 2 },
    };
    expect(liveStageFraction(stats, "anthropic")).toBe(1);
    expect(liveStageFraction(stats, "openai")).toBe(0);
    // The aggregate would have said 50% for both.
    expect(liveStageFraction(stats)).toBe(0.5);
  });

  it("stays conservative for a provider with no recorded stages", () => {
    expect(liveStageFraction({ hits: 4, misses: 0, hitsByProvider: { openai: 4 } }, "anthropic")).toBe(1);
  });

  it("does not discount a partially warm provider by its stage count", () => {
    // Extraction (Sonnet) and requirement parsing (Haiku) cost very
    // different amounts. One hit and one miss therefore cannot mean
    // half the provider spend; retain the full estimate until both hit.
    expect(
      liveStageFraction(
        {
          hits: 1,
          misses: 1,
          hitsByProvider: { anthropic: 1 },
          missesByProvider: { anthropic: 1 },
        },
        "anthropic",
      ),
    ).toBe(1);
  });
});

describe("scaleSpendByProvider", () => {
  const warm = {
    hits: 4,
    misses: 0,
    hitsByProvider: { anthropic: 2, openai: 2 },
    missesByProvider: {},
  };
  const cold = {
    hits: 0,
    misses: 4,
    hitsByProvider: {},
    missesByProvider: { anthropic: 2, openai: 2 },
  };

  it("lets a fully warm 10x10 corpus pass the cap", () => {
    const checks = checkCaps(
      { anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 },
      scaleSpendByProvider(estimatePlannedSpend("full", 100), warm),
      DEFAULT_CAPS,
    );
    expect(shouldBlock(checks)).toBe(false);
  });

  it("still blocks that same corpus when cold", () => {
    const checks = checkCaps(
      { anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 },
      scaleSpendByProvider(estimatePlannedSpend("full", 100), cold),
      DEFAULT_CAPS,
    );
    expect(shouldBlock(checks)).toBe(true);
  });

  it("does not discount Anthropic when only the embeddings were warm", () => {
    // The bug: aggregate scaling halved this and let it through.
    const mixed = {
      hits: 2,
      misses: 2,
      hitsByProvider: { openai: 2 },
      missesByProvider: { anthropic: 2 },
    };
    const full = estimatePlannedSpend("full", 100);
    const scaled = scaleSpendByProvider(full, mixed);
    expect(scaled.anthropicUsd).toBe(full.anthropicUsd);
    expect(scaled.openaiUsd).toBe(0);
    expect(shouldBlock(checkCaps({ anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 }, scaled, DEFAULT_CAPS))).toBe(true);
  });
});

describe("offlineOnlyClient", () => {
  // Codex P1: the credential gate used to send warm runs to the stub
  // path, blocking the cache's headline use case — $0 offline
  // matching / ontology tuning. Credential-free runs now install this
  // placeholder, so a fully cached corpus completes and a genuine
  // miss fails that fixture loudly instead of attempting an
  // unauthenticated call.
  it("throws an actionable error naming the missing variable", () => {
    const client = offlineOnlyClient<{
      messages: { create: () => never };
      embeddings: { create: () => never };
    }>("Anthropic", "ANTHROPIC_API_KEY");

    expect(() => client.messages.create()).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(() => client.messages.create()).toThrow(/warm the cache for this fixture/);
  });

  it("satisfies both the Anthropic and OpenAI call shapes", () => {
    // One placeholder stands in for both clients, so it has to carry
    // `messages.create` AND `embeddings.create`.
    const client = offlineOnlyClient<{
      messages: { create: () => never };
      embeddings: { create: () => never };
    }>("OpenAI", "OPENAI_API_KEY");

    expect(typeof client.messages.create).toBe("function");
    expect(typeof client.embeddings.create).toBe("function");
    expect(() => client.embeddings.create()).toThrow(/OPENAI_API_KEY/);
  });
});

describe("computeFlowCount", () => {
  it("returns 0 when there are no resume fixtures", () => {
    expect(computeFlowCount("smoke", 0, 10)).toBe(0);
    expect(computeFlowCount("full", 0, 10)).toBe(0);
  });

  it("returns 0 when there are no JD fixtures (regression on #55)", () => {
    // nathanpayne-codex hit this: 50 resumes × 0 JDs was reported
    // as 50 flows because of a Math.max(..., 1) floor on the JD
    // multiplier. A corpus with resumes but no JDs has zero flows
    // — the cross-product is empty.
    expect(computeFlowCount("smoke", 1, 0)).toBe(0);
    expect(computeFlowCount("full", 50, 0)).toBe(0);
    expect(computeFlowCount("full", 10, 0)).toBe(0);
  });

  it("returns 0 when both sides are negative (defensive)", () => {
    expect(computeFlowCount("smoke", -1, 10)).toBe(0);
    expect(computeFlowCount("full", 10, -1)).toBe(0);
  });

  it("smoke mode pairs exactly one resume with one JD", () => {
    expect(computeFlowCount("smoke", 1, 1)).toBe(1);
    expect(computeFlowCount("smoke", 1, 10)).toBe(1);
    expect(computeFlowCount("smoke", 50, 10)).toBe(1);
  });

  it("full mode returns the full cross product", () => {
    expect(computeFlowCount("full", 1, 1)).toBe(1);
    expect(computeFlowCount("full", 10, 10)).toBe(100);
    expect(computeFlowCount("full", 3, 7)).toBe(21);
  });

  it("scales linearly on full mode", () => {
    // The projection guard multiplies this by $perFlow; linearity
    // lets us reason about it cleanly.
    const small = computeFlowCount("full", 5, 5);
    const large = computeFlowCount("full", 50, 50);
    expect(large / small).toBe(100); // (50*50) / (5*5) = 100
  });
});

describe("toFixtureResult", () => {
  it("HAPPY PATH: passes through accuracies + latency + cost; notes summarize counts", () => {
    const r = toFixtureResult(makeOrchestratorResult());
    expect(r.id).toBe("alice__role");
    expect(r.extractionAccuracy).toBe(0.85);
    expect(r.matchAccuracy).toBe(0.75);
    expect(r.latencyMs).toBe(1234);
    expect(r.costUsd).toBe(0.05);
    expect(r.notes).toContain("extracted=10");
    expect(r.notes).toContain("reqs=8");
    expect(r.notes).toContain("matches=25");
  });

  it("FAILURE PATH (cursor #139 r3): preserves PARTIAL cost from the orchestrator's costUsd field — does not zero or null it", () => {
    // The load-bearing pin. Prior to cursor #139 r3, the
    // CLI translated `ok=false` results to `costUsd: null`,
    // which dropped the partial accumulation from the
    // aggregate total in the report. The orchestrator
    // already preserves partial cost on the failure path
    // (cursor #139 r2); this test pins that the CLI layer
    // surfaces it instead of nulling it out.
    const failed = makeOrchestratorResult({
      ok: false,
      error: "transport error mid-parse",
      // Real spend from extraction before parsing threw.
      costUsd: 0.0042,
      // Failed runs return 0 for these by orchestrator contract.
      extractionAccuracy: 0,
      matchAccuracy: 0,
    });
    const r = toFixtureResult(failed);
    expect(r.costUsd).toBe(0.0042);
    expect(r.extractionAccuracy).toBe(0);
    expect(r.matchAccuracy).toBe(0);
    expect(r.notes).toMatch(/^failed/);
    // The cost dollar amount also surfaces in the notes
    // string so a human reader of the CLI report sees it
    // alongside the failure reason.
    expect(r.notes).toContain("$0.0042");
    expect(r.notes).toContain("transport error mid-parse");
  });

  it("FAILURE PATH: handles costUsd=0 (failure before any API call)", () => {
    const failed = makeOrchestratorResult({
      ok: false,
      error: "fixture not found",
      costUsd: 0,
    });
    const r = toFixtureResult(failed);
    expect(r.costUsd).toBe(0);
    expect(r.notes).toContain("$0.0000");
    expect(r.notes).toContain("fixture not found");
  });
});

// -- selectFixturesForMode (smoke pin, #150 + #151 review) ----------------

describe("selectFixturesForMode", () => {
  // The bug cursor caught on the first smoke-pin attempt:
  // `listFixtures` returns `<id>.txt`-shaped names; the constants
  // are bare IDs. The .includes() membership check was comparing
  // bare-ID against `<id>.txt`-suffixed entries → always false →
  // the missing-fixture throw fired even when the fixture WAS
  // present. These tests pin the contract end-to-end so a future
  // refactor that drops the .txt-stripping path fails immediately.
  const SAMPLE_RESUMES = [
    "alex-fintech-backend-2026.txt",
    "nathan-2026.txt",
    "priya-ml-research-pm-2026.txt",
  ];
  const SAMPLE_JDS = [
    "anthropic-pm-claude-code-2026.txt",
    "google-compute-spm-2026.txt",
  ];

  it("smoke mode pins to nathan-2026 + google-compute-spm-2026 with .txt suffix", () => {
    const { selectedResumes, selectedJds } = selectFixturesForMode(
      "smoke",
      SAMPLE_RESUMES,
      SAMPLE_JDS,
      "/tmp/fixtures",
    );
    expect(selectedResumes).toEqual(["nathan-2026.txt"]);
    expect(selectedJds).toEqual(["google-compute-spm-2026.txt"]);
  });

  it("constants match the documented pinned IDs", () => {
    // Pins the convention that `SMOKE_RESUME` / `SMOKE_JD` are
    // BARE IDs (no `.txt`). The function appends `.txt` on the
    // way out; failing this assertion means the rest of the file
    // (and downstream `loadResumeText` / `loadJdText` calls that
    // strip `.txt`) needs to update in lock step.
    expect(SMOKE_RESUME).toBe("nathan-2026");
    expect(SMOKE_JD).toBe("google-compute-spm-2026");
  });

  it("smoke mode throws when SMOKE_RESUME is missing from the listing", () => {
    expect(() =>
      selectFixturesForMode(
        "smoke",
        ["foo-2026.txt", "bar-2026.txt"],
        SAMPLE_JDS,
        "/tmp/fixtures",
      ),
    ).toThrow(/SMOKE_RESUME/);
  });

  it("smoke mode throws when SMOKE_JD is missing from the listing", () => {
    expect(() =>
      selectFixturesForMode(
        "smoke",
        SAMPLE_RESUMES,
        ["some-other-jd-2026.txt"],
        "/tmp/fixtures",
      ),
    ).toThrow(/SMOKE_JD/);
  });

  it("smoke mode error message includes the fixtures directory + a constant-update hint", () => {
    try {
      selectFixturesForMode("smoke", [], SAMPLE_JDS, "/tmp/fixtures");
      throw new Error("expected throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(join("/tmp/fixtures", "resumes"));
      expect(message).toContain("Update SMOKE_RESUME");
    }
  });

  it("full mode returns all fixtures verbatim (no slicing or pinning)", () => {
    const { selectedResumes, selectedJds } = selectFixturesForMode(
      "full",
      SAMPLE_RESUMES,
      SAMPLE_JDS,
      "/tmp/fixtures",
    );
    expect(selectedResumes).toEqual(SAMPLE_RESUMES);
    expect(selectedJds).toEqual(SAMPLE_JDS);
  });

  it("full mode returns DEFENSIVE COPIES — caller can't mutate the listing", () => {
    const resumes = [...SAMPLE_RESUMES];
    const jds = [...SAMPLE_JDS];
    const result = selectFixturesForMode("full", resumes, jds, "/tmp/fixtures");
    result.selectedResumes.push("malicious.txt");
    result.selectedJds.push("malicious.txt");
    expect(resumes).toEqual(SAMPLE_RESUMES);
    expect(jds).toEqual(SAMPLE_JDS);
  });
});

// -- filterToLabeledPairs (Codex P1 on PR #151 post-merge) ----------------

describe("filterToLabeledPairs", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "matchline-eval-test-"));
    mkdirSync(join(tempDir, "expected-matches"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeLabel(resumeId: string, jdId: string): void {
    writeFileSync(
      join(tempDir, "expected-matches", `${resumeId}__${jdId}.json`),
      "{}",
    );
  }

  it("partitions pairs by expected-matches file existence", () => {
    writeLabel("nathan-2026", "google-compute-spm-2026");
    const pairs = [
      { resume: "nathan-2026.txt", jd: "google-compute-spm-2026.txt" },
      { resume: "alex-fintech-backend-2026.txt", jd: "google-compute-spm-2026.txt" },
      { resume: "nathan-2026.txt", jd: "anthropic-pm-claude-code-2026.txt" },
    ];
    const { labeled, skipped } = filterToLabeledPairs(pairs, tempDir);
    expect(labeled).toEqual([
      { resume: "nathan-2026.txt", jd: "google-compute-spm-2026.txt" },
    ]);
    expect(skipped.length).toBe(2);
  });

  it("returns ALL pairs as skipped when no labels exist", () => {
    const pairs = [
      { resume: "alex-2026.txt", jd: "dolby-tpm-ott-2026.txt" },
      { resume: "priya-2026.txt", jd: "discord-spm-nitro-2026.txt" },
    ];
    const { labeled, skipped } = filterToLabeledPairs(pairs, tempDir);
    expect(labeled).toEqual([]);
    expect(skipped).toEqual(pairs);
  });

  it("returns ALL pairs as labeled when every cell has a label file", () => {
    writeLabel("a-2026", "x-2026");
    writeLabel("b-2026", "y-2026");
    const pairs = [
      { resume: "a-2026.txt", jd: "x-2026.txt" },
      { resume: "b-2026.txt", jd: "y-2026.txt" },
    ];
    const { labeled, skipped } = filterToLabeledPairs(pairs, tempDir);
    expect(labeled).toEqual(pairs);
    expect(skipped).toEqual([]);
  });

  it("strips .txt from resume and jd before constructing the label path", () => {
    // The pair entries carry filenames (`<id>.txt`), but
    // expected-matches files are named `<resume_id>__<jd_id>.json`
    // (without the .txt). Mirror of the bare-ID/.txt-suffix
    // contract from `selectFixturesForMode`.
    writeLabel("foo", "bar");
    const pairs = [{ resume: "foo.txt", jd: "bar.txt" }];
    const { labeled, skipped } = filterToLabeledPairs(pairs, tempDir);
    expect(labeled).toEqual(pairs);
    expect(skipped).toEqual([]);
  });

  it("preserves input pair order in both labeled and skipped arrays", () => {
    // Determinism: a future caller that relies on report
    // ordering (e.g. operator scanning the per-fixture list)
    // must see pairs in the same order they were provided.
    writeLabel("a-2026", "x-2026");
    writeLabel("c-2026", "z-2026");
    const pairs = [
      { resume: "a-2026.txt", jd: "x-2026.txt" }, // labeled
      { resume: "b-2026.txt", jd: "y-2026.txt" }, // skipped
      { resume: "c-2026.txt", jd: "z-2026.txt" }, // labeled
      { resume: "d-2026.txt", jd: "w-2026.txt" }, // skipped
    ];
    const { labeled, skipped } = filterToLabeledPairs(pairs, tempDir);
    expect(labeled).toEqual([pairs[0], pairs[2]]);
    expect(skipped).toEqual([pairs[1], pairs[3]]);
  });

  it("returns empty arrays when no pairs are provided", () => {
    const { labeled, skipped } = filterToLabeledPairs([], tempDir);
    expect(labeled).toEqual([]);
    expect(skipped).toEqual([]);
  });
});

// -- parseSamples (multi-sample averaging, follow-up to #168) -----------

describe("parseSamples", () => {
  it("defaults to 1 when --samples is absent", () => {
    expect(parseSamples([])).toBe(1);
    expect(parseSamples(["--full"])).toBe(1);
    expect(parseSamples(["--smoke", "--other"])).toBe(1);
  });

  it("parses --samples N (space-separated form)", () => {
    expect(parseSamples(["--samples", "3"])).toBe(3);
    expect(parseSamples(["--full", "--samples", "5"])).toBe(5);
    expect(parseSamples(["--samples", "10", "--smoke"])).toBe(10);
  });

  it("parses --samples=N (equals-separated form)", () => {
    expect(parseSamples(["--samples=3"])).toBe(3);
    expect(parseSamples(["--full", "--samples=5"])).toBe(5);
  });

  it("rejects fractional values", () => {
    expect(() => parseSamples(["--samples", "1.5"])).toThrow(
      /positive integer/,
    );
    expect(() => parseSamples(["--samples=2.5"])).toThrow(/positive integer/);
  });

  it("rejects zero and negative values", () => {
    // The regex `/^\d+$/` rejects negative numbers (the minus sign
    // doesn't match), so this surfaces as the integer-format error;
    // zero parses as integer but trips the >=1 floor.
    expect(() => parseSamples(["--samples", "0"])).toThrow(/>= 1/);
    expect(() => parseSamples(["--samples", "-3"])).toThrow(
      /positive integer/,
    );
  });

  it("rejects non-numeric values", () => {
    expect(() => parseSamples(["--samples", "abc"])).toThrow(
      /positive integer/,
    );
    expect(() => parseSamples(["--samples=NaN"])).toThrow(/positive integer/);
  });

  it("rejects --samples without a value", () => {
    expect(() => parseSamples(["--samples"])).toThrow(/requires/);
    expect(() => parseSamples(["--full", "--samples"])).toThrow(/requires/);
  });

  it("rejects --samples when the next token is another flag (no value swallowing)", () => {
    // CodeRabbit Nit on PR #172: pin that `--samples` followed by
    // another flag token (`--full`, `--smoke`, ...) raises
    // "requires" rather than silently consuming the flag as a value.
    // Without this pin, a regression that accepted `--full` as the
    // sample count would surface only at parseInt time, far from
    // the actual misuse.
    expect(() => parseSamples(["--samples", "--full"])).toThrow(/requires/);
    expect(() => parseSamples(["--samples", "--smoke"])).toThrow(/requires/);
    expect(() => parseSamples(["--full", "--samples", "--smoke"])).toThrow(
      /requires/,
    );
  });
});

// -- aggregateSampledFixture (multi-sample averaging) -------------------

describe("aggregateSampledFixture — modeled cost (#389)", () => {
  // Codex P1. This function — NOT `toFixtureResult` — is what the
  // real CLI path uses for every executed fixture, and it dropped
  // `modeledCostUsd` entirely. `totalModeledCostUsd` was therefore
  // always empty on real runs, silently defeating the
  // cache-independent cost comparison. The earlier tests missed it
  // because they only exercised the single-result converter.
  it("sums modeledCostUsd across samples", () => {
    const out = aggregateSampledFixture([
      makeOrchestratorResult({ costUsd: 0, modeledCostUsd: 0.4 }),
      makeOrchestratorResult({ costUsd: 0, modeledCostUsd: 0.6 }),
    ]);
    expect(out.modeledCostUsd).toBeCloseTo(1.0, 10);
  });

  it("keeps modeled cost even when real spend collapses to zero on a warm run", () => {
    const out = aggregateSampledFixture([
      makeOrchestratorResult({ costUsd: 0, modeledCostUsd: 0.41, cacheHits: 4, cacheMisses: 0 }),
    ]);
    expect(out.costUsd).toBe(0);
    expect(out.modeledCostUsd).toBeCloseTo(0.41, 10);
    expect(out.notes).toContain("4 cached stage(s)");
  });

  it("omits the cache note when nothing was cached", () => {
    const out = aggregateSampledFixture([
      makeOrchestratorResult({ cacheHits: 0, cacheMisses: 4 }),
    ]);
    expect(out.notes).not.toContain("cached stage(s)");
  });

  it("counts partial modeled cost from a failed sample", () => {
    const out = aggregateSampledFixture([
      makeOrchestratorResult({ modeledCostUsd: 0.5 }),
      makeOrchestratorResult({ ok: false, error: "boom", modeledCostUsd: 0.2 }),
    ]);
    expect(out.modeledCostUsd).toBeCloseTo(0.7, 10);
  });
});

describe("aggregateSampledFixture", () => {
  it("single-sample mode produces the same notes shape as toFixtureResult (backward compat)", () => {
    const r = makeOrchestratorResult({
      extractionAccuracy: 0.5,
      matchAccuracy: 0.2,
    });
    const agg = aggregateSampledFixture([r]);
    const single = toFixtureResult(r);
    // Same accuracy + cost + latency.
    expect(agg.extractionAccuracy).toBe(single.extractionAccuracy);
    expect(agg.matchAccuracy).toBe(single.matchAccuracy);
    expect(agg.costUsd).toBe(single.costUsd);
    // Same notes shape (the single-sample branch matches
    // `toFixtureResult`'s exact format).
    expect(agg.notes).toBe(single.notes);
  });

  it("aggregates 3 samples into mean accuracy + sum cost + range notes", () => {
    const samples = [
      makeOrchestratorResult({ extractionAccuracy: 0.4, matchAccuracy: 0.1, costUsd: 0.1 }),
      makeOrchestratorResult({ extractionAccuracy: 0.5, matchAccuracy: 0.2, costUsd: 0.15 }),
      makeOrchestratorResult({ extractionAccuracy: 0.6, matchAccuracy: 0.3, costUsd: 0.12 }),
    ];
    const r = aggregateSampledFixture(samples);
    expect(r.extractionAccuracy).toBeCloseTo(0.5, 6); // mean
    expect(r.matchAccuracy).toBeCloseTo(0.2, 6); // mean
    expect(r.costUsd).toBeCloseTo(0.37, 6); // sum
    expect(r.notes).toContain("3 samples");
    expect(r.notes).toContain("extraction range 40.0–60.0%");
    expect(r.notes).toContain("match range 10.0–30.0%");
  });

  it("failed samples contribute 0 to accuracy means + their partial cost to total", () => {
    const samples = [
      makeOrchestratorResult({ extractionAccuracy: 0.5, matchAccuracy: 0.2, costUsd: 0.1 }),
      makeOrchestratorResult({
        ok: false,
        error: "Extraction failed",
        extractionAccuracy: 0,
        matchAccuracy: 0,
        costUsd: 0.05, // partial cost from earlier API calls
      }),
    ];
    const r = aggregateSampledFixture(samples);
    // Mean of [0.5, 0] = 0.25
    expect(r.extractionAccuracy).toBeCloseTo(0.25, 6);
    // Mean of [0.2, 0] = 0.10
    expect(r.matchAccuracy).toBeCloseTo(0.1, 6);
    // Sum: 0.10 + 0.05 = 0.15
    expect(r.costUsd).toBeCloseTo(0.15, 6);
    // Failure tally surfaced.
    expect(r.notes).toContain("1/2 failed");
  });

  it("multi-sample notes use the first SUCCESSFUL run as exemplar for unit/req counts", () => {
    // First sample failed — exemplar should fall through to the
    // first successful one so the per-run counts in the report
    // aren't 0.
    const samples = [
      makeOrchestratorResult({
        ok: false,
        error: "transport error",
        extractedUnitCount: 0,
        parsedRequirementCount: 0,
        matchCount: 0,
      }),
      makeOrchestratorResult({
        extractedUnitCount: 22,
        parsedRequirementCount: 15,
        matchCount: 330,
      }),
    ];
    const r = aggregateSampledFixture(samples);
    expect(r.notes).toContain("22 units / 15 reqs / 330 matches");
  });

  it("throws on empty samples array", () => {
    expect(() => aggregateSampledFixture([])).toThrow(/empty/);
  });

  it("throws on heterogeneous samples (cursor invariant on #172)", () => {
    // Pre-fix the aggregator silently averaged samples from
    // different fixture pairs and labeled the result with the
    // FIRST sample's IDs — a false-positive accuracy reading
    // attributed to the wrong pair. Throw loudly so a caller
    // bug surfaces at the boundary, not in a downstream report.
    const a = makeOrchestratorResult({
      resumeFixtureId: "alice",
      jdFixtureId: "role-x",
      extractionAccuracy: 0.8,
    });
    const b = makeOrchestratorResult({
      resumeFixtureId: "alice",
      jdFixtureId: "role-y", // different JD
      extractionAccuracy: 0.2,
    });
    expect(() => aggregateSampledFixture([a, b])).toThrow(
      /heterogeneous samples/,
    );
  });

  it("heterogeneous-samples error includes both fixture IDs for diagnosis", () => {
    const a = makeOrchestratorResult({
      resumeFixtureId: "alice",
      jdFixtureId: "google",
    });
    const b = makeOrchestratorResult({
      resumeFixtureId: "bob", // different resume
      jdFixtureId: "google",
    });
    try {
      aggregateSampledFixture([a, b]);
      throw new Error("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("alice");
      expect(msg).toContain("bob");
      expect(msg).toContain("index 1");
    }
  });

  it("accepts homogeneous samples even with content variance (extractedUnits, accuracy, etc.)", () => {
    // The invariant check should ONLY guard fixture-ID equality.
    // Per-sample variance in unit counts / accuracy / cost is
    // expected (LLM stochasticity) and must NOT trip the throw.
    const samples = [
      makeOrchestratorResult({ extractedUnitCount: 22, extractionAccuracy: 0.4 }),
      makeOrchestratorResult({ extractedUnitCount: 24, extractionAccuracy: 0.6 }),
      makeOrchestratorResult({ extractedUnitCount: 23, extractionAccuracy: 0.5 }),
    ];
    expect(() => aggregateSampledFixture(samples)).not.toThrow();
  });

  it("computes mean latency across samples (rounded to integer ms)", () => {
    const samples = [
      makeOrchestratorResult({ latencyMs: 1000 }),
      makeOrchestratorResult({ latencyMs: 2000 }),
      makeOrchestratorResult({ latencyMs: 1500 }),
    ];
    const r = aggregateSampledFixture(samples);
    expect(r.latencyMs).toBe(1500); // Math.round((1000+2000+1500)/3)
  });
});

// -- estimatePlannedSpend (cursor on PR #172: smoke-mode samples-aware) --

describe("estimatePlannedSpend", () => {
  // Pin: per-flow $ estimate is mode-INDEPENDENT post-#172.
  // Pre-#172 smoke returned $0 regardless of flowCount, which
  // bypassed the cap guard for `--samples N` smoke runs.
  const PER_FLOW = 0.75;

  it("smoke and full both project the same per-flow cost (#172 cursor)", () => {
    const smoke = estimatePlannedSpend("smoke", 10);
    const full = estimatePlannedSpend("full", 10);
    expect(smoke).toEqual(full);
  });

  it("scales linearly with flowCount", () => {
    const small = estimatePlannedSpend("smoke", 1);
    const large = estimatePlannedSpend("smoke", 100);
    expect(large.anthropicUsd / small.anthropicUsd).toBeCloseTo(100, 6);
    expect(large.openaiUsd / small.openaiUsd).toBeCloseTo(100, 6);
  });

  it("splits cost 70/30 between Anthropic and OpenAI", () => {
    const r = estimatePlannedSpend("smoke", 10);
    expect(r.anthropicUsd).toBeCloseTo(10 * PER_FLOW * 0.7, 6); // 5.25
    expect(r.openaiUsd).toBeCloseTo(10 * PER_FLOW * 0.3, 6); // 2.25
    expect(r.firebaseUsd).toBe(0);
  });

  it("zero flows → zero projection (no-op corpus)", () => {
    expect(estimatePlannedSpend("full", 0)).toEqual({
      anthropicUsd: 0,
      openaiUsd: 0,
      firebaseUsd: 0,
    });
  });

  it("--samples 50 smoke would have projected $0 pre-#172; now projects $37.50 (cursor regression pin)", () => {
    // The exact regression cursor caught: 1 fixture × 50 samples
    // = 50 flows. Pre-fix: smoke returned $0, bypassing the cap
    // guard. Post-fix: projects 50 × $0.75 = $37.50 split 70/30,
    // which trips the $25 monthly Anthropic cap.
    const flowCount = 1 * 50;
    const r = estimatePlannedSpend("smoke", flowCount);
    expect(r.anthropicUsd).toBeCloseTo(50 * PER_FLOW * 0.7, 6); // $26.25
    expect(r.openaiUsd).toBeCloseTo(50 * PER_FLOW * 0.3, 6); // $11.25
    // Total $37.50; Anthropic alone ($26.25) > $25 monthly cap →
    // shouldBlock(checkCaps(...)) trips → harness refuses to run.
    expect(r.anthropicUsd).toBeGreaterThan(25);
  });
});


// -- parsePromptOverrides (#177 PR 1) ---------------------------------------

describe("parsePromptOverrides", () => {
  it("returns empty object when --prompt is absent", () => {
    expect(parsePromptOverrides([])).toEqual({});
    expect(parsePromptOverrides(["--samples", "3"])).toEqual({});
  });

  it("parses a single STAGE/NAME=VERSION via space-separated form", () => {
    expect(parsePromptOverrides(["--prompt", "extraction/resume=v2"])).toEqual({
      "extraction/resume": "v2",
    });
  });

  it("parses the --prompt=KEY=VALUE form", () => {
    expect(parsePromptOverrides(["--prompt=parsing/jd=v3"])).toEqual({
      "parsing/jd": "v3",
    });
  });

  it("accumulates multiple overrides into a single record", () => {
    expect(
      parsePromptOverrides([
        "--prompt",
        "extraction/resume=v2",
        "--samples",
        "3",
        "--prompt=parsing/jd=v3",
      ]),
    ).toEqual({
      "extraction/resume": "v2",
      "parsing/jd": "v3",
    });
  });

  it("throws when --prompt is the last token (no value follows)", () => {
    expect(() => parsePromptOverrides(["--prompt"])).toThrow(/--prompt requires/);
  });

  it("throws when the argument has no =", () => {
    expect(() => parsePromptOverrides(["--prompt", "extraction/resume"])).toThrow(
      /STAGE\/NAME=VERSION/,
    );
  });

  it("throws when STAGE or NAME is empty", () => {
    expect(() => parsePromptOverrides(["--prompt", "/resume=v2"])).toThrow(
      /STAGE\/NAME with exactly one slash/,
    );
    expect(() => parsePromptOverrides(["--prompt", "extraction/=v2"])).toThrow(
      /STAGE\/NAME with exactly one slash/,
    );
  });

  it("throws when VERSION is empty", () => {
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction/resume="]),
    ).toThrow(/STAGE\/NAME=VERSION with non-empty parts/);
  });

  // -- Codex P1 on PR #178: stricter key + version validation -----

  it("rejects keys with more than one slash (silent-A/B-invalidation guard)", () => {
    // `extraction/resume/typo=v2` looks plausible but never
    // matches a (stage, name) entry in PROMPT_CONFIG, so the
    // override would have no effect. Failing loudly here means
    // a typo doesn't silently produce a default-version run with
    // the wrong report header.
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction/resume/typo=v2"]),
    ).toThrow(/exactly one slash/);
    expect(() =>
      parsePromptOverrides(["--prompt", "a/b/c/d=v1"]),
    ).toThrow(/exactly one slash/);
  });

  it("rejects keys with non-alphanumeric characters in either segment", () => {
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction.x/resume=v2"]),
    ).toThrow(/exactly one slash and non-empty alphanumeric segments/);
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction/resume.v2=v2"]),
    ).toThrow(/exactly one slash and non-empty alphanumeric segments/);
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction /resume=v2"]),
    ).toThrow(/exactly one slash/);
  });

  it("rejects versions containing a slash (path-traversal guard)", () => {
    // version flows into `loadPromptText`'s
    // `join(promptsRoot, stage, "${name}.${version}.md")`. A
    // version with `/` would resolve outside the prompts tree.
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction/resume=v1/extra"]),
    ).toThrow(/VERSION must be alphanumeric/);
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction/resume=../../outside"]),
    ).toThrow(/VERSION must be alphanumeric/);
  });

  it("rejects versions containing '..' (path-traversal guard)", () => {
    // Even without a slash, `..` could enable traversal if a
    // future version syntax were introduced that allowed dots.
    // The current regex blocks dots entirely; this test pins
    // that intent so a future widening to allow dots can't
    // silently re-introduce the traversal hole.
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction/resume=.."]),
    ).toThrow(/VERSION must be alphanumeric/);
    expect(() =>
      parsePromptOverrides(["--prompt", "extraction/resume=v1..2"]),
    ).toThrow(/VERSION must be alphanumeric/);
  });

  it("accepts hyphenated and underscored versions (forward-compat)", () => {
    // v2-rc1, v3_alpha, etc. — common shapes for pre-release
    // prompt iterations. These must still pass the validator.
    expect(parsePromptOverrides(["--prompt", "extraction/resume=v2-rc1"])).toEqual({
      "extraction/resume": "v2-rc1",
    });
    expect(parsePromptOverrides(["--prompt", "parsing/jd=v3_alpha"])).toEqual({
      "parsing/jd": "v3_alpha",
    });
  });

  it("throws when the same stage/name is overridden twice", () => {
    // Catches the silent-last-write-wins shape that would let a
    // typo in the second invocation mask the intended first one.
    expect(() =>
      parsePromptOverrides([
        "--prompt",
        "extraction/resume=v2",
        "--prompt",
        "extraction/resume=v3",
      ]),
    ).toThrow(/specified twice/);
  });
});

// -- resolvePromptVersionsForReport (#177 PR 1) -----------------------------

describe("resolvePromptVersionsForReport", () => {
  it("returns one entry per (stage, name) in PROMPT_CONFIG with stable ordering", () => {
    const fakeConfig = {
      extraction: { resume: "v1" },
      parsing: { jd: "v1" },
    } as never;
    const r = resolvePromptVersionsForReport(fakeConfig, {});
    expect(r).toEqual([
      { key: "extraction/resume", version: "v1", source: "default" },
      { key: "parsing/jd", version: "v1", source: "default" },
    ]);
  });

  it("marks an entry as override when an override is present", () => {
    const fakeConfig = {
      extraction: { resume: "v1" },
      parsing: { jd: "v1" },
    } as never;
    const r = resolvePromptVersionsForReport(fakeConfig, {
      "extraction/resume": "v2",
    });
    expect(r).toEqual([
      { key: "extraction/resume", version: "v2", source: "override" },
      { key: "parsing/jd", version: "v1", source: "default" },
    ]);
  });

  it("ignores override keys that don't match any (stage, name) — silent by design", () => {
    // A typo'd override (e.g. extraction/resumee=v2) should simply
    // not match any config entry. This is the right call because
    // parsePromptOverrides already validates STAGE/NAME shape; the
    // matchability check is a separate concern that the eval
    // harness loudly reports via the report header (no `(override)`
    // tag means the override didn't apply).
    const fakeConfig = { extraction: { resume: "v1" } } as never;
    const r = resolvePromptVersionsForReport(fakeConfig, {
      "extraction/resumee": "v2",
    });
    expect(r).toEqual([
      { key: "extraction/resume", version: "v1", source: "default" },
    ]);
  });
});
