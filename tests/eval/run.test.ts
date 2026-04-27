import { describe, expect, it } from "vitest";

import {
  SMOKE_JD,
  SMOKE_RESUME,
  computeFlowCount,
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
