import { describe, expect, it } from "vitest";

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.ts";

import { generationSnapshotOf, type GenerationSnapshot } from "./resumeInput.ts";
import { findSnapshotDrift, type LiveGenerationState } from "./snapshot.ts";

/**
 * `findSnapshotDrift` (#485): each case starts from a live state that
 * matches the snapshot and changes one thing.
 */

function unit(id: string, fields: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id,
    owner_uid: "owner",
    source_type: "resume",
    source_ref: "ref",
    raw_text: `Unit ${id} raw text`,
    normalized_summary: `Unit ${id} summary`,
    unit_type: "project",
    skills: ["Go"],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [{ claim: "Cut latency 40%", value: 40, unit: "%", direction: "down", confidence: "high" }],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: true,
    date_range: { start: "2020-01-01", end: "2022-06-30" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

function requirement(id: string): JobRequirementUnit {
  return {
    id,
    owner_uid: "owner",
    role_id: "role",
    raw_text: id,
    normalized_requirement: id,
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
  };
}

function match(unitId: string, requirementId: string): UnitMatch {
  return {
    id: `m-${unitId}-${requirementId}`,
    owner_uid: "owner",
    experience_unit_id: unitId,
    job_requirement_unit_id: requirementId,
    role_id: "role",
    semantic_score: 0.8,
    rule_score: 0.7,
    final_score: 0.75,
    rationale: "r",
    surface_evidence: "e",
    approved_for_use: true,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

const U1 = unit("u1");
const U2 = unit("u2");
const SNAPSHOT: GenerationSnapshot = generationSnapshotOf({
  today: "2026-10-28",
  units: [U1, U2],
  roleTitle: "Staff PM",
  requirements: [requirement("r1"), requirement("r2")],
  links: [
    ["u1", "r1"],
    ["u1", "r2"],
    ["u2", "r1"],
  ],
});

function live(overrides: Partial<LiveGenerationState> = {}): LiveGenerationState {
  return {
    roleTitle: "Staff PM",
    approvedUnitIds: ["u1", "u2"],
    units: [U1, U2],
    requirements: [requirement("r1"), requirement("r2")],
    approvedMatches: [match("u1", "r1"), match("u1", "r2"), match("u2", "r1")],
    ...overrides,
  };
}

const withUnit = (u: ExperienceUnit) => live({ units: [u.id === "u1" ? u : U1, u.id === "u2" ? u : U2] });

describe("findSnapshotDrift", () => {
  it("finds nothing when the live state matches", () => {
    expect(findSnapshotDrift(SNAPSHOT, live())).toBeNull();
  });

  it("reports a missing or foreign Role, and a changed title", () => {
    expect(findSnapshotDrift(SNAPSHOT, live({ roleTitle: undefined }))).toEqual({ kind: "role_changed" });
    expect(findSnapshotDrift(SNAPSHOT, live({ roleTitle: "Staff PM, Platform" }))).toEqual({
      kind: "role_title_changed",
    });
  });

  it.each<[string, Partial<LiveGenerationState>, string]>([
    ["absent from the approved-Units query (deleted, unapproved or re-owned)", { units: [U1] }, "u2"],
    ["missing from approved_unit_ids", { approvedUnitIds: ["u1"] }, "u2"],
    ["listed nowhere because approved_unit_ids is undefined", { approvedUnitIds: undefined }, "u1"],
  ])("reports a Unit %s as withdrawn", (_case, overrides, unitId) => {
    expect(findSnapshotDrift(SNAPSHOT, live(overrides))).toEqual({ kind: "unit_withdrawn", unitId });
  });

  it.each<[string, Partial<ExperienceUnit>]>([
    ["raw_text", { raw_text: "Different." }],
    ["a tag", { skills: ["Go", "Rust"] }],
    ["date_range.end", { date_range: { start: "2020-01-01", end: "2022-07-31" } }],
    ["a metric value", { metrics: [{ claim: "Cut latency 40%", value: 41, unit: "%", direction: "down", confidence: "high" }] }],
  ])("reports an edit to %s", (_field, edit) => {
    expect(findSnapshotDrift(SNAPSHOT, withUnit(unit("u2", edit)))).toEqual({ kind: "unit_edited", unitId: "u2" });
  });

  it.each<[string, Partial<ExperienceUnit>]>([
    ["business_outcomes", { business_outcomes: ["faster checkout"] }],
    ["updated_at", { updated_at: "2026-09-01T00:00:00.000Z" }],
    ["metric confidence", { metrics: [{ claim: "Cut latency 40%", value: 40, unit: "%", direction: "down", confidence: "low" }] }],
  ])("ignores an edit to %s, which the model never saw", (_field, edit) => {
    expect(findSnapshotDrift(SNAPSHOT, withUnit(unit("u2", edit)))).toBeNull();
  });

  it("reports an un-approved rendered link, even while another link for the Unit survives", () => {
    expect(
      findSnapshotDrift(SNAPSHOT, live({ approvedMatches: [match("u1", "r1"), match("u2", "r1")] })),
    ).toEqual({ kind: "link_withdrawn", unitId: "u1", requirementId: "r2" });
  });

  it("reports a rendered link whose Requirement disappeared", () => {
    expect(findSnapshotDrift(SNAPSHOT, live({ requirements: [requirement("r1")] }))).toEqual({
      kind: "link_withdrawn",
      unitId: "u1",
      requirementId: "r2",
    });
  });

  it.each<[string, Partial<LiveGenerationState>]>([
    [
      "an extra approved match for a rendered Unit",
      { approvedMatches: [match("u1", "r1"), match("u1", "r2"), match("u2", "r1"), match("u2", "r2")] },
    ],
    [
      "an extra approved match for an unrendered Unit",
      { approvedMatches: [match("u1", "r1"), match("u1", "r2"), match("u2", "r1"), match("u3", "r1")] },
    ],
    ["an extra id in approved_unit_ids", { approvedUnitIds: ["u1", "u2", "u3"] }],
    ["an extra Unit in the query results", { units: [U1, U2, unit("u3")] }],
  ])("accepts %s: additions cannot make what the model read untrue", (_case, overrides) => {
    expect(findSnapshotDrift(SNAPSHOT, live(overrides))).toBeNull();
  });

  describe("precedence", () => {
    it("reports the Role before a Unit edit", () => {
      const state = { ...withUnit(unit("u1", { raw_text: "Edited." })), roleTitle: "Other" };
      expect(findSnapshotDrift(SNAPSHOT, state)?.kind).toBe("role_title_changed");
    });

    it("reports a Unit edit before a withdrawn link", () => {
      const state = {
        ...withUnit(unit("u2", { raw_text: "Edited." })),
        approvedMatches: [match("u1", "r1"), match("u2", "r1")],
      };
      expect(findSnapshotDrift(SNAPSHOT, state)).toEqual({ kind: "unit_edited", unitId: "u2" });
    });

    it("reports the smallest edited Unit id first", () => {
      const state = live({ units: [unit("u2", { raw_text: "Edited." }), unit("u1", { raw_text: "Edited too." })] });
      expect(findSnapshotDrift(SNAPSHOT, state)).toEqual({ kind: "unit_edited", unitId: "u1" });
    });
  });
});
