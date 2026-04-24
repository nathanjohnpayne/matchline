import { describe, expect, it } from "vitest";

import {
  buildManualUnit,
  EMBEDDING_INVALIDATING_FIELDS,
  flagsForApprovalState,
  shouldMarkReembed,
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

  it("does NOT stamp rejected, flagged, or reembed_pending (defaults via undefined)", () => {
    // Manual Units start clean: no rejection, no flag, no re-embed
    // pending. The spread shape should omit those keys entirely so
    // Firestore doesn't try to write `false` and create unnecessary
    // index churn.
    const unit = buildManualUnit(MIN_INPUT, UID, ID, NOW);
    expect("rejected" in unit).toBe(false);
    expect("flagged" in unit).toBe(false);
    expect("reembed_pending" in unit).toBe(false);
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
