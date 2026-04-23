import { describe, expect, it } from "vitest";

import { computeFlowCount } from "./run.js";

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
