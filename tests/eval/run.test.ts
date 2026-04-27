import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SMOKE_JD,
  SMOKE_RESUME,
  aggregateSampledFixture,
  computeFlowCount,
  filterToLabeledPairs,
  parseSamples,
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
    extractedUnitCount: 10,
    parsedRequirementCount: 8,
    matchCount: 25,
    ok: true,
    error: null,
    ...overrides,
  };
}

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
      expect(message).toContain("/tmp/fixtures/resumes");
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
});

// -- aggregateSampledFixture (multi-sample averaging) -------------------

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
