import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";

import {
  applyMetricUpdate,
  applyOptimistic,
  draftDiff,
  editableFromUnit,
  presentationUnit,
  type EditableUnitFields,
  type EditStatus,
} from "./inlineEditState.ts";

function unit(partial: Partial<ExperienceUnit> & { id: string }): ExperienceUnit {
  const defaults: Omit<ExperienceUnit, "id"> = {
    owner_uid: "u",
    source_type: "resume",
    source_ref: "resume.pdf",
    raw_text: "raw",
    normalized_summary: "summary",
    unit_type: "achievement",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 0.8,
    user_approved: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  return { ...defaults, ...partial };
}

function draftOf(u: ExperienceUnit): EditableUnitFields {
  return editableFromUnit(u);
}

describe("editableFromUnit", () => {
  it("extracts every editable field", () => {
    const u = unit({
      id: "x",
      raw_text: "r",
      normalized_summary: "s",
      source_type: "linkedin",
      source_ref: "linkedin.html",
      unit_type: "project",
      skills: ["sql"],
      tools: ["snowflake"],
      domains: ["video"],
      seniority_signals: ["senior"],
      scope_signals: ["40M users"],
      business_outcomes: ["+12% revenue"],
      metrics: [{ claim: "40M users", confidence: "high" }],
      evidence_type: "user_confirmed",
      confidence_score: 0.9,
      date_range: { start: "2023-01-01", end: "2023-06-01" },
    });
    const draft = editableFromUnit(u);
    expect(draft.raw_text).toBe("r");
    expect(draft.normalized_summary).toBe("s");
    expect(draft.source_type).toBe("linkedin");
    expect(draft.source_ref).toBe("linkedin.html");
    expect(draft.unit_type).toBe("project");
    expect(draft.skills).toEqual(["sql"]);
    expect(draft.tools).toEqual(["snowflake"]);
    expect(draft.domains).toEqual(["video"]);
    expect(draft.seniority_signals).toEqual(["senior"]);
    expect(draft.scope_signals).toEqual(["40M users"]);
    expect(draft.business_outcomes).toEqual(["+12% revenue"]);
    expect(draft.metrics).toHaveLength(1);
    expect(draft.evidence_type).toBe("user_confirmed");
    expect(draft.confidence_score).toBe(0.9);
    expect(draft.date_range).toEqual({
      start: "2023-01-01",
      end: "2023-06-01",
    });
  });

  it("omits date_range entirely when the Unit has none (Firestore undefined-rejection shape)", () => {
    const draft = editableFromUnit(unit({ id: "x" }));
    expect("date_range" in draft).toBe(false);
  });

  it("does NOT include state-machine-owned or server-stamped fields", () => {
    const u = unit({
      id: "x",
      user_approved: true,
      rejected: true,
      flagged: true,
      reembed_pending: true,
    });
    const draft = editableFromUnit(u) as Record<string, unknown>;
    // Pin: these fields are the #78 state-machine + server-stamped
    // surface. If they leak into the editable draft, updateFields
    // would throw (via assertNoStateMachineFields) at save time —
    // but better to block at the source.
    expect("id" in draft).toBe(false);
    expect("owner_uid" in draft).toBe(false);
    expect("created_at" in draft).toBe(false);
    expect("updated_at" in draft).toBe(false);
    expect("embedding" in draft).toBe(false);
    expect("user_approved" in draft).toBe(false);
    expect("rejected" in draft).toBe(false);
    expect("flagged" in draft).toBe(false);
    expect("reembed_pending" in draft).toBe(false);
  });
});

describe("applyOptimistic", () => {
  it("merges draft fields over the base Unit", () => {
    const base = unit({ id: "x", raw_text: "old", skills: ["old-skill"] });
    const draft: EditableUnitFields = {
      ...editableFromUnit(base),
      raw_text: "new",
      skills: ["new-skill"],
    };
    const merged = applyOptimistic(base, draft);
    expect(merged.raw_text).toBe("new");
    expect(merged.skills).toEqual(["new-skill"]);
    // Server-stamped fields survive the merge
    expect(merged.id).toBe("x");
    expect(merged.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("preserves a date_range present in both base and draft", () => {
    const base = unit({
      id: "x",
      date_range: { start: "2023-01-01", end: "2023-06-01" },
    });
    const draft = editableFromUnit(base);
    const merged = applyOptimistic(base, draft);
    expect(merged.date_range).toEqual({
      start: "2023-01-01",
      end: "2023-06-01",
    });
  });

  it("removes date_range when the draft clears it (draft.date_range === undefined)", () => {
    // User had a date_range and used the form to clear it. The
    // optimistic render must drop the key, not show the stale
    // value merged from the base.
    const base = unit({
      id: "x",
      date_range: { start: "2023-01-01" },
    });
    const draft: EditableUnitFields = {
      ...editableFromUnit(base),
    };
    delete draft.date_range;
    const merged = applyOptimistic(base, draft);
    expect("date_range" in merged).toBe(false);
  });

  it("adds date_range when the draft sets one and base had none", () => {
    const base = unit({ id: "x" });
    const draft: EditableUnitFields = {
      ...editableFromUnit(base),
      date_range: { start: "2024-01-01" },
    };
    const merged = applyOptimistic(base, draft);
    expect(merged.date_range).toEqual({ start: "2024-01-01" });
  });
});

describe("draftDiff", () => {
  it("returns an empty diff when draft equals the base", () => {
    const base = unit({ id: "x", skills: ["sql"], metrics: [] });
    const draft = editableFromUnit(base);
    expect(draftDiff(base, draft)).toEqual({});
  });

  it("detects a text-field change", () => {
    const base = unit({ id: "x", raw_text: "old" });
    const draft = { ...editableFromUnit(base), raw_text: "new" };
    expect(draftDiff(base, draft)).toEqual({ raw_text: "new" });
  });

  it("detects a skills change by element comparison", () => {
    const base = unit({ id: "x", skills: ["sql", "python"] });
    const draft = { ...editableFromUnit(base), skills: ["sql", "firebase"] };
    expect(draftDiff(base, draft)).toEqual({ skills: ["sql", "firebase"] });
  });

  it("does NOT flag a change when skills array has the same content (element-wise)", () => {
    const base = unit({ id: "x", skills: ["sql", "python"] });
    // Fresh array reference with same contents — shouldn't diff
    const draft = {
      ...editableFromUnit(base),
      skills: ["sql", "python"],
    };
    expect(draftDiff(base, draft)).toEqual({});
  });

  it("detects a metric change inside the metrics array", () => {
    const base = unit({
      id: "x",
      metrics: [{ claim: "40M users", confidence: "high" }],
    });
    const draft = {
      ...editableFromUnit(base),
      metrics: [{ claim: "40M users", confidence: "medium" as const }],
    };
    expect(draftDiff(base, draft)).toEqual({
      metrics: [{ claim: "40M users", confidence: "medium" }],
    });
  });

  it("detects a metrics-count change (add or remove)", () => {
    const base = unit({ id: "x", metrics: [] });
    const draft = {
      ...editableFromUnit(base),
      metrics: [{ claim: "new metric", confidence: "high" as const }],
    };
    expect(draftDiff(base, draft).metrics).toBeDefined();
  });

  it("detects date_range presence change (add, remove, modify)", () => {
    // Add
    const base1 = unit({ id: "x" });
    const draft1 = {
      ...editableFromUnit(base1),
      date_range: { start: "2024-01-01" },
    };
    expect(draftDiff(base1, draft1).date_range).toEqual({
      start: "2024-01-01",
    });

    // Remove
    const base2 = unit({ id: "x", date_range: { start: "2024-01-01" } });
    const draft2 = { ...editableFromUnit(base2) };
    delete draft2.date_range;
    expect("date_range" in draftDiff(base2, draft2)).toBe(true);
    expect(draftDiff(base2, draft2).date_range).toBeUndefined();

    // Modify `end`
    const base3 = unit({
      id: "x",
      date_range: { start: "2024-01-01", end: "2024-06-01" },
    });
    const draft3 = {
      ...editableFromUnit(base3),
      date_range: { start: "2024-01-01", end: "2024-12-31" },
    };
    expect(draftDiff(base3, draft3).date_range).toEqual({
      start: "2024-01-01",
      end: "2024-12-31",
    });
  });

  it("returns multiple fields when multiple changed", () => {
    const base = unit({
      id: "x",
      raw_text: "old",
      skills: ["sql"],
      confidence_score: 0.5,
    });
    const draft = {
      ...editableFromUnit(base),
      raw_text: "new",
      skills: ["sql", "python"],
      confidence_score: 0.9,
    };
    const diff = draftDiff(base, draft);
    expect(diff.raw_text).toBe("new");
    expect(diff.skills).toEqual(["sql", "python"]);
    expect(diff.confidence_score).toBe(0.9);
  });

  it("round-trip through editableFromUnit produces an empty diff", () => {
    // Self-consistency: extracting a draft from a Unit and
    // diffing must produce no change. Load-bearing for the
    // "entering edit mode doesn't mark anything dirty" UX.
    const u = unit({
      id: "x",
      raw_text: "r",
      skills: ["a", "b"],
      metrics: [{ claim: "c", confidence: "high" }],
      date_range: { start: "2024-01-01", end: "2024-06-01" },
    });
    expect(draftDiff(u, draftOf(u))).toEqual({});
  });
});

describe("presentationUnit", () => {
  it("renders the live unit in view mode", () => {
    const live = unit({ id: "x", raw_text: "live" });
    expect(presentationUnit(live, { kind: "view" })).toBe(live);
  });

  it("renders the LIVE unit in editing mode (draft is in the form below, not the row header)", () => {
    // The row header shows truth in editing mode — the draft
    // lives in the form. Otherwise the user would see their
    // typed-but-uncommitted edits in two places (form + header).
    const live = unit({ id: "x", raw_text: "persisted" });
    const status: EditStatus = {
      kind: "editing",
      draft: { ...editableFromUnit(live), raw_text: "draft" },
      baseSnapshot: live,
    };
    const result = presentationUnit(live, status);
    expect(result.raw_text).toBe("persisted");
  });

  it("renders the optimistic merge in saving mode (draft over edit-start snapshot)", () => {
    const live = unit({ id: "x", raw_text: "persisted" });
    const draftText = "saving optimistic";
    const status: EditStatus = {
      kind: "saving",
      draft: { ...editableFromUnit(live), raw_text: draftText },
      baseSnapshot: live,
    };
    const result = presentationUnit(live, status);
    expect(result.raw_text).toBe(draftText);
  });

  it("rolls back to the LIVE unit in error mode (regression: nathanpayne-codex Phase 4b r2 on #90)", () => {
    // Prior behavior: error state kept the optimistic merge
    // visible next to the error banner, which lied about the
    // persisted state. The form below keeps the draft for retry,
    // but the row header rolls back to truth.
    const live = unit({ id: "x", raw_text: "persisted" });
    const status: EditStatus = {
      kind: "error",
      draft: { ...editableFromUnit(live), raw_text: "draft would be lying" },
      baseSnapshot: live,
      error: new Error("Save failed"),
    };
    const result = presentationUnit(live, status);
    // Header shows the persisted text, NOT the draft.
    expect(result.raw_text).toBe("persisted");
    expect(result.raw_text).not.toBe("draft would be lying");
  });

  it("uses the snapshot (not the live prop) as the optimistic base in saving mode", () => {
    // If the subscription delivers an update mid-save, the live
    // unit drifts. The optimistic preview must stay stable on
    // the snapshot so it doesn't flicker between drift-merge
    // and snapshot-merge as updates arrive.
    const snapshot = unit({
      id: "x",
      raw_text: "snapshot",
      confidence_score: 0.5,
    });
    const drifted = unit({
      id: "x",
      raw_text: "drifted-mid-save",
      confidence_score: 0.99, // server changed this during save
    });
    const status: EditStatus = {
      kind: "saving",
      draft: { ...editableFromUnit(snapshot), raw_text: "user-edit" },
      baseSnapshot: snapshot,
    };
    const result = presentationUnit(drifted, status);
    // raw_text comes from the draft
    expect(result.raw_text).toBe("user-edit");
    // confidence_score comes from the SNAPSHOT, not the drifted
    // live value — the user is committing what they saw at edit
    // start.
    expect(result.confidence_score).toBe(0.5);
  });
});

describe("applyMetricUpdate", () => {
  it("merges defined fields into the metric", () => {
    const m = { claim: "old", confidence: "low" as const };
    const result = applyMetricUpdate(m, {
      claim: "new",
      value: 40,
      unit: "M",
    });
    expect(result).toEqual({
      claim: "new",
      confidence: "low",
      value: 40,
      unit: "M",
    });
  });

  it("strips a key when the partial sets it to undefined (Codex P1 #90 Phase 4b r2)", () => {
    // Regression pin: the prior `updateAt` in the form did
    // `{ ...m, ...partial }` which left `value: undefined` in
    // the merged object. The service's `buildUpdatePayload` only
    // sanitizes top-level undefined, so the nested undefined
    // would have reached `updateDoc()` and Firestore would have
    // rejected the save. Pin that the strip happens here so a
    // future caller that passes undefined gets the natural
    // "key absent" shape.
    const m = {
      claim: "40M users",
      value: 40,
      unit: "M",
      direction: "up" as const,
      confidence: "high" as const,
    };
    const result = applyMetricUpdate(m, { value: undefined });
    expect("value" in result).toBe(false);
    // Other fields preserved
    expect(result.claim).toBe("40M users");
    expect(result.unit).toBe("M");
    expect(result.direction).toBe("up");
    expect(result.confidence).toBe("high");
  });

  it("strips multiple undefined fields in one update", () => {
    const m = {
      claim: "x",
      value: 1,
      unit: "ms",
      direction: "down" as const,
      confidence: "medium" as const,
    };
    const result = applyMetricUpdate(m, {
      value: undefined,
      unit: undefined,
      direction: undefined,
    });
    expect("value" in result).toBe(false);
    expect("unit" in result).toBe(false);
    expect("direction" in result).toBe(false);
    expect(result.claim).toBe("x");
    expect(result.confidence).toBe("medium");
  });

  it("does not mutate the input metric", () => {
    const m = { claim: "x", value: 5, confidence: "high" as const };
    const snapshot = { ...m };
    applyMetricUpdate(m, { value: undefined });
    expect(m).toEqual(snapshot);
  });

  it("an empty partial returns a copy of the original (no-op)", () => {
    const m = { claim: "x", value: 5, confidence: "high" as const };
    const result = applyMetricUpdate(m, {});
    expect(result).toEqual(m);
    expect(result).not.toBe(m);
  });
});
