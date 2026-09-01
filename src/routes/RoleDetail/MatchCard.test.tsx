/**
 * View-layer tests for `MatchCard`. Pure
 * `renderToStaticMarkup` shape checks — no Firebase, no
 * router. Mirrors the RoleDetailView test pattern.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit, UnitMatch } from "../../types/capability.ts";

import MatchCard from "./MatchCard.tsx";

const ALICE = "user-alice";

function makeUnit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: "unit-1",
    owner_uid: ALICE,
    source_type: "resume",
    source_ref: "ref",
    raw_text: "raw",
    normalized_summary: "Led the living-room launch programme",
    unit_type: "project",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 0.85,
    user_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMatch(overrides: Partial<UnitMatch> = {}): UnitMatch {
  return {
    id: "match-1",
    owner_uid: ALICE,
    experience_unit_id: "unit-1",
    job_requirement_unit_id: "req-1",
    role_id: "role-1",
    semantic_score: 0.5,
    rule_score: 0.5,
    final_score: 0.5,
    rationale: "Matched on semantic similarity.",
    surface_evidence: "Led the living-room launch programme",
    approved_for_use: false,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MatchCard: actions during a matching run (Codex P2 on #435)", () => {
  it("disables Approve and Reject while the Role is being re-scored", () => {
    // `replaceMatchesForRole()` deletes every existing match doc
    // and writes replacements under NEW ids. A click landing
    // between the transaction committing and the subscription
    // delivering would target a deleted id, fail in the console
    // only, and silently lose the user's decision. Disabling is
    // the honest surface: the decision cannot be recorded right
    // now, so don't accept it and pretend.
    const html = renderToStaticMarkup(
      <MatchCard
        actionsDisabled
        match={makeMatch()}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    // Both action buttons, and only those.
    expect(html.match(/disabled/g)?.length).toBe(2);
    expect(html).toContain("approvals are paused");
  });

  it("leaves them enabled when no run is in flight", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch()}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("approvals are paused");
  });

  it("defaults to enabled when the prop is omitted (pre-#435 callers)", () => {
    const html = renderToStaticMarkup(
      <MatchCard
        match={makeMatch({ approved_for_use: true })}
        unit={makeUnit()}
        onApprovalStateChange={() => {}}
      />,
    );
    expect(html).not.toContain("disabled");
  });
});
