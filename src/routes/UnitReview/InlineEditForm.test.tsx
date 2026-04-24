import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import InlineEditForm from "./InlineEditForm.tsx";
import {
  editableFromUnit,
  type EditableUnitFields,
} from "./inlineEditState.ts";

import type { ExperienceUnit } from "../../types/capability.ts";

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

function render(
  draft: EditableUnitFields,
  status: "editing" | "saving" | "error",
  error?: Error | null,
): string {
  return renderToStaticMarkup(
    <InlineEditForm
      draft={draft}
      onChange={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
      status={status}
      error={error ?? null}
    />,
  );
}

describe("InlineEditForm", () => {
  it("renders all text/select/tag/date/metric fields in editing mode", () => {
    const u = unit({
      id: "x",
      raw_text: "raw body here",
      normalized_summary: "normalized summary",
      source_type: "linkedin",
      source_ref: "profile.html",
      unit_type: "project",
      skills: ["sql", "python"],
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
    const html = render(draftOf(u), "editing");

    // Text values present
    expect(html).toContain("raw body here");
    expect(html).toContain("normalized summary");
    expect(html).toContain('value="profile.html"');

    // Tag fields rendered as comma-joined
    expect(html).toContain('data-field="skills"');
    expect(html).toContain('value="sql, python"');
    expect(html).toContain('data-field="tools"');
    expect(html).toContain('data-field="domains"');
    expect(html).toContain('data-field="seniority_signals"');
    expect(html).toContain('data-field="scope_signals"');
    expect(html).toContain('data-field="business_outcomes"');

    // Selects with current selection
    // The form uses `value=` on select, which renderToStaticMarkup
    // materializes as `selected` on the chosen option.
    expect(html).toContain('<option value="linkedin" selected="">linkedin</option>');
    expect(html).toContain('<option value="project" selected="">project</option>');
    expect(html).toContain(
      '<option value="user_confirmed" selected="">user_confirmed</option>',
    );

    // Dates
    expect(html).toContain('value="2023-01-01"');
    expect(html).toContain('value="2023-06-01"');

    // Confidence
    expect(html).toContain('value="0.9"');

    // Metrics nested editor
    expect(html).toContain('data-field="metrics"');
    expect(html).toContain('value="40M users"');

    // Edit state marker
    expect(html).toContain('data-edit-state="editing"');
  });

  it("renders the Save button as 'Save' in editing mode", () => {
    const html = render(draftOf(unit({ id: "x" })), "editing");
    expect(html).toContain('data-action="save"');
    expect(html).toContain(">Save</button>");
  });

  it("renders 'Saving…' on the Save button and disables inputs in saving mode", () => {
    const html = render(draftOf(unit({ id: "x" })), "saving");
    // React 19 encodes the ellipsis literally in the rendered HTML
    expect(html).toMatch(/Saving(&hellip;|…)<\/button>/);
    // data-edit-state reflects the status
    expect(html).toContain('data-edit-state="saving"');
    // And the inputs carry disabled — spot-check the raw_text textarea
    expect(html).toMatch(/<textarea[^>]*disabled[^>]*>raw<\/textarea>/);
  });

  it("renders the error alert and 'Retry save' button in error mode", () => {
    const err = new Error("Network failed");
    const html = render(draftOf(unit({ id: "x" })), "error", err);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Network failed");
    expect(html).toContain("Retry save");
    expect(html).toContain('data-edit-state="error"');
  });

  it("does NOT render the error alert when status is editing (even if error prop is stale)", () => {
    // If a caller passed an error object through while the status
    // transitioned back to "editing" (user started typing after an
    // error), the alert must NOT render — the error state was
    // dismissed by the transition. Pin so a future refactor can't
    // accidentally render the alert on any truthy error prop.
    const html = render(
      draftOf(unit({ id: "x" })),
      "editing",
      new Error("Stale error from prior attempt"),
    );
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Stale error");
  });

  it("shows empty metrics placeholder copy when there are no metrics", () => {
    const html = render(draftOf(unit({ id: "x", metrics: [] })), "editing");
    expect(html).toContain("No metrics on this Unit.");
  });

  it("shows the metrics list when there are metrics", () => {
    const html = render(
      draftOf(
        unit({
          id: "x",
          metrics: [
            { claim: "A", confidence: "high" },
            { claim: "B", value: 3.14, unit: "ms", direction: "down", confidence: "medium" },
          ],
        }),
      ),
      "editing",
    );
    expect(html).toContain('value="A"');
    expect(html).toContain('value="B"');
    expect(html).toContain('value="3.14"');
    expect(html).toContain('value="ms"');
    // Direction option "down" selected
    expect(html).toContain('<option value="down" selected="">down</option>');
    expect(html).toContain(
      '<option value="medium" selected="">medium</option>',
    );
  });

  it("renders an empty date input for a Unit without a date_range", () => {
    const html = render(draftOf(unit({ id: "x" })), "editing");
    // Two date inputs, both value="" — the browser renders these
    // as blank date pickers.
    const dateInputs = html.match(/<input[^>]*type="date"[^>]*>/g) ?? [];
    expect(dateInputs.length).toBe(2);
    for (const input of dateInputs) {
      expect(input).toContain('value=""');
    }
  });
});
