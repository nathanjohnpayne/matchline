/**
 * Pure-helper tests for `shouldAutoTriggerMatching` (cursor
 * #134 r1).
 *
 * The race the gate now closes:
 *   1. User navigates to a Role.
 *   2. Container subscribes to Requirements + Matches.
 *   3. Requirements snapshot arrives FIRST → status flips
 *      to "ready", `requirements` populated.
 *   4. Auto-trigger effect re-evaluates: `matches.length
 *      === 0` because the matches subscription hasn't
 *      delivered yet.
 *   5. WITHOUT the new `matchesFirstSnapshotReceived`
 *      gate: trigger fires against a Role that DOES have
 *      persisted matches.
 *
 * Pinned invariants:
 *   - Status must be "ready".
 *   - matchesFirstSnapshotReceived must be true (the new
 *     bit; cursor's catch).
 *   - alreadyTriggered must be false.
 *   - requirementCount must be > 0 (else nothing to match).
 *   - matchCount must be 0 (else don't need to rerun).
 */

import { describe, expect, it } from "vitest";

import {
  shouldAutoTriggerMatching,
  type AutoTriggerGateInputs,
} from "./autoTriggerGate.ts";

const HAPPY: AutoTriggerGateInputs = {
  status: "ready",
  matchesFirstSnapshotReceived: true,
  matchCount: 0,
  requirementCount: 3,
  alreadyTriggered: false,
};

describe("shouldAutoTriggerMatching", () => {
  it("HAPPY PATH: ready + first snapshot received + 0 matches + N requirements + not yet triggered → fires", () => {
    expect(shouldAutoTriggerMatching(HAPPY)).toBe(true);
  });

  // -- Each gate independently --------------------------------------------

  it("does NOT fire when status is 'loading'", () => {
    expect(
      shouldAutoTriggerMatching({ ...HAPPY, status: "loading" }),
    ).toBe(false);
  });

  it("does NOT fire when status is 'error'", () => {
    expect(
      shouldAutoTriggerMatching({ ...HAPPY, status: "error" }),
    ).toBe(false);
  });

  it("LOAD-BEARING (cursor #134 r1): does NOT fire when matchesFirstSnapshotReceived is false — even if status='ready' and matchCount=0", () => {
    // The race the prior code missed. Requirements snapshot
    // arrived (status flipped to ready) but matches
    // subscription hasn't delivered yet; matchCount is the
    // initial 0 default, not a known-empty storage signal.
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchesFirstSnapshotReceived: false,
      }),
    ).toBe(false);
  });

  it("does NOT fire when alreadyTriggered is true (idempotency)", () => {
    expect(
      shouldAutoTriggerMatching({ ...HAPPY, alreadyTriggered: true }),
    ).toBe(false);
  });

  it("does NOT fire when requirementCount is 0 (nothing to match against)", () => {
    expect(
      shouldAutoTriggerMatching({ ...HAPPY, requirementCount: 0 }),
    ).toBe(false);
  });

  it("does NOT fire when matchCount > 0 (rerun would be a no-op)", () => {
    expect(
      shouldAutoTriggerMatching({ ...HAPPY, matchCount: 5 }),
    ).toBe(false);
  });

  // -- Composite cases ----------------------------------------------------

  it("composite: matchesFirstSnapshotReceived=false + matchCount > 0 — both block; this pins that the snapshot gate isn't bypassed by matchCount being non-zero", () => {
    // Defensive: the snapshot gate must hold even if
    // matchCount somehow becomes non-zero before the first
    // delivery (shouldn't happen with the current container,
    // but pin it).
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchesFirstSnapshotReceived: false,
        matchCount: 5,
      }),
    ).toBe(false);
  });

  it("composite: matchesFirstSnapshotReceived=true + non-empty matches — pins the 'don't trigger when matches already exist' path", () => {
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchCount: 3,
      }),
    ).toBe(false);
  });
});
