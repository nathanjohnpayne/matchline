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

    // Tag fields rendered as newline-delimited <textarea> (one
    // per line). Comma was lossy for values containing commas
    // like "Sales, Marketing" — nathanpayne-codex Phase 4b.
    expect(html).toContain('data-field="skills"');
    expect(html).toMatch(
      /<textarea[^>]*data-field="skills"[^>]*>sql\npython<\/textarea>/,
    );
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

  it("tag values containing commas round-trip through the textarea (regression: #90 Phase 4b)", () => {
    // Previously the form used comma-delimited tags, which was
    // lossy for values like "Sales, Marketing" (a legit domain).
    // Newline-delimited preserves commas verbatim. Pin the
    // textarea's joined content to show the value survives.
    const u = unit({
      id: "x",
      skills: ["PlayStation 4, 5", "sql"],
      domains: ["Sales, Marketing"],
    });
    const html = render(draftOf(u), "editing");
    expect(html).toMatch(
      /<textarea[^>]*data-field="skills"[^>]*>PlayStation 4, 5\nsql<\/textarea>/,
    );
    expect(html).toMatch(
      /<textarea[^>]*data-field="domains"[^>]*>Sales, Marketing<\/textarea>/,
    );
  });

  it("disables the end-date input when start is empty (prevents invalid {start: ''} shape)", () => {
    // nathanpayne-codex Phase 4b caught that setDateEnd could
    // construct { start: "", end: value } when the user typed
    // end without start — violating the DateRange type. Backstop:
    // the template disables end when start is empty.
    const u = unit({ id: "x" }); // no date_range
    const html = render(draftOf(u), "editing");
    const dateInputs = html.match(/<input[^>]*type="date"[^>]*>/g) ?? [];
    expect(dateInputs).toHaveLength(2);
    // Start (first date input) must NOT be disabled. End (second)
    // MUST be disabled when start is empty.
    expect(dateInputs[0]!).not.toMatch(/disabled/);
    expect(dateInputs[1]!).toMatch(/disabled/);
  });

  it("end-date input is NOT disabled when start is set (user can type end)", () => {
    const u = unit({ id: "x", date_range: { start: "2024-01-01" } });
    const html = render(draftOf(u), "editing");
    // The start input has value=2024-01-01 and is not disabled;
    // the end input has value="" and is NOT disabled (saving is
    // false, start is set).
    const dateInputs = html.match(/<input[^>]*type="date"[^>]*>/g) ?? [];
    expect(dateInputs).toHaveLength(2);
    // Neither should carry disabled in editing mode with start set.
    for (const input of dateInputs) {
      expect(input).not.toMatch(/disabled/);
    }
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
