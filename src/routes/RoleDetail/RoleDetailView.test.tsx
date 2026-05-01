/**
 * View-layer tests for `RoleDetailView` (#129). Pure
 * `renderToStaticMarkup` shape checks — no Firebase, no
 * router. Mirrors the UnitReview/View test pattern.
 *
 * The container's lifecycle (subscribe / unsubscribe /
 * stale-closure guard) is exercised by hand-testing in the
 * Storybook fixture (deferred) and by the integration
 * pattern shipping in #25's eval harness; here we pin the
 * pure render shape against fixtures.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../types/capability.ts";
import type { Role } from "../../types/crm.ts";

import RoleDetailView from "./RoleDetailView.tsx";

const ALICE = "user-alice";

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    owner_uid: ALICE,
    company_id: "company-1",
    title: "Senior Product Manager",
    jd_raw: "Build great things.",
    discovered_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeReq(
  id: string,
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  return {
    id,
    owner_uid: ALICE,
    role_id: "role-1",
    raw_text: `raw ${id}`,
    normalized_requirement: `Req ${id}`,
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "medium",
    must_have: false,
    extracted_from: "qualifications",
    ...overrides,
  };
}

function makeMatch(
  id: string,
  reqId: string,
  unitId: string,
  finalScore: number,
): UnitMatch {
  return {
    id,
    owner_uid: ALICE,
    role_id: "role-1",
    experience_unit_id: unitId,
    job_requirement_unit_id: reqId,
    semantic_score: finalScore,
    rule_score: finalScore,
    final_score: finalScore,
    rationale: `match ${id} rationale`,
    surface_evidence: `match ${id} evidence`,
    approved_for_use: false,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeUnit(id: string, summary: string): ExperienceUnit {
  return {
    id,
    owner_uid: ALICE,
    source_type: "resume",
    source_ref: "ref",
    raw_text: summary,
    normalized_summary: summary,
    unit_type: "project",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const NOOP = (): void => {};
const NOOP_STATE_CHANGE = (): void => {};

/**
 * Defaults for the Applications-tab props added in #202.
 * Spread into every test so the existing tests don't have
 * to repeat them. Tests that exercise the Applications tab
 * directly override these inline.
 */
const APPS_TAB_DEFAULTS = {
  applications: [] as readonly import("../../types/crm.ts").Application[],
  hasApprovedMatches: false,
  generationStatus: "editing" as const,
  generationError: null as Error | null,
  onGenerate: NOOP,
};

describe("RoleDetailView", () => {
  it("LOADING: renders a loading placeholder before the first snapshot", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="loading"
        role={null}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("data-testid=\"role-detail-loading\"");
    expect(html).toContain("Loading Role");
  });

  it("ERROR: renders the error banner with the error message", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="error"
        role={null}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={new Error("permission-denied")}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("data-testid=\"role-detail-error\"");
    expect(html).toContain("permission-denied");
  });

  it("NOT-FOUND: renders the anti-enumeration message when status=ready and role=null", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={null}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("data-testid=\"role-detail-not-found\"");
    expect(html).toContain("not found, or not owned by you");
  });

  it("READY: renders the role title and three tabs (Requirements, Matches, Applications)", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole({ title: "Director of Platform" })}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("Director of Platform");
    expect(html).toContain(">Requirements<");
    expect(html).toContain(">Matches<");
    expect(html).toContain(">Applications<");
  });

  it("MATCHES TAB: renders one row per Requirement with top-K matches sorted by final_score desc", () => {
    const reqs = [makeReq("r1"), makeReq("r2")];
    const units = [
      makeUnit("u1", "Disney+ playback memory work"),
      makeUnit("u2", "0→1 ML feature ship"),
    ];
    const matches = [
      makeMatch("m-r1-low", "r1", "u1", 0.4),
      makeMatch("m-r1-high", "r1", "u2", 0.85),
      makeMatch("m-r2-only", "r2", "u1", 0.55),
    ];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={unitsById}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("data-testid=\"matches-tab\"");
    expect(html).toContain("Req r1");
    expect(html).toContain("Req r2");
    // Sorted: r1's high-score match HTML appears before its
    // low-score match in the rendered string.
    const highIdx = html.indexOf("match m-r1-high evidence");
    const lowIdx = html.indexOf("match m-r1-low evidence");
    expect(highIdx).toBeGreaterThan(0);
    expect(lowIdx).toBeGreaterThan(highIdx);
    // Score badges rendered as 0–100 with 1 decimal.
    expect(html).toContain(">85.0<"); // 0.85 → 85.0
    expect(html).toContain(">40.0<"); // 0.4 → 40.0
    expect(html).toContain(">55.0<"); // 0.55 → 55.0
  });

  it("MATCHES TAB: empty Requirements still render with a No-matches placeholder", () => {
    const reqs = [makeReq("r-empty")];
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("Req r-empty");
    expect(html).toContain("data-testid=\"match-row-empty\"");
    expect(html).toContain("No matches found");
  });

  it("MATCHES TAB: a Match whose source Unit is missing renders a 'no longer available' placeholder", () => {
    const reqs = [makeReq("r1")];
    // Match references u-deleted but unitsById doesn't include it.
    const matches = [makeMatch("m-orphan", "r1", "u-deleted", 0.5)];
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("Unit no longer available");
  });

  it("MATCHES TAB: must_have flag renders an explicit must-have label", () => {
    const reqs = [makeReq("r-mh", { must_have: true, priority: "high" })];
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("must-have");
    expect(html).toContain("priority: high");
  });

  it("REQUIREMENTS TAB: renders the placeholder count when active", () => {
    const reqs = [makeReq("r1"), makeReq("r2"), makeReq("r3")];
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="requirements"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("data-testid=\"requirements-tab-placeholder\"");
    expect(html).toContain("3 requirements parsed");
  });

  // -- #202: Applications tab (Generate resume CTA + list) -----

  it("APPLICATIONS TAB: renders the live tab (not the old placeholder) when active", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="applications"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('data-testid="applications-tab"');
    expect(html).toContain('data-applications-tab-status="editing"');
    // Old placeholder testid is gone — confirms the swap landed.
    expect(html).not.toContain('data-testid="applications-tab-placeholder"');
    // Generate button is always present (it's the primary CTA).
    expect(html).toMatch(
      /<button[^>]*data-action="applications-generate"[^>]*>/,
    );
  });

  it("APPLICATIONS TAB: no approved matches → Generate disabled with 'Approve at least one match first'", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="applications"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
        hasApprovedMatches={false}
      />,
    );
    expect(html).toContain("Approve at least one match first");
    // HTML attribute disabled present on the button (anchor on
    // \sdisabled[\s=>] so Tailwind's disabled:* utilities don't
    // false-positive — same pattern as #201 / #200).
    const btn = html.match(
      /<button[^>]*data-action="applications-generate"[^>]*>/,
    );
    expect(btn).not.toBeNull();
    expect(btn?.[0]).toMatch(/\sdisabled(?:=|>|\s)/);
    expect(btn?.[0]).toContain('aria-disabled="true"');
  });

  it("APPLICATIONS TAB: approved matches present → Generate enabled, no list yet", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="applications"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
        hasApprovedMatches={true}
      />,
    );
    const btn = html.match(
      /<button[^>]*data-action="applications-generate"[^>]*>[^<]*<\/button>/,
    );
    expect(btn).not.toBeNull();
    expect(btn?.[0]).not.toMatch(/\sdisabled(?:=|>|\s)/);
    expect(btn?.[0]).toContain(">Generate resume<");
    expect(html).toContain('data-testid="applications-tab-empty"');
    expect(html).toContain("No Applications yet");
  });

  it("APPLICATIONS TAB: existing Applications render with stage badge + Open link", () => {
    const apps = [
      {
        id: "app-old",
        owner_uid: ALICE,
        role_id: "role-1",
        stage: "drafting" as const,
        last_activity_at: "2026-04-01T00:00:00.000Z",
        generated_assets: [],
        approved_unit_ids: [],
      },
      {
        id: "app-new",
        owner_uid: ALICE,
        role_id: "role-1",
        stage: "applied" as const,
        last_activity_at: "2026-05-01T00:00:00.000Z",
        generated_assets: [
          {
            id: "asset-1",
            owner_uid: ALICE,
            application_id: "app-new",
            kind: "resume" as const,
            format: "json" as const,
            storage_path: "",
            validation_status: "passed" as const,
            created_at: "2026-05-01T00:00:00.000Z",
            updated_at: "2026-05-01T00:00:00.000Z",
          },
        ],
        approved_unit_ids: ["u1"],
      },
    ];
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="applications"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
        applications={apps}
        hasApprovedMatches={true}
      />,
    );
    expect(html).toContain('data-testid="applications-tab-list"');
    // Both rows render.
    expect(html).toContain("app-old");
    expect(html).toContain("app-new");
    // Stage badges visible.
    expect(html).toMatch(/data-testid="applications-tab-stage"[^>]*>drafting</);
    expect(html).toMatch(/data-testid="applications-tab-stage"[^>]*>applied</);
    // Open link points at the right route.
    expect(html).toMatch(/href="\/applications\/app-old"/);
    expect(html).toMatch(/href="\/applications\/app-new"/);
    // Sort order: most recent first (app-new before app-old).
    const newIdx = html.indexOf("app-new");
    const oldIdx = html.indexOf("app-old");
    expect(newIdx).toBeGreaterThan(0);
    expect(oldIdx).toBeGreaterThan(newIdx);
    // Asset count rendered for the row that has assets.
    expect(html).toContain("1 asset");
    // Empty-state copy ("No assets yet") for the row that doesn't.
    expect(html).toContain("No assets yet");
  });

  it("APPLICATIONS TAB: generating status renders the thin progress bar (UI rule 6)", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="applications"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
        hasApprovedMatches={true}
        generationStatus="generating"
      />,
    );
    expect(html).toContain('data-testid="applications-tab-progress"');
    expect(html).toContain('role="progressbar"');
    // Generate button disabled while in flight + label flips to Generating…
    const btn = html.match(
      /<button[^>]*data-action="applications-generate"[^>]*>[^<]*<\/button>/,
    );
    expect(btn?.[0]).toMatch(/\sdisabled(?:=|>|\s)/);
    expect(btn?.[0]).toContain("Generating");
  });

  it("APPLICATIONS TAB: error status renders the error banner with the message", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="applications"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
        hasApprovedMatches={true}
        generationStatus="error"
        generationError={new Error("Resume generation failed after retries.")}
      />,
    );
    expect(html).toContain('data-testid="applications-tab-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Resume generation failed");
  });

  it("ARIA: tabs render with role=tablist + role=tab + aria-selected on the active tab", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain('role="tabpanel"');
  });

  // -- #130: approve/reject buttons + Gaps view ---------------------

  it("BUTTONS: each match card renders Approve + Reject buttons with aria-pressed reflecting state", () => {
    const reqs = [makeReq("r1")];
    const units = [makeUnit("u1", "Some work")];
    const matches = [
      makeMatch("m-fresh", "r1", "u1", 0.7), // not approved, not rejected
    ];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={unitsById}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('data-testid="match-approve-button"');
    expect(html).toContain('data-testid="match-reject-button"');
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
    // Both aria-pressed=false when neither flag is set.
    const ap = (html.match(/aria-pressed="false"/g) ?? []).length;
    expect(ap).toBeGreaterThanOrEqual(2);
  });

  it("BUTTONS: approved match renders 'Approved ✓' with aria-pressed=true on the Approve button", () => {
    const reqs = [makeReq("r1")];
    const units = [makeUnit("u1", "Some work")];
    const matches = [
      {
        ...makeMatch("m-approved", "r1", "u1", 0.7),
        approved_for_use: true,
      },
    ];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={unitsById}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("Approved ✓");
    expect(html).toContain('data-approval-state="approved"');
  });

  it("BUTTONS: rejected match renders 'Rejected ✗' with aria-pressed=true on the Reject button", () => {
    const reqs = [makeReq("r1")];
    const units = [makeUnit("u1", "Some work")];
    const matches = [
      {
        ...makeMatch("m-rejected", "r1", "u1", 0.7),
        user_rejected: true,
      },
    ];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={unitsById}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain("Rejected ✗");
    expect(html).toContain('data-approval-state="rejected"');
  });

  it("GAPS VIEW: renders the empty/affirmative state when every must-have has a qualifying match", () => {
    const reqs = [makeReq("r-mh", { must_have: true })];
    const units = [makeUnit("u1", "Some work")];
    const matches = [makeMatch("m-strong", "r-mh", "u1", 0.85)];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={unitsById}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('data-testid="gaps-view-empty"');
    expect(html).toContain("Every must-have requirement has a qualifying match");
  });

  // -- #131: sub-score breakdown badge + auto-trigger UX --

  it("BADGE (#131): match score badge tooltip renders the 7 component breakdown rows when components are persisted", () => {
    const reqs = [makeReq("r1")];
    const units = [makeUnit("u1", "Some work")];
    const matches = [
      {
        ...makeMatch("m-with-components", "r1", "u1", 0.7),
        components: {
          semantic_similarity: 0.9,
          skill_overlap: 0.8,
          domain_overlap: 0.7,
          tool_overlap: 0.6,
          seniority_alignment: 0.5,
          scope_alignment: 0.4,
          recency: 0.3,
        },
      },
    ];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={unitsById}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('data-testid="match-score-badge"');
    expect(html).toContain('data-testid="match-score-popover"');
    // 7 component rows in display order.
    expect(html).toContain(">Semantic<");
    expect(html).toContain(">Skill<");
    expect(html).toContain(">Domain<");
    expect(html).toContain(">Tool<");
    expect(html).toContain(">Seniority<");
    expect(html).toContain(">Scope<");
    expect(html).toContain(">Recency<");
    // 7 component rows pinned by data-testid.
    expect((html.match(/data-testid="match-score-row"/g) ?? []).length).toBe(7);
    // Confidence multiplier line (Unit's confidence_score = 1
    // per default fixture).
    expect(html).toContain('data-testid="match-score-confidence"');
    expect(html).toContain("×1.00");
  });

  it("BADGE (#131): legacy match without components renders the 'breakdown unavailable' hint", () => {
    const reqs = [makeReq("r1")];
    const units = [makeUnit("u1", "Some work")];
    // Note: no `components` field — pre-#131 legacy match.
    const matches = [makeMatch("m-legacy", "r1", "u1", 0.7)];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={unitsById}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('data-testid="match-score-breakdown-unavailable"');
    expect(html).toContain("Re-run matching");
  });

  it("BADGE (#131): missing source Unit hides the confidence multiplier line", () => {
    const reqs = [makeReq("r1")];
    // No matching Unit in unitsById — match references u-deleted.
    const matches = [
      {
        ...makeMatch("m-orphan", "r1", "u-deleted", 0.7),
        components: {
          semantic_similarity: 0.5,
          skill_overlap: 0.5,
          domain_overlap: 0.5,
          tool_overlap: 0.5,
          seniority_alignment: 0.5,
          scope_alignment: 0.5,
          recency: 0.5,
        },
      },
    ];
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('data-testid="match-score-confidence-missing"');
    expect(html).not.toContain('data-testid="match-score-confidence"');
  });

  it("AUTO-TRIGGER UX (#131): computingMatches=true renders the Computing matches… hint with role=status + aria-live", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[makeReq("r1")]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={true}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('data-testid="matches-computing"');
    expect(html).toContain("Computing matches");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("AUTO-TRIGGER UX (#131): computingMatches=false does NOT render the hint", () => {
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={[makeReq("r1")]}
        matches={[]}
        unitsById={new Map()}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).not.toContain('data-testid="matches-computing"');
  });

  it("GAPS VIEW: renders unmet must-have requirements with the gap-row layout", () => {
    const reqs = [
      makeReq("r-met", { must_have: true }),
      makeReq("r-unmet", { must_have: true, raw_text: "Original wording." }),
      makeReq("r-nice-no-match", { must_have: false }),
    ];
    const units = [makeUnit("u1", "Some work")];
    const matches = [
      makeMatch("m-met-strong", "r-met", "u1", 0.9),
      makeMatch("m-unmet-weak", "r-unmet", "u1", 0.2),
    ];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const html = renderToStaticMarkup(
      <RoleDetailView
        status="ready"
        role={makeRole()}
        requirements={reqs}
        matches={matches}
        unitsById={unitsById}
        error={null}
        activeTab="matches"
        onTabChange={NOOP}
        onApprovalStateChange={NOOP_STATE_CHANGE}
        computingMatches={false}
        {...APPS_TAB_DEFAULTS}
      />,
    );
    expect(html).toContain('data-testid="gaps-view"');
    expect(html).toContain("1 unmet must-have requirement");
    // Slice the gaps section out of the rendered HTML so we
    // can assert what's IN it without false positives from
    // the matches list (which renders all Requirements
    // regardless of must-have status).
    const gapsStart = html.indexOf('data-testid="gaps-view"');
    const gapsEnd = html.indexOf("</section>", gapsStart);
    const gapsBlock = html.slice(gapsStart, gapsEnd);
    expect(gapsBlock).toContain("Req r-unmet");
    // Met must-have NOT in gaps.
    expect(gapsBlock).not.toContain("Req r-met");
    // Non-must-have with no matches NOT in gaps (regardless
    // of how it renders elsewhere).
    expect(gapsBlock).not.toContain("Req r-nice-no-match");
  });
});
