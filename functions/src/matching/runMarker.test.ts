import { describe, expect, it } from "vitest";

import { isMatchingRunIncomplete, type MatchingRunMarker } from "./runMarker.ts";

const START = "2026-10-01T12:00:00.000Z";
const START_MS = Date.parse(START);
const LIVE_MS = 150_000;

function marker(partial: Partial<MatchingRunMarker>): MatchingRunMarker {
  return {
    owner_uid: "u",
    role_id: "r",
    run_id: "run",
    started_at: START,
    ...partial,
  };
}

describe("isMatchingRunIncomplete", () => {
  it("is false for a Role never matched", () => {
    expect(isMatchingRunIncomplete(null, START_MS, LIVE_MS)).toBe(false);
    expect(isMatchingRunIncomplete(undefined, START_MS, LIVE_MS)).toBe(false);
  });

  it("is false whenever the store cannot be mixed (partial unset or false)", () => {
    for (const state of ["running", "complete", "failed", undefined] as const) {
      expect(isMatchingRunIncomplete(marker({ state }), START_MS + 10 * LIVE_MS, LIVE_MS)).toBe(false);
      expect(
        isMatchingRunIncomplete(marker({ state, partial: false }), START_MS + 10 * LIVE_MS, LIVE_MS),
      ).toBe(false);
    }
  });

  it("is false once a run completes, and for a pre-#504 marker with no state", () => {
    expect(isMatchingRunIncomplete(marker({ state: "complete", partial: true }), START_MS, LIVE_MS)).toBe(false);
    expect(isMatchingRunIncomplete(marker({ partial: true }), START_MS + 10 * LIVE_MS, LIVE_MS)).toBe(false);
  });

  it("is true for a failed run that left the Role partial, immediately", () => {
    expect(isMatchingRunIncomplete(marker({ state: "failed", partial: true }), START_MS, LIVE_MS)).toBe(true);
  });

  it("trusts a running partial run until its deadline, then reads it as dead", () => {
    const m = marker({ state: "running", partial: true });
    expect(isMatchingRunIncomplete(m, START_MS + LIVE_MS, LIVE_MS)).toBe(false);
    expect(isMatchingRunIncomplete(m, START_MS + LIVE_MS + 1, LIVE_MS)).toBe(true);
  });

  it("does not trust a running marker whose start cannot be parsed", () => {
    const m = marker({ state: "running", partial: true, started_at: "not a time" });
    expect(isMatchingRunIncomplete(m, START_MS, LIVE_MS)).toBe(true);
  });
});
