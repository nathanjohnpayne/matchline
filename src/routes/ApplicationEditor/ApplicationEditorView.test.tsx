import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";
import type {
  Application,
  AssetRef,
  GeneratedAssetContent,
  ValidationFlag,
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

  it("renders bullets as ClaimAnnotations with a 1px underline + closed popover when source_unit_ids is non-empty (sub-issue #185 design refactor)", () => {
    // Per `docs/design/ui-guidance.md` § Application Editor: claims
    // are subtly underlined where a source-Unit reference is
    // attached. The pre-#185 chip-pill rendering is replaced by
    // ClaimAnnotation: an underlined inline span that opens a
    // popover on click. Popover is always in DOM (visibility
    // gated by React state via class) so static markup can find
    // the closed-state attributes.
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
    // ClaimAnnotation present with the right source-unit count.
    expect(html).toContain('data-testid="claim-annotation"');
    expect(html).toContain('data-source-unit-count="2"');
    // Popover always rendered in DOM (closed-state visibility);
    // contains the source Unit summaries even before click.
    expect(html).toContain('data-popover-open="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('data-source-unit-id="unit-a"');
    expect(html).toContain('data-source-unit-id="unit-b"');
    expect(html).toContain('data-source-resolved="true"');
    expect(html).toContain("CTV streaming launch.");
    expect(html).toContain("Rebuffer reduction work.");
  });

  it("wires bidirectional hover-highlight attributes (sub-issue #185 design AC)", () => {
    // On a fresh mount, no claim is hovered and no Unit is hovered.
    // Both panes should expose `data-bullet-highlighted="false"`
    // and `data-unit-highlighted="false"` so the highlight
    // mechanism is observable + testable. The actual hover
    // event behavior is exercised via hand-testing per the route
    // convention.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({ approved_unit_ids: ["u-a"] })}
        asset={asset({
          generated_content: content({
            bullets: [
              { id: "b1", text: "Bullet.", source_unit_ids: ["u-a"] },
            ],
          }),
        })}
        units={[unit({ id: "u-a", normalized_summary: "Cited." })]}
      />,
    );
    expect(html).toContain('data-bullet-highlighted="false"');
    expect(html).toContain('data-unit-highlighted="false"');
    // The right-pane row is keyboard-focusable so the
    // bidirectional hover works for keyboard users too
    // (focus = hover for the highlight purpose).
    expect(html).toMatch(/data-unit-id="u-a"[^>]*tabIndex="0"|tabindex="0"/i);
  });

  it("renders plain text without an annotation when source_unit_ids is empty", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          generated_content: content({
            bullets: [
              { id: "b1", text: "Ungrounded bullet.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
      />,
    );
    expect(html).toContain("Ungrounded bullet.");
    expect(html).not.toContain('data-testid="claim-annotation"');
  });

  it("falls back to a missing-Unit popover entry when source_unit_ids reference deleted Units", () => {
    // Defense against "Unit deleted post-generation" — the
    // generated content still references the id, and the
    // ClaimAnnotation popover must be honest about the dangling
    // reference rather than silently dropping it. Sub-issue #186
    // (flag underlines) will separately surface a flag on the
    // bullet itself; this is the popover-level fallback.
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

  it("uses singular noun + verb agreement when exactly one Unit is linked", () => {
    // Pluralization + verb agreement: "1 approved Unit was used"
    // (CodeRabbit Minor on PR 181: prior copy rendered "1 approved
    // Unit were used" with mismatched verb).
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({ approved_unit_ids: ["unit-a"] })}
        asset={asset()}
        units={[unit({ id: "unit-a" })]}
      />,
    );
    expect(html).toContain("1 approved Unit was used");
    expect(html).not.toMatch(/1 approved Units/);
    expect(html).not.toMatch(/1 approved Unit\s+were used/);
  });

  it("uses plural noun + verb agreement when multiple Units are linked", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({ approved_unit_ids: ["unit-a", "unit-b"] })}
        asset={asset()}
        units={[unit({ id: "unit-a" }), unit({ id: "unit-b" })]}
      />,
    );
    expect(html).toContain("2 approved Units were used");
  });

  it("de-duplicates approved_unit_ids before rendering the right pane (no duplicate keys, accurate count)", () => {
    // CodeRabbit Minor on PR #181: nothing in the schema
    // disallows duplicates in approved_unit_ids; without dedupe,
    // the right pane would render duplicate `key={unit.id}` <li>s
    // and the count copy would inflate.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application({
          approved_unit_ids: ["unit-a", "unit-a", "unit-b"],
        })}
        asset={asset()}
        units={[
          unit({ id: "unit-a", normalized_summary: "Cited Unit A." }),
          unit({ id: "unit-b", normalized_summary: "Cited Unit B." }),
        ]}
      />,
    );
    const aHits = html.match(/data-unit-id="unit-a"/g) ?? [];
    const bHits = html.match(/data-unit-id="unit-b"/g) ?? [];
    expect(aHits).toHaveLength(1);
    expect(bHits).toHaveLength(1);
    // Count copy reflects the deduped count, not the raw array length.
    expect(html).toContain("2 approved Units were used");
  });

  it("renders the empty Units pane when application is missing approved_unit_ids (legacy doc)", () => {
    // Legacy compatibility (Codex P1 on PR #181): the server-side
    // generation pipeline reads `approved_unit_ids` with `?? []`
    // because pre-pipeline Application docs may omit the field.
    // The view must defend at the read site so the route doesn't
    // crash with `undefined.map is not a function`.
    const legacy = {
      ...application(),
      approved_unit_ids: undefined as unknown as string[],
    };
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={legacy}
        asset={asset()}
        units={[unit({ id: "unit-a" })]}
      />,
    );
    expect(html).toContain('data-testid="application-editor"');
    expect(html).toContain("No Units linked to this Application yet.");
    expect(html).not.toContain('data-testid="units-list"');
  });

  // ── PR 2: validation flag badges, popover, export gate ──────────

  function flag(
    partial: Partial<ValidationFlag> & { id: string },
  ): ValidationFlag {
    return {
      asset_id: "asset",
      bullet_id: "bullet-1",
      claim_id: "claim",
      status: "untraceable",
      rationale: "no supporting Unit",
      created_at: "2026-04-01T00:00:00.000Z",
      ...partial,
    };
  }

  it("renders a flag badge on a flagged bullet, with the rationale visible in the popover markup", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "failed",
          validation_flags: [
            flag({
              id: "f1",
              bullet_id: "b1",
              status: "untraceable",
              rationale: "Bullet references a Unit no longer present.",
            }),
          ],
          generated_content: content({
            bullets: [
              { id: "b1", text: "Flagged bullet.", source_unit_ids: [] },
              { id: "b2", text: "Clean bullet.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
      />,
    );
    // Badge rendered for the flagged bullet only.
    const badges = html.match(/data-testid="flag-badge"/g) ?? [];
    expect(badges).toHaveLength(1);
    expect(html).toContain('data-flag-status="untraceable"');
    expect(html).toContain("Bullet references a Unit no longer present.");
    // The popover always present in the DOM (CSS visibility, not
    // conditional render) so screen readers and tests can find it.
    expect(html).toContain('data-testid="flag-popover"');
  });

  it("surfaces the worst flag status when a single bullet has both untraceable and specificity", () => {
    // Specificity (red) beats untraceable (amber) — the badge
    // shows the harder problem so the user attends to that first.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "failed",
          validation_flags: [
            flag({ id: "f1", bullet_id: "b1", status: "untraceable" }),
            flag({ id: "f2", bullet_id: "b1", status: "specificity" }),
          ],
          generated_content: content({
            bullets: [
              { id: "b1", text: "Multi-flag bullet.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
      />,
    );
    expect(html).toContain('data-flag-status="specificity"');
    expect(html).toContain('data-flag-count="2"');
  });

  it("renders Remove on bullet/skill/education badges and hides Remove on the summary badge", () => {
    // Removing the summary would corrupt the asset shape; the badge
    // hides the button rather than disabling it (a non-functional
    // control would just confuse the user).
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "failed",
          validation_flags: [
            flag({ id: "f-sum", bullet_id: "summary" }),
            flag({ id: "f-bul", bullet_id: "b1" }),
          ],
          generated_content: content({
            summary: {
              id: "summary",
              text: "Flagged summary.",
              source_unit_ids: [],
            },
            bullets: [
              { id: "b1", text: "Flagged bullet.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
        onRemoveBullet={() => undefined}
        onAddSupportingUnit={() => undefined}
      />,
    );
    // Both badges present (summary + bullet).
    const badges = html.match(/data-testid="flag-badge"/g) ?? [];
    expect(badges).toHaveLength(2);
    // Remove button appears for the bullet badge but not the
    // summary badge — count occurrences of the action attribute.
    const removeButtons = html.match(/data-action="remove-bullet"/g) ?? [];
    expect(removeButtons).toHaveLength(1);
    // Add-Unit appears on every flagged item.
    const addButtons =
      html.match(/data-action="add-supporting-unit"/g) ?? [];
    expect(addButtons).toHaveLength(2);
  });

  it("does not render flag badges on items that have no flags", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "passed",
          validation_flags: [],
          generated_content: content({
            bullets: [
              { id: "b1", text: "Clean bullet.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
      />,
    );
    expect(html).not.toContain('data-testid="flag-badge"');
  });

  it("does not render badges for 'traced' flags (those passed validation)", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "passed",
          validation_flags: [
            flag({
              id: "f-traced",
              bullet_id: "b1",
              status: "traced",
              supporting_unit_id: "unit-x",
            }),
          ],
          generated_content: content({
            bullets: [
              { id: "b1", text: "Successfully traced.", source_unit_ids: ["unit-x"] },
            ],
          }),
        })}
        units={[]}
      />,
    );
    expect(html).not.toContain('data-testid="flag-badge"');
  });

  it("renders the export button DISABLED with a flag-count tooltip when validation_status === 'failed'", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "failed",
          validation_flags: [
            flag({ id: "f1", bullet_id: "b1", status: "untraceable" }),
            flag({ id: "f2", bullet_id: "b2", status: "specificity" }),
          ],
          generated_content: content({
            bullets: [
              { id: "b1", text: "Bullet 1.", source_unit_ids: [] },
              { id: "b2", text: "Bullet 2.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
      />,
    );
    expect(html).toContain('data-testid="export-button"');
    expect(html).toContain('data-export-enabled="false"');
    expect(html).toContain("disabled=");
    expect(html).toContain("Resolve 2 validation flags");
  });

  it("renders the export button ENABLED when validation_status === 'passed' AND onExport is wired", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({ validation_status: "passed", validation_flags: [] })}
        units={[]}
        onExport={() => undefined}
      />,
    );
    expect(html).toContain('data-export-enabled="true"');
    expect(html).not.toContain("Resolve 0 validation flags");
    expect(html).not.toContain("Export is not available yet.");
  });

  it("export button is disabled for pending and stale states with appropriate copy", () => {
    const pending = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({ validation_status: "pending" })}
        units={[]}
      />,
    );
    expect(pending).toContain('data-export-enabled="false"');
    expect(pending).toContain("Validation hasn");

    const stale = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({ validation_status: "stale" })}
        units={[]}
      />,
    );
    expect(stale).toContain('data-export-enabled="false"');
    expect(stale).toContain("Re-run validation");
  });

  it("renders the export button DISABLED when validation passes but no onExport handler is wired", () => {
    // Defense against silent-no-op primary action: even with
    // status="passed", the button must NOT look enabled if the
    // container hasn't wired a click handler. CodeRabbit Major
    // on PR #182.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({ validation_status: "passed", validation_flags: [] })}
        units={[]}
        // onExport intentionally omitted
      />,
    );
    expect(html).toContain('data-export-enabled="false"');
    expect(html).toContain("Export is not available yet.");
  });

  it("hides Remove on the popover when onRemoveBullet handler is absent (no silent no-ops)", () => {
    // A bullet/skill/education flag could be rendered without a
    // wired onRemoveBullet (legacy view callers). The popover must
    // not render a functional-looking Remove button in that case.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "failed",
          validation_flags: [
            flag({ id: "f1", bullet_id: "b1" }),
          ],
          generated_content: content({
            bullets: [
              { id: "b1", text: "Flagged.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
        // onRemoveBullet intentionally omitted
        onAddSupportingUnit={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="flag-badge"');
    expect(html).not.toContain('data-action="remove-bullet"');
  });

  it("hides Add a supporting Unit on the popover when handler is absent", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "failed",
          validation_flags: [
            flag({ id: "f1", bullet_id: "b1" }),
          ],
          generated_content: content({
            bullets: [
              { id: "b1", text: "Flagged.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
        // onAddSupportingUnit intentionally omitted
      />,
    );
    expect(html).toContain('data-testid="flag-badge"');
    expect(html).not.toContain('data-action="add-supporting-unit"');
  });

  it("uses role='dialog' (not role='tooltip') on the flag popover so interactive controls inside are ARIA-valid", () => {
    // WAI-ARIA APG forbids interactive controls inside role=tooltip;
    // the popover hosts three resolution buttons. CodeRabbit Major
    // on PR #182.
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={asset({
          validation_status: "failed",
          validation_flags: [flag({ id: "f1", bullet_id: "b1" })],
          generated_content: content({
            bullets: [
              { id: "b1", text: "Flagged.", source_unit_ids: [] },
            ],
          }),
        })}
        units={[]}
        onRemoveBullet={() => undefined}
        onAddSupportingUnit={() => undefined}
      />,
    );
    // Popover present with the dialog role + aria-modal="false".
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    // No tooltip role on the popover (MatchScoreBadge legitimately
    // uses role=tooltip; this surface specifically must not).
    expect(html).not.toMatch(
      /data-testid="flag-popover"[^>]*role="tooltip"/,
    );
  });

  it("does not render the export button when there is no asset (the empty resume pane has nothing to export)", () => {
    const html = renderToStaticMarkup(
      <ApplicationEditorView
        status="ready"
        application={application()}
        asset={null}
        units={[]}
      />,
    );
    expect(html).not.toContain('data-testid="export-button"');
    expect(html).toContain('data-testid="resume-pane-empty"');
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
