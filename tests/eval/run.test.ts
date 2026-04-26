import { describe, expect, it } from "vitest";

import { computeFlowCount, toFixtureResult } from "./run.js";
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
