import { describe, expect, it } from "vitest";

import {
  checkCaps,
  DEFAULT_CAPS,
  HARD_THRESHOLD_FRACTION,
  shouldBlock,
  WARN_THRESHOLD_FRACTION,
} from "./projection.js";

const zero = { anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 };

describe("checkCaps", () => {
  it("returns a check per provider, in fixed order", () => {
    const checks = checkCaps(zero, zero);
    expect(checks.map((c) => c.provider)).toEqual([
      "anthropic",
      "openai",
      "firebase",
    ]);
  });

  it("sums current + planned into projected", () => {
    const [anthropic] = checkCaps(
      { anthropicUsd: 10, openaiUsd: 0, firebaseUsd: 0 },
      { anthropicUsd: 5, openaiUsd: 0, firebaseUsd: 0 },
    );
    expect(anthropic!.projectedUsd).toBe(15);
  });

  it("flags exceedsWarn at > 80% of cap (not at 80% exactly)", () => {
    const warnLimit = DEFAULT_CAPS.anthropicUsd * WARN_THRESHOLD_FRACTION;
    const atLimit = checkCaps(zero, {
      anthropicUsd: warnLimit,
      openaiUsd: 0,
      firebaseUsd: 0,
    });
    expect(atLimit[0]!.exceedsWarn).toBe(false);
    const overLimit = checkCaps(zero, {
      anthropicUsd: warnLimit + 0.01,
      openaiUsd: 0,
      firebaseUsd: 0,
    });
    expect(overLimit[0]!.exceedsWarn).toBe(true);
  });

  it("flags exceedsCap at > 95% of cap", () => {
    const hardLimit = DEFAULT_CAPS.openaiUsd * HARD_THRESHOLD_FRACTION;
    const atLimit = checkCaps(zero, {
      anthropicUsd: 0,
      openaiUsd: hardLimit,
      firebaseUsd: 0,
    });
    expect(atLimit[1]!.exceedsCap).toBe(false);
    const overLimit = checkCaps(zero, {
      anthropicUsd: 0,
      openaiUsd: hardLimit + 0.01,
      firebaseUsd: 0,
    });
    expect(overLimit[1]!.exceedsCap).toBe(true);
  });

  it("accepts caller-supplied caps to override defaults", () => {
    const [anthropic] = checkCaps(
      zero,
      { anthropicUsd: 10, openaiUsd: 0, firebaseUsd: 0 },
      { anthropicUsd: 100, openaiUsd: 100, firebaseUsd: 100 },
    );
    expect(anthropic!.cap).toBe(100);
    expect(anthropic!.exceedsCap).toBe(false);
  });

  it("DEFAULT_CAPS matches documented ceilings ($25 / $25 / $25)", () => {
    expect(DEFAULT_CAPS).toEqual({
      anthropicUsd: 25,
      openaiUsd: 25,
      firebaseUsd: 25,
    });
  });

  it("rejects NaN inputs instead of silently passing the guard", () => {
    // `NaN > threshold` is always false — without validation a NaN usage
    // value would make exceedsCap false and wave a budget-blowing run through.
    expect(() =>
      checkCaps({ anthropicUsd: NaN, openaiUsd: 0, firebaseUsd: 0 }, zero),
    ).toThrow(/finite, non-negative/);
  });

  it("rejects Infinity inputs", () => {
    expect(() =>
      checkCaps(zero, { anthropicUsd: Infinity, openaiUsd: 0, firebaseUsd: 0 }),
    ).toThrow(/finite, non-negative/);
  });

  it("rejects negative inputs", () => {
    expect(() =>
      checkCaps(zero, zero, { anthropicUsd: -1, openaiUsd: 25, firebaseUsd: 25 }),
    ).toThrow(/finite, non-negative/);
  });
});

describe("shouldBlock", () => {
  it("returns false when no check exceeds the hard cap", () => {
    expect(shouldBlock(checkCaps(zero, zero))).toBe(false);
  });

  it("returns true when any check exceeds the hard cap", () => {
    const checks = checkCaps(zero, {
      anthropicUsd: DEFAULT_CAPS.anthropicUsd, // full cap triggers 100% > 95%
      openaiUsd: 0,
      firebaseUsd: 0,
    });
    expect(shouldBlock(checks)).toBe(true);
  });
});
