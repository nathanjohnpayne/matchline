import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ManualAddForm, {
  applyDateStartChange,
  toManualUnitInput,
  validateForm,
} from "./ManualAddForm.tsx";

/**
 * Tests cover three layers:
 *
 *   1. `validateForm` — pure validation rules (required fields,
 *      date-range invariant, confidence range).
 *   2. `toManualUnitInput` — pure form-state → service-input
 *      transformation, exercising the omit-empty conventions.
 *   3. Initial-render branches via `renderToStaticMarkup`. The
 *      submit/close interactions (state transitions, error
 *      surfacing on rejected promises) are exercised by code
 *      review at the route layer; the load-bearing logic is
 *      already in the pure helpers.
 */

const VALID_FORM = {
  raw_text: "Drove a re-platform across CTV devices.",
  normalized_summary: "Re-platformed playback SDK across CTV.",
  unit_type: "achievement" as const,
  source_ref: "",
  skills: "",
  tools: "",
  domains: "",
  seniority_signals: "",
  scope_signals: "",
  business_outcomes: "",
  date_start: "",
  date_end: "",
  confidence_score: "1",
  metrics: [],
};

describe("validateForm", () => {
  it("accepts a minimal valid form", () => {
    const errors = validateForm(VALID_FORM);
    expect(errors).toEqual({});
  });

  it("rejects empty raw_text", () => {
    expect(validateForm({ ...VALID_FORM, raw_text: "" })).toEqual({
      raw_text: expect.stringMatching(/required/i),
    });
  });

  it("rejects whitespace-only raw_text (trim before length check)", () => {
    expect(validateForm({ ...VALID_FORM, raw_text: "   " })).toEqual({
      raw_text: expect.stringMatching(/required/i),
    });
  });

  it("rejects empty normalized_summary", () => {
    expect(
      validateForm({ ...VALID_FORM, normalized_summary: "" }),
    ).toEqual({ normalized_summary: expect.stringMatching(/required/i) });
  });

  it("rejects an invalid unit_type (regression: #339)", () => {
    expect(
      validateForm({
        ...VALID_FORM,
        unit_type: "not_a_real_type" as unknown as (typeof VALID_FORM)["unit_type"],
      }),
    ).toEqual({ unit_type: expect.stringMatching(/unit type/i) });
  });

  it("rejects end_date without start_date (DateRange invariant)", () => {
    // Same invariant `InlineEditForm` enforces — end alone is
    // not a valid range. nathanpayne-codex Phase 4b on #90
    // caught this in the inline-edit form; same fix here.
    expect(
      validateForm({
        ...VALID_FORM,
        date_start: "",
        date_end: "2024-06-01",
      }),
    ).toEqual({ date_range: expect.stringMatching(/start/i) });
  });

  it("accepts start_date alone (ongoing range)", () => {
    expect(
      validateForm({
        ...VALID_FORM,
        date_start: "2024-01-01",
        date_end: "",
      }),
    ).toEqual({});
  });

  it("accepts both start_date and end_date", () => {
    expect(
      validateForm({
        ...VALID_FORM,
        date_start: "2024-01-01",
        date_end: "2024-06-01",
      }),
    ).toEqual({});
  });

  it("rejects confidence_score outside [0, 1]", () => {
    expect(
      validateForm({ ...VALID_FORM, confidence_score: "1.5" }),
    ).toEqual({ confidence_score: expect.stringMatching(/0 and 1/i) });
    expect(
      validateForm({ ...VALID_FORM, confidence_score: "-0.1" }),
    ).toEqual({ confidence_score: expect.stringMatching(/0 and 1/i) });
  });

  it("rejects non-numeric confidence_score", () => {
    expect(
      validateForm({ ...VALID_FORM, confidence_score: "abc" }),
    ).toEqual({ confidence_score: expect.stringMatching(/0 and 1/i) });
  });

  it("rejects empty confidence_score (regression: CodeRabbit Major on #94)", () => {
    // Empty string would coerce to 0 via Number(""), silently
    // writing confidence_score: 0 to Firestore — almost
    // certainly NOT what the user intended when they cleared
    // the field. Validation rejects empty so the user has to
    // put a number back in.
    expect(
      validateForm({ ...VALID_FORM, confidence_score: "" }),
    ).toEqual({ confidence_score: expect.stringMatching(/required/i) });
  });

  it("rejects whitespace-only confidence_score (same coercion-to-0 trap)", () => {
    // `Number("   ")` is 0 too. Trim before length check so a
    // user who typed spaces and then deleted the digits hits
    // the same required-field error.
    expect(
      validateForm({ ...VALID_FORM, confidence_score: "   " }),
    ).toEqual({ confidence_score: expect.stringMatching(/required/i) });
  });

  it("accepts confidence_score with leading/trailing whitespace around a valid number", () => {
    // Trim is consistent: " 0.5 " is valid via the trim path.
    expect(
      validateForm({ ...VALID_FORM, confidence_score: " 0.5 " }),
    ).toEqual({});
  });

  it("returns multiple errors when multiple fields are invalid", () => {
    const errors = validateForm({
      ...VALID_FORM,
      raw_text: "",
      normalized_summary: "",
    });
    expect(errors.raw_text).toBeDefined();
    expect(errors.normalized_summary).toBeDefined();
  });
});

describe("toManualUnitInput", () => {
  it("trims raw_text and normalized_summary", () => {
    const input = toManualUnitInput({
      ...VALID_FORM,
      raw_text: "  hello  ",
      normalized_summary: "  world  ",
    });
    expect(input.raw_text).toBe("hello");
    expect(input.normalized_summary).toBe("world");
  });

  it("converts confidence_score from string to number", () => {
    const input = toManualUnitInput({
      ...VALID_FORM,
      confidence_score: "0.85",
    });
    expect(input.confidence_score).toBe(0.85);
  });

  it("omits empty array fields rather than including empty arrays", () => {
    // `buildManualUnit` defaults absent keys to []; including
    // empty arrays here would force-overwrite future widening
    // of the default. Cleaner to omit and let the service
    // apply defaults uniformly.
    const input = toManualUnitInput(VALID_FORM);
    expect("skills" in input).toBe(false);
    expect("tools" in input).toBe(false);
    expect("domains" in input).toBe(false);
    expect("metrics" in input).toBe(false);
  });

  it("parses newline-delimited tag fields", () => {
    const input = toManualUnitInput({
      ...VALID_FORM,
      skills: "sql\npython\nPlayStation 4, 5",
      tools: "snowflake",
    });
    expect(input.skills).toEqual(["sql", "python", "PlayStation 4, 5"]);
    expect(input.tools).toEqual(["snowflake"]);
  });

  it("trims and drops empty lines in tag parsing", () => {
    const input = toManualUnitInput({
      ...VALID_FORM,
      skills: "  sql  \n\n   \n python ",
    });
    expect(input.skills).toEqual(["sql", "python"]);
  });

  it("omits source_ref when empty (service applies 'manual entry' default)", () => {
    const input = toManualUnitInput({ ...VALID_FORM, source_ref: "" });
    expect("source_ref" in input).toBe(false);
  });

  it("includes a non-empty source_ref override", () => {
    const input = toManualUnitInput({
      ...VALID_FORM,
      source_ref: "Q3 retro doc",
    });
    expect(input.source_ref).toBe("Q3 retro doc");
  });

  it("omits date_range when start is empty", () => {
    const input = toManualUnitInput({
      ...VALID_FORM,
      date_start: "",
      date_end: "",
    });
    expect("date_range" in input).toBe(false);
  });

  it("emits date_range with start only (ongoing) when start is set", () => {
    const input = toManualUnitInput({
      ...VALID_FORM,
      date_start: "2024-01-01",
      date_end: "",
    });
    expect(input.date_range).toEqual({ start: "2024-01-01" });
  });

  it("emits date_range with start AND end when both are set", () => {
    const input = toManualUnitInput({
      ...VALID_FORM,
      date_start: "2024-01-01",
      date_end: "2024-06-01",
    });
    expect(input.date_range).toEqual({
      start: "2024-01-01",
      end: "2024-06-01",
    });
  });

  it("includes metrics when present, omits the key when the array is empty", () => {
    const withoutMetrics = toManualUnitInput(VALID_FORM);
    expect("metrics" in withoutMetrics).toBe(false);

    const withMetrics = toManualUnitInput({
      ...VALID_FORM,
      metrics: [{ claim: "40M users", confidence: "high" }],
    });
    expect(withMetrics.metrics).toEqual([
      { claim: "40M users", confidence: "high" },
    ]);
  });
});

describe("applyDateStartChange", () => {
  // Codex P2 on #94: clearing start should cascade-clear end so
  // the form can return to a valid no-date state in one click.
  // Otherwise the user is stuck with an invalid {end-only}
  // shape and the end input disabled, with no way to fix it
  // without manually clearing end too.

  it("setting a non-empty start preserves end (normal edit)", () => {
    const next = applyDateStartChange(
      {
        ...VALID_FORM,
        date_start: "2024-01-01",
        date_end: "2024-06-01",
      },
      "2024-02-01",
    );
    expect(next.date_start).toBe("2024-02-01");
    expect(next.date_end).toBe("2024-06-01");
  });

  it("clearing start ALSO clears end (regression: Codex P2 on #94)", () => {
    const next = applyDateStartChange(
      {
        ...VALID_FORM,
        date_start: "2024-01-01",
        date_end: "2024-06-01",
      },
      "",
    );
    expect(next.date_start).toBe("");
    expect(next.date_end).toBe("");
  });

  it("clearing start when end was already empty is a no-op (still empty)", () => {
    const next = applyDateStartChange(
      { ...VALID_FORM, date_start: "2024-01-01", date_end: "" },
      "",
    );
    expect(next.date_start).toBe("");
    expect(next.date_end).toBe("");
  });

  it("does not mutate non-date fields", () => {
    const base = {
      ...VALID_FORM,
      raw_text: "abc",
      skills: "sql",
      date_start: "2024-01-01",
      date_end: "2024-06-01",
    };
    const next = applyDateStartChange(base, "");
    expect(next.raw_text).toBe("abc");
    expect(next.skills).toBe("sql");
  });
});

describe("ManualAddForm initial render", () => {
  const noopSubmit = async () => {};
  const noopClose = () => {};

  it("renders as a modal dialog with role=dialog and aria-modal", () => {
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Add Unit manually"');
  });

  it("renders required-field labels with the asterisk marker", () => {
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    expect(html).toContain("Raw text *");
    expect(html).toContain("Normalized summary *");
    expect(html).toContain("Unit type *");
  });

  it("renders a submit button that says 'Add Unit' (not 'Saving') initially", () => {
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    expect(html).toContain('data-action="submit"');
    expect(html).toMatch(/data-action="submit"[^>]*>Add Unit</);
  });

  it("renders Cancel button alongside submit", () => {
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    expect(html).toContain('data-action="cancel"');
  });

  it("does NOT render validation errors on first SSR (touched=false)", () => {
    // Errors only show after the user has tried to submit. Pin
    // so a future refactor that flips the touched-default to
    // true doesn't dump red error text on initial mount.
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    expect(html).not.toContain('data-error-for="raw_text"');
    expect(html).not.toContain('data-error-for="normalized_summary"');
  });

  it("does NOT render an error alert on first SSR (no submit attempted)", () => {
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    expect(html).not.toMatch(/role="alert"[^>]*>Couldn/);
  });

  it("renders all six string-array fields as newline-delimited textareas", () => {
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    for (const field of [
      "skills",
      "tools",
      "domains",
      "seniority_signals",
      "scope_signals",
      "business_outcomes",
    ]) {
      expect(html).toMatch(
        new RegExp(`<textarea[^>]*data-field="${field}"`),
      );
    }
  });

  it("disables end-date input when start-date is empty (DateRange invariant)", () => {
    // Same UX hint as InlineEditForm. Backstop: validateForm
    // also catches it; this is the surface-level prevention.
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    const endInputMatch = html.match(/<input[^>]*data-field="date_end"[^>]*>/);
    expect(endInputMatch).not.toBeNull();
    expect(endInputMatch![0]).toMatch(/\sdisabled/);
  });

  it("renders empty-metrics placeholder copy", () => {
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    expect(html).toContain("No metrics yet.");
  });

  it("default confidence_score is '1' (matches buildManualUnit's user-trusted default)", () => {
    const html = renderToStaticMarkup(
      <ManualAddForm onSubmit={noopSubmit} onClose={noopClose} />,
    );
    expect(html).toMatch(/data-field="confidence_score"[^>]*value="1"/);
  });
});
