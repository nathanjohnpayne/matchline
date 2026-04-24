import { describe, expect, it } from "vitest";

import {
  assertNoStateMachineFields,
  buildManualUnit,
  EMBEDDING_INVALIDATING_FIELDS,
  flagsForApprovalState,
  SERVER_STAMPED_IMMUTABLE_FIELDS,
  shouldMarkReembed,
  STATE_MACHINE_OWNED_FIELDS,
  type ManualUnitInput,
} from "./experienceUnits-state.ts";

describe("flagsForApprovalState", () => {
  it("'approved' sets user_approved=true and clears rejected/flagged", () => {
    expect(flagsForApprovalState("approved")).toEqual({
      user_approved: true,
      rejected: false,
      flagged: false,
    });
  });

  it("'rejected' sets user_approved=false and rejected=true", () => {
    expect(flagsForApprovalState("rejected")).toEqual({
      user_approved: false,
      rejected: true,
      flagged: false,
    });
  });

  it("'flagged' sets flagged=true and forces user_approved=false", () => {
    // Flagged is exclusive-with-approved by the docstring's design
    // decision. If this changes (i.e. a Unit can be flagged AND
    // approved), this test should fail loudly so the caller knows
    // the contract widened.
    expect(flagsForApprovalState("flagged")).toEqual({
      user_approved: false,
      rejected: false,
      flagged: true,
    });
  });

  it("'pending' clears all three flags", () => {
    expect(flagsForApprovalState("pending")).toEqual({
      user_approved: false,
      rejected: false,
      flagged: false,
    });
  });

  it("returns all three flags explicitly even when false (no undefined)", () => {
    // The Firestore write semantics require explicit `false` to clear
    // a stale `true` from a prior state. A returned object that
    // omits a flag would silently leave the prior value in place.
    for (const state of ["approved", "rejected", "flagged", "pending"] as const) {
      const flags = flagsForApprovalState(state);
      expect(typeof flags.user_approved).toBe("boolean");
      expect(typeof flags.rejected).toBe("boolean");
      expect(typeof flags.flagged).toBe("boolean");
    }
  });

  it("rejected → approved transition fully clears `rejected` (regression)", () => {
    // Pin the specific state-transition that motivated the explicit
    // false-rather-than-undefined design. If a future refactor returns
    // `{ user_approved: true }` for "approved" without the false flags,
    // a Firestore write would leave a previously-rejected Unit in a
    // contradictory state (approved AND rejected).
    const fromRejected = flagsForApprovalState("rejected");
    const toApproved = flagsForApprovalState("approved");
    expect(fromRejected.rejected).toBe(true);
    expect(toApproved.rejected).toBe(false);
  });
});

describe("shouldMarkReembed", () => {
  it("returns true when partial includes raw_text", () => {
    expect(shouldMarkReembed({ raw_text: "new" })).toBe(true);
  });

  it("returns true when partial includes normalized_summary", () => {
    expect(shouldMarkReembed({ normalized_summary: "new" })).toBe(true);
  });

  it("returns true when partial includes both raw_text AND a non-trigger field", () => {
    expect(shouldMarkReembed({ raw_text: "new", skills: ["a"] })).toBe(true);
  });

  it("returns false when partial includes only non-trigger fields", () => {
    expect(
      shouldMarkReembed({
        skills: ["a"],
        tools: ["b"],
        domains: ["c"],
        confidence_score: 0.9,
      }),
    ).toBe(false);
  });

  it("returns false on empty partial", () => {
    expect(shouldMarkReembed({})).toBe(false);
  });

  it("does not match field-name substrings (regression: 'raw_text_legacy' must not trigger)", () => {
    // Set membership is exact; pin so a future switch to a regex
    // doesn't widen the trigger surface unintentionally.
    expect(shouldMarkReembed({ raw_text_legacy: "x" })).toBe(false);
    expect(shouldMarkReembed({ normalized_summary_old: "x" })).toBe(false);
  });
});

describe("buildManualUnit", () => {
  const MIN_INPUT: ManualUnitInput = {
    raw_text: "Shipped X, Y, Z.",
    normalized_summary: "Shipped X, Y, Z.",
    unit_type: "achievement",
  };
  const UID = "user-alice";
  const ID = "unit-stub-1";
  const NOW = "2026-04-24T12:00:00.000Z";

  it("stamps the four server-controlled fields (id, owner_uid, created_at, updated_at)", () => {
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect(unit.id).toBe(ID);
    expect(unit.owner_uid).toBe(UID);
    expect(unit.created_at).toBe(NOW);
    expect(unit.updated_at).toBe(NOW);
  });

  it("forces source_type to 'manual'", () => {
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect(unit.source_type).toBe("manual");
  });

  it("forces evidence_type to 'user_confirmed'", () => {
    // Manual entries are by definition user-confirmed — the user typed
    // them in. Pin so a future widening of EvidenceType doesn't
    // accidentally change the manual default to e.g. "inferred".
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect(unit.evidence_type).toBe("user_confirmed");
  });

  it("defaults source_ref to 'manual entry' when not provided", () => {
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect(unit.source_ref).toBe("manual entry");
  });

  it("respects an explicit source_ref override", () => {
    const unit = buildManualUnit(
      { ...MIN_INPUT, source_ref: "Q3 retro doc" },
      UID,
      ID,
      NOW,
    );
    expect(unit.source_ref).toBe("Q3 retro doc");
  });

  it("defaults confidence_score to 1.0 (user-trusted)", () => {
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect(unit.confidence_score).toBe(1.0);
  });

  it("defaults user_approved to true (manual = pre-approved)", () => {
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect(unit.user_approved).toBe(true);
  });

  it("respects an explicit user_approved=false (drafting a manual Unit)", () => {
    const unit = buildManualUnit(
      { ...MIN_INPUT, user_approved: false },
      UID,
      ID,
      NOW,
    );
    expect(unit.user_approved).toBe(false);
  });

  it("defaults all array fields to empty arrays", () => {
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect(unit.skills).toEqual([]);
    expect(unit.tools).toEqual([]);
    expect(unit.domains).toEqual([]);
    expect(unit.seniority_signals).toEqual([]);
    expect(unit.scope_signals).toEqual([]);
    expect(unit.business_outcomes).toEqual([]);
    expect(unit.metrics).toEqual([]);
  });

  it("omits date_range entirely when not provided (Firestore rejects explicit undefined)", () => {
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    // The conditional spread must produce an object WITHOUT a
    // `date_range` key — not one with `date_range: undefined`.
    // Firestore's strict-undefined rejection is a real failure mode;
    // this test pins the spread shape that prevents it.
    expect("date_range" in unit).toBe(false);
  });

  it("includes date_range when provided", () => {
    const range = { start: "2024-01-01", end: "2024-06-01" };
    const unit = buildManualUnit(
      { ...MIN_INPUT, date_range: range },
      UID,
      ID,
      NOW,
    );
    expect(unit.date_range).toEqual(range);
  });

  it("does NOT stamp rejected or flagged (defaults via undefined)", () => {
    // Manual Units start clean on the approval axis: no rejection,
    // no flag. The spread shape should omit those keys entirely so
    // Firestore doesn't write `false` and create unnecessary index
    // churn.
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect("rejected" in unit).toBe(false);
    expect("flagged" in unit).toBe(false);
  });

  it("stamps reembed_pending=true so the worker picks up the new Unit", () => {
    // Manual Units arrive without an embedding — the re-embed
    // callable (#84) is the only path that computes one, driven by
    // the `reembed_pending` flag. Codex P2 review on #78 caught
    // that omitting this flag would leave manual Units permanently
    // unembedded until an unrelated edit triggered the flag later.
    // Pin so a future "clean default" refactor can't silently
    // reintroduce that gap.
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect(unit.reembed_pending).toBe(true);
  });
});

describe("assertNoStateMachineFields", () => {
  // Regression pins for the Codex P1 on #78: without this guard,
  // a JS-land or `as any` caller could write a single approval
  // flag via `updateFields` and bypass `setApproval`'s atomic
  // three-flag write, leaving a contradictory document (e.g.
  // `user_approved: true` AND `rejected: true`).

  it("throws when partial includes user_approved", () => {
    expect(() => assertNoStateMachineFields({ user_approved: true })).toThrow(
      /"user_approved".*state machine.*setApproval/,
    );
  });

  it("throws when partial includes rejected", () => {
    expect(() => assertNoStateMachineFields({ rejected: true })).toThrow(
      /"rejected"/,
    );
  });

  it("throws when partial includes flagged", () => {
    expect(() => assertNoStateMachineFields({ flagged: true })).toThrow(
      /"flagged"/,
    );
  });

  it("throws when partial includes reembed_pending", () => {
    expect(() =>
      assertNoStateMachineFields({ reembed_pending: false }),
    ).toThrow(/"reembed_pending".*markReembedPending/);
  });

  it("does not throw on pure content edits (skills, tools, raw_text, etc.)", () => {
    expect(() =>
      assertNoStateMachineFields({
        skills: ["a"],
        tools: ["b"],
        raw_text: "new text",
        normalized_summary: "new summary",
        confidence_score: 0.8,
      }),
    ).not.toThrow();
  });

  it("throws when partial includes id (server-stamped, immutable)", () => {
    // Codex P2 (round 2) caught that `as any` callers could
    // retarget the doc by passing a new id. Guard extended.
    expect(() => assertNoStateMachineFields({ id: "other-doc" })).toThrow(
      /"id".*server-stamped/,
    );
  });

  it("throws when partial includes owner_uid (rules would reject, but guard is clearer)", () => {
    expect(() =>
      assertNoStateMachineFields({ owner_uid: "attacker" }),
    ).toThrow(/"owner_uid"/);
  });

  it("throws when partial includes created_at (would lose insert timestamp)", () => {
    expect(() =>
      assertNoStateMachineFields({ created_at: "1970-01-01T00:00:00Z" }),
    ).toThrow(/"created_at"/);
  });

  it("throws when partial includes updated_at (updateFields stamps it itself)", () => {
    expect(() =>
      assertNoStateMachineFields({ updated_at: "1970-01-01T00:00:00Z" }),
    ).toThrow(/"updated_at"/);
  });

  it("does not throw on empty partial", () => {
    expect(() => assertNoStateMachineFields({})).not.toThrow();
  });

  it("error message names the correct entry point for each forbidden field", () => {
    // The thrown message must direct the caller to the right API.
    // Users of setApproval get a setApproval hint; reembed_pending
    // gets markReembedPending.
    try {
      assertNoStateMachineFields({ user_approved: true });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/setApproval/);
    }
    try {
      assertNoStateMachineFields({ reembed_pending: true });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/markReembedPending/);
    }
  });
});

describe("STATE_MACHINE_OWNED_FIELDS", () => {
  it("covers every approval-state flag AND reembed_pending", () => {
    // Pin the set so a future widening of the state-machine domain
    // (e.g. adding a new approval axis) updates this constant and
    // the test together — out-of-sync drift would let the new
    // flag slip past the runtime guard.
    expect(STATE_MACHINE_OWNED_FIELDS).toEqual([
      "user_approved",
      "rejected",
      "flagged",
      "reembed_pending",
    ]);
  });

  it("every entry is rejected by assertNoStateMachineFields", () => {
    // Self-consistency check: the guard and the list must agree.
    for (const field of STATE_MACHINE_OWNED_FIELDS) {
      expect(() =>
        assertNoStateMachineFields({ [field]: true }),
      ).toThrow();
    }
  });
});

describe("SERVER_STAMPED_IMMUTABLE_FIELDS", () => {
  it("covers id, owner_uid, created_at, updated_at", () => {
    // Pin the set so a future widening (e.g. adding schema_version
    // as an immutable) updates this constant and the test together.
    expect(SERVER_STAMPED_IMMUTABLE_FIELDS).toEqual([
      "id",
      "owner_uid",
      "created_at",
      "updated_at",
    ]);
  });

  it("every entry is rejected by assertNoStateMachineFields", () => {
    for (const field of SERVER_STAMPED_IMMUTABLE_FIELDS) {
      expect(() =>
        assertNoStateMachineFields({ [field]: "x" }),
      ).toThrow(/server-stamped/);
    }
  });
});

describe("EMBEDDING_INVALIDATING_FIELDS", () => {
  it("contains raw_text and normalized_summary", () => {
    expect(EMBEDDING_INVALIDATING_FIELDS.has("raw_text")).toBe(true);
    expect(EMBEDDING_INVALIDATING_FIELDS.has("normalized_summary")).toBe(true);
  });

  it("does NOT contain other ExperienceUnit fields (skills/tools/domains/etc.)", () => {
    // Pin the trigger-field set: if a future refactor accidentally
    // adds e.g. "skills" here, every skill edit would re-embed and
    // burn cost. Explicit non-membership test catches that drift.
    for (const field of [
      "skills",
      "tools",
      "domains",
      "seniority_signals",
      "scope_signals",
      "business_outcomes",
      "metrics",
      "confidence_score",
      "user_approved",
      "rejected",
      "flagged",
      "date_range",
    ]) {
      expect(EMBEDDING_INVALIDATING_FIELDS.has(field)).toBe(false);
    }
  });
});
