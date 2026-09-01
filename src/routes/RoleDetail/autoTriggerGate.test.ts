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
  hasEvidenceUnscoredMatches: false,
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

describe("shouldAutoTriggerMatching — legacy structural_evidence backfill", () => {
  // Codex P2 round 2 on PR #435. Matches persisted before
  // `structural_evidence` existed can't be evaluated by
  // computeGaps's honesty gate, and the `matchCount > 0`
  // short-circuit meant nothing would ever recompute them: the
  // user has no reason to suspect a rerun is needed. Matching
  // costs no LLM call once embeddings exist, so the fix is to
  // fire once on the next Role view.
  it("fires despite existing matches when any of them predates the field", () => {
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchCount: 12,
        hasEvidenceUnscoredMatches: true,
      }),
    ).toBe(true);
  });

  it("does NOT fire when every existing match already carries the field", () => {
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchCount: 12,
        hasEvidenceUnscoredMatches: false,
      }),
    ).toBe(false);
  });

  it("the backfill path still respects the idempotency guard", () => {
    // Bounds the rerun to one per mount. Without this, a backfill
    // that somehow didn't populate the field would re-fire on
    // every snapshot — an unbounded loop of matching calls.
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchCount: 12,
        hasEvidenceUnscoredMatches: true,
        alreadyTriggered: true,
      }),
    ).toBe(false);
  });

  it("the backfill path still respects the earlier gates", () => {
    // Legacy matches don't license firing before the Role is
    // ready, before the first matches snapshot lands, or against
    // a Role with no Requirements to score.
    const legacy = { ...HAPPY, matchCount: 12, hasEvidenceUnscoredMatches: true };
    expect(shouldAutoTriggerMatching({ ...legacy, status: "loading" })).toBe(false);
    expect(
      shouldAutoTriggerMatching({ ...legacy, matchesFirstSnapshotReceived: false }),
    ).toBe(false);
    expect(shouldAutoTriggerMatching({ ...legacy, requirementCount: 0 })).toBe(false);
  });
});

describe("shouldAutoTriggerMatching — deferred while Units await re-embedding", () => {
  // Codex P1 on #435, the only data-loss finding in the review.
  //
  // `defaultListUnits` excludes `reembed_pending` Units, but the
  // pipeline's persist step is a wholesale replace: it deletes
  // every match for the Role and writes only what this run
  // produced. Backfilling in that window deletes the pending
  // Unit's matches with no replacements, and the carry-forward
  // that preserves `approved_for_use` / `user_rejected` has
  // nothing to carry them onto. Re-embedding later cannot
  // restore the user's decisions.
  //
  // The container expresses the deferral by passing
  // `hasEvidenceUnscoredMatches: false`, so the gate itself
  // stays a pure function of its inputs.
  it("does not fire for a legacy set while the deferral is in effect", () => {
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchCount: 12,
        hasEvidenceUnscoredMatches: false,
      }),
    ).toBe(false);
  });

  it("fires once the deferral lifts", () => {
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchCount: 12,
        hasEvidenceUnscoredMatches: true,
      }),
    ).toBe(true);
  });
});

describe("shouldAutoTriggerMatching — deferral must not become permanent", () => {
  // Codex P2 on #438. The container defers the backfill while an
  // approved Unit awaits re-embedding (or while the Units
  // snapshot hasn't landed) by passing
  // `hasEvidenceUnscoredMatches: false`. If it ALSO latched the
  // idempotency ref during that window, re-embedding would
  // complete, the Units subscription would re-render, and the
  // gate would still see `alreadyTriggered: true` — so the
  // backfill the deferral promised would never happen on this
  // mount, and the legacy rows would keep their permissive
  // `undefined` forever.
  it("fires once the deferral lifts, given the ref was left open", () => {
    const deferred = {
      ...HAPPY,
      matchCount: 12,
      hasEvidenceUnscoredMatches: false,
      alreadyTriggered: false,
    };
    expect(shouldAutoTriggerMatching(deferred)).toBe(false);
    // Deferral lifts (Units arrived, nothing pending) and the ref
    // was NOT latched meanwhile.
    expect(
      shouldAutoTriggerMatching({
        ...deferred,
        hasEvidenceUnscoredMatches: true,
      }),
    ).toBe(true);
  });

  it("stays closed if the ref was latched during the deferral", () => {
    // The regression this pins: a latch during deferral is
    // indistinguishable from a completed run, and there is no
    // second chance within the mount.
    expect(
      shouldAutoTriggerMatching({
        ...HAPPY,
        matchCount: 12,
        hasEvidenceUnscoredMatches: true,
        alreadyTriggered: true,
      }),
    ).toBe(false);
  });
});
