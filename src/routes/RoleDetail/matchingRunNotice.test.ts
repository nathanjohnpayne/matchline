import { describe, expect, it } from "vitest";

import type { MatchingRunMarker } from "../../../functions/src/matching/runMarker.ts";
import { CALLABLE_TIMEOUT_SECONDS } from "../../../functions/src/callables/timeouts.ts";

import { MATCHING_RUN_LIVE_MS, msUntilMatchingRunPresumedDead } from "./matchingRunNotice.ts";

const START = "2026-10-01T12:00:00.000Z";
const START_MS = Date.parse(START);

function marker(partial: Partial<MatchingRunMarker>): MatchingRunMarker {
  return { owner_uid: "u", role_id: "r", run_id: "run", started_at: START, ...partial };
}

describe("MATCHING_RUN_LIVE_MS", () => {
  it("outlasts the runMatching callable's timeout", () => {
    expect(MATCHING_RUN_LIVE_MS).toBeGreaterThan(CALLABLE_TIMEOUT_SECONDS.runMatching * 1000);
  });
});

describe("msUntilMatchingRunPresumedDead", () => {
  it("counts down to the deadline of a running, partial run", () => {
    const m = marker({ state: "running", partial: true });
    expect(msUntilMatchingRunPresumedDead(m, START_MS + 1_000, 10_000)).toBe(9_000);
  });

  it("needs no timer once the deadline has passed", () => {
    const m = marker({ state: "running", partial: true });
    expect(msUntilMatchingRunPresumedDead(m, START_MS + 10_000, 10_000)).toBeNull();
  });

  it("needs no timer when time cannot change the answer", () => {
    expect(msUntilMatchingRunPresumedDead(null, START_MS)).toBeNull();
    expect(msUntilMatchingRunPresumedDead(marker({ state: "running" }), START_MS)).toBeNull();
    expect(msUntilMatchingRunPresumedDead(marker({ state: "failed", partial: true }), START_MS)).toBeNull();
    expect(msUntilMatchingRunPresumedDead(marker({ state: "complete", partial: true }), START_MS)).toBeNull();
    expect(
      msUntilMatchingRunPresumedDead(marker({ state: "running", partial: true, started_at: "x" }), START_MS),
    ).toBeNull();
  });
});
