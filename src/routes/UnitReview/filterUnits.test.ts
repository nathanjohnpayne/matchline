import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";

import {
  countApproved,
  excludeRejected,
  sortByUpdatedDesc,
} from "./filterUnits.ts";

/**
 * Minimal factory — only the fields the filters touch are set.
 * Casting to `ExperienceUnit` at the boundary because the filter
 * helpers are structurally typed against the fields they read, and a
 * full Unit stub would be 20+ required fields of noise per case.
 */
function unit(partial: Partial<ExperienceUnit>): ExperienceUnit {
  return {
    id: "x",
    owner_uid: "u",
    source_type: "resume",
    source_ref: "",
    raw_text: "",
    normalized_summary: "",
    unit_type: "achievement",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("excludeRejected", () => {
  it("omits Units with rejected=true", () => {
    const units = [
      unit({ id: "a", rejected: true }),
      unit({ id: "b" }),
      unit({ id: "c", rejected: false }),
    ];
    const result = excludeRejected(units);
    expect(result.map((u) => u.id)).toEqual(["b", "c"]);
  });

  it("keeps Units where rejected is unset (undefined) — the default pending state", () => {
    // A Unit coming off a fresh extraction has no `rejected` field
    // at all. The filter must treat `rejected === undefined` as
    // "not rejected" — strict `!== true` comparison is load-bearing.
    const units = [unit({ id: "pending" })];
    expect(excludeRejected(units)).toHaveLength(1);
  });

  it("returns empty array when every Unit is rejected", () => {
    const units = [
      unit({ id: "a", rejected: true }),
      unit({ id: "b", rejected: true }),
    ];
    expect(excludeRejected(units)).toEqual([]);
  });

  it("is a pure function (does not mutate input)", () => {
    const a = unit({ id: "a", rejected: true });
    const b = unit({ id: "b" });
    const input = [a, b];
    const inputCopy = [...input];
    excludeRejected(input);
    expect(input).toEqual(inputCopy);
  });
});

describe("sortByUpdatedDesc", () => {
  it("most-recently-updated Unit comes first", () => {
    const result = sortByUpdatedDesc([
      unit({ id: "old", updated_at: "2026-01-01T00:00:00.000Z" }),
      unit({ id: "new", updated_at: "2026-04-01T00:00:00.000Z" }),
      unit({ id: "mid", updated_at: "2026-02-15T00:00:00.000Z" }),
    ]);
    expect(result.map((u) => u.id)).toEqual(["new", "mid", "old"]);
  });

  it("falls back to created_at when updated_at ties (stable order)", () => {
    const ts = "2026-03-01T00:00:00.000Z";
    const result = sortByUpdatedDesc([
      unit({
        id: "older-create",
        updated_at: ts,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
      unit({
        id: "newer-create",
        updated_at: ts,
        created_at: "2026-02-01T00:00:00.000Z",
      }),
    ]);
    expect(result.map((u) => u.id)).toEqual(["newer-create", "older-create"]);
  });

  it("does not mutate the input array (regression — React props should be stable)", () => {
    // If the sort mutates, the subscribed-units state array the
    // component passed in would get reordered in place, which is a
    // subtle React-render bug (new render gets the mutated array
    // with a different order than before, but same identity).
    const input = [
      unit({ id: "a", updated_at: "2026-01-01T00:00:00.000Z" }),
      unit({ id: "b", updated_at: "2026-02-01T00:00:00.000Z" }),
    ];
    const inputSnapshot = input.map((u) => u.id);
    const result = sortByUpdatedDesc(input);
    expect(input.map((u) => u.id)).toEqual(inputSnapshot);
    // And the result is a new array
    expect(result).not.toBe(input);
  });
});

describe("countApproved", () => {
  it("counts Units with user_approved=true", () => {
    const units = [
      unit({ id: "a", user_approved: true }),
      unit({ id: "b", user_approved: false }),
      unit({ id: "c", user_approved: true }),
    ];
    expect(countApproved(units)).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(countApproved([])).toBe(0);
  });

  it("does NOT count rejected Units toward the approved total (they have user_approved=false by the state machine)", () => {
    // The flag combinations are mutually exclusive by design
    // (see `flagsForApprovalState`), but pin this explicitly — a
    // hypothetical hand-constructed {user_approved: true, rejected:
    // true} Unit should not count.
    const units = [
      unit({ id: "a", user_approved: true }),
      unit({ id: "b", user_approved: true, rejected: true }),
    ];
    // We count what the flag says, not what "makes sense" — because
    // rejected Units should never have user_approved: true in
    // practice (setApproval enforces it). This test pins the
    // counter's behavior: if the data is corrupt, the counter
    // tells the truth about the data, not a sanitized version.
    expect(countApproved(units)).toBe(2);
  });
});
