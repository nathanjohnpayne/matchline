import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";
import type {
  Application,
  AssetRef,
  GeneratedAssetContent,
} from "../../types/crm.ts";

import ApplicationEditorView from "./ApplicationEditorView.tsx";

/**
 * Static render of the presentational view. Same convention as
 * UnitReviewView.test.tsx (#86): the view is pure with respect to
 * props, so `renderToStaticMarkup` is sufficient to exercise every
 * rendering branch. Subscription logic lives in the container
 * (`index.tsx`); it's exercised by hand against the live app per
 * the existing route-test pattern (no Playwright in V1).
 */

function unit(partial: Partial<ExperienceUnit> & { id: string }): ExperienceUnit {
  const defaults: Omit<ExperienceUnit, "id"> = {
    owner_uid: "u",
    source_type: "resume",
    source_ref: "resume.pdf · line 12",
    raw_text: "raw",
    normalized_summary: `Summary of ${partial.id}`,
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
    user_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  return { ...defaults, ...partial };
}

function content(
  partial: Partial<GeneratedAssetContent> = {},
): GeneratedAssetContent {
  return {
    summary: { id: "summary", text: "Summary text.", source_unit_ids: [] },
    bullets: [],
    skills: [],
    ...partial,
  };
}

function asset(partial: Partial<AssetRef> = {}): AssetRef {
  const defaults: Omit<AssetRef, "id"> = {
    owner_uid: "u",
    application_id: "app",
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: content(),
    validation_status: "pending",
    created_at: "2026-04-01T00:00:00.000Z",
  };
  return { id: "asset", ...defaults, ...partial };
}

function application(partial: Partial<Application> = {}): Application {
  return {
    id: "app",
    owner_uid: "u",
    role_id: "role",
    stage: "drafting",
    last_activity_at: "2026-04-01T00:00:00.000Z",
    generated_assets: [],
    approved_unit_ids: [],
    ...partial,
  };
}

describe("ApplicationEditorView", () => {
  it("renders a loading state when status is 'loading' (NOT the empty state, NOT the editor)", () => {
    // Three-way load discriminator regression pin (matches #86's
    // contract): a fresh mount must not render an "empty" or
    // "ready" surface before the first snapshot resolves.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="loading"
        application={null}
        asset={null}
        units={[]}
      />,
    );
    expect(html).toContain('data-load-state="loading"');
    expect(html).toContain("Loading Application");
    expect(html).not.toContain('data-testid="application-editor"');
    expect(html).not.toContain("Application not found");
  });

  it("renders the error alert when status is 'error'", () => {
    const err = new Error("Permission denied");
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="error"
        application={null}
        asset={null}
        units={[]}
        error={err}
      />,
    );
    expect(html).toContain('data-load-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Permission denied");
    // The editor itself must NOT render under the error banner.
    expect(html).not.toContain('data-testid="application-editor"');
    expect(html).not.toContain("Loading Application");
  });

  it("renders the not-found surface when status is 'ready' AND application is null", () => {
    // Anti-enumeration mirror: missing-OR-not-yours collapses to a
    // single user-facing message, same shape as RoleDetail (#129).
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={null}
        asset={null}
        units={[]}
      />,
    );
    expect(html).toContain('data-testid="application-editor-not-found"');
    expect(html).toContain("Application not found, or not owned by you.");
    expect(html).not.toContain('data-testid="application-editor"');
  });

  it("renders the editor shell with id when application is present and ready", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({ id: "app-123" })}
        asset={null}
        units={[]}
      />,
    );
    expect(html).toContain('data-testid="application-editor"');
    expect(html).toContain('data-load-state="ready"');
    expect(html).toContain('data-testid="application-id"');
    expect(html).toContain("app-123");
  });

  it("renders the empty resume pane when no asset is selected", () => {
    // Empty pane is distinct from loading: the Application exists,
    // it just doesn't have a generated resume yet.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={null}
        units={[]}
      />,
    );
    expect(html).toContain('data-testid="resume-pane-empty"');
    expect(html).toContain("No generated resume yet.");
    expect(html).not.toContain('data-testid="resume-pane"');
  });

  it("renders the resume pane with summary, bullets, and skills sections", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          generated_content: content({
            summary: {
              id: "s",
              text: "Senior engineer with X years.",
              source_unit_ids: [],
            },
            bullets: [
              {
                id: "b1",
                text: "Shipped streaming SDK to 40M CTVs.",
                source_unit_ids: [],
              },
              {
                id: "b2",
                text: "Cut rebuffer rate from 3.1% to 0.7%.",
                source_unit_ids: [],
              },
            ],
            skills: [
              { id: "sk1", text: "TypeScript, Go, Python.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
      />,
    );
    expect(html).toContain('data-testid="resume-pane"');
    expect(html).toContain("Senior engineer with X years.");
    expect(html).toContain("Shipped streaming SDK to 40M CTVs.");
    expect(html).toContain("Cut rebuffer rate from 3.1% to 0.7%.");
    expect(html).toContain("TypeScript, Go, Python.");
    // Section headings rendered.
    expect(html).toContain("Summary");
    expect(html).toContain("Experience");
    expect(html).toContain("Skills");
  });

  it("does not render the Education section when education is undefined", () => {
    // GeneratedAssetContent.education is optional; pre-#22 (or
    // role-without-education) outputs leave it undefined. Render
    // pass must not show an empty section header.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({ generated_content: content() })}
        units={[]}
      />,
    );
    expect(html).not.toContain("Education");
    expect(html).not.toContain('data-testid="resume-education"');
  });

  it("renders source_unit_ids chips with the matched Unit's normalized_summary", () => {
    // Core PR-1 contract: every fact-bearing item on the resume
    // carries `source_unit_ids`; the editor renders them as chips
    // labeled with the Unit's normalized_summary so the user can
    // see provenance at a glance. PR 2 adds hover/click interaction.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({ approved_unit_ids: ["unit-a", "unit-b"] })}
        asset={asset({
          generated_content: content({
            bullets: [
              {
                id: "b1",
                text: "Shipped streaming SDK.",
                source_unit_ids: ["unit-a", "unit-b"],
              },
            ],
          }),
        })}
        units={[
          unit({ id: "unit-a", normalized_summary: "CTV streaming launch." }),
          unit({ id: "unit-b", normalized_summary: "Rebuffer reduction work." }),
        ]}
      />,
    );
    expect(html).toContain('data-source-unit-id="unit-a"');
    expect(html).toContain('data-source-unit-id="unit-b"');
    expect(html).toContain('data-source-resolved="true"');
    expect(html).toContain("CTV streaming launch.");
    expect(html).toContain("Rebuffer reduction work.");
  });

  it("falls back to a missing-Unit chip when source_unit_ids reference deleted Units", () => {
    // Defense against "Unit deleted post-generation" — the
    // generated content still references the id, and the chip
    // surface must be honest about the dangling reference rather
    // than silently dropping it. PR 2's validation layer will
    // separately render a flag on the bullet itself; this is the
    // chip-level fallback.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          generated_content: content({
            bullets: [
              {
                id: "b1",
                text: "Bullet referencing a missing Unit.",
                source_unit_ids: ["ghost-unit"],
              },
            ],
          }),
        })}
        units={[]}
      />,
    );
    expect(html).toContain('data-source-unit-id="ghost-unit"');
    expect(html).toContain('data-source-resolved="false"');
    expect(html).toContain("(missing Unit)");
  });

  it("renders the right pane with only the Application's approved_unit_ids", () => {
    // The right pane is the snapshot of which Units this
    // Application was generated against — NOT the user's full
    // owner-scoped set. Cluttering the pane with un-cited Units
    // would obscure the per-application traceability story.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({ approved_unit_ids: ["unit-a"] })}
        asset={asset()}
        units={[
          unit({ id: "unit-a", normalized_summary: "Cited Unit." }),
          unit({ id: "unit-b", normalized_summary: "Other approved Unit." }),
        ]}
      />,
    );
    expect(html).toContain('data-unit-id="unit-a"');
    expect(html).toContain("Cited Unit.");
    expect(html).not.toContain('data-unit-id="unit-b"');
    expect(html).not.toContain("Other approved Unit.");
  });

  it("renders the right pane's empty state when no Units are linked to the Application", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({ approved_unit_ids: [] })}
        asset={asset()}
        units={[unit({ id: "unit-a" })]}
      />,
    );
    expect(html).toContain('data-testid="units-pane"');
    expect(html).toContain("No Units linked to this Application yet.");
    expect(html).not.toContain('data-testid="units-list"');
  });

  it("uses a singular 'Unit' label when exactly one Unit is linked", () => {
    // Pluralization correctness: "1 approved Unit" not "1 approved Units".
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({ approved_unit_ids: ["unit-a"] })}
        asset={asset()}
        units={[unit({ id: "unit-a" })]}
      />,
    );
    expect(html).toContain("1 approved Unit ");
    expect(html).not.toMatch(/1 approved Units/);
  });

  it("falls back to a generic error message when status is 'error' but error is null", () => {
    // Defensive: if the container fires setStatus("error") without
    // also setting an error object, the alert still renders rather
    // than a hanging colon.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="error"
        application={null}
        asset={null}
        units={[]}
        error={null}
      />,
    );
    expect(html).toContain("Couldn");
    // No trailing "...: " from a missing message.
    expect(html).not.toMatch(/Application:\s*<\//);
  });
});
