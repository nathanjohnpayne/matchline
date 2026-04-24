import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";

import UnitRow from "./UnitRow.tsx";

/**
 * Static rendering tests for UnitRow. Covers the view-mode output
 * + the initial render of the edit form when `onSaveEdit` is wired
 * (React Server rendering of a freshly-mounted row — the useState
 * is `{ kind: "view" }` until the user clicks Edit, so these
 * static tests don't exercise transitions). The state-machine
 * logic is covered by `inlineEditState.test.ts`.
 *
 * Interactive flows (click Edit → form renders; click Save →
 * service called; service reject → error surface) are covered by
 * the `UnitReviewView` integration tests, which render the full
 * composed tree. This file focuses on the row's own rendering
 * contract and its backward compat (no `onSaveEdit` ⇒ no Edit
 * button ⇒ pre-#81 callers keep working).
 */

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

describe("UnitRow", () => {
  it("does NOT render the Edit button when onSaveEdit is absent (backward compat)", () => {
    const html = renderToStaticMarkup(
      <ul>
        <UnitRow unit={unit({ id: "a" })} />
      </ul>,
    );
    expect(html).not.toContain('data-action="edit"');
  });

  it("renders the Edit button when onSaveEdit is wired", () => {
    const html = renderToStaticMarkup(
      <ul>
        <UnitRow unit={unit({ id: "a" })} onSaveEdit={async () => {}} />
      </ul>,
    );
    expect(html).toContain('data-action="edit"');
  });

  it("renders every column of the view-mode row", () => {
    const html = renderToStaticMarkup(
      <ul>
        <UnitRow
          unit={unit({
            id: "row",
            normalized_summary: "Shipped playback SDK to 40M viewers.",
            unit_type: "achievement",
            source_type: "resume",
            source_ref: "resume.pdf · line 12",
            confidence_score: 0.9,
            user_approved: true,
          })}
          onSaveEdit={async () => {}}
        />
      </ul>,
    );
    expect(html).toContain("Shipped playback SDK to 40M viewers.");
    expect(html).toContain("achievement");
    expect(html).toContain("resume");
    expect(html).toContain("resume.pdf");
    expect(html).toContain("90%");
    expect(html).toContain("Approved");
  });

  it("starts in view mode on first render (no edit form in initial SSR)", () => {
    // The row's useState initializes to { kind: "view" }. Since
    // `renderToStaticMarkup` does a single synchronous render with
    // no user interaction, the edit form must not appear. Pinning
    // this so a future refactor that flips the default state
    // doesn't silently open every row on mount.
    const html = renderToStaticMarkup(
      <ul>
        <UnitRow unit={unit({ id: "a" })} onSaveEdit={async () => {}} />
      </ul>,
    );
    expect(html).toContain('data-edit-mode="view"');
    expect(html).not.toContain('aria-label="Edit Unit"');
  });

  it("carries the title attribute for the truncated summary (view mode)", () => {
    // Regression from #88's CodeRabbit Major — the truncated
    // `normalized_summary` must have a `title` attribute for the
    // native full-text tooltip. UnitRow was refactored to wire
    // through `presentedUnit` instead of `unit`; re-pin the
    // behavior end-to-end.
    const longSummary =
      "A sufficiently long normalized summary that a typical row width would truncate visually but the attribute should still carry the whole string for hover.";
    const html = renderToStaticMarkup(
      <ul>
        <UnitRow unit={unit({ id: "a", normalized_summary: longSummary })} />
      </ul>,
    );
    expect(html).toContain(`title="${longSummary}"`);
  });

  it("surfaces the re-embed-pending badge when the flag is set", () => {
    const html = renderToStaticMarkup(
      <ul>
        <UnitRow
          unit={unit({ id: "a", reembed_pending: true })}
          onSaveEdit={async () => {}}
        />
      </ul>,
    );
    expect(html).toContain("re-embed pending");
  });
});
