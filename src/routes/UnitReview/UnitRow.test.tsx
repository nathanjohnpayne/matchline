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

  it("renders 0% instead of NaN% when confidence_score is non-finite (#338)", () => {
    const html = renderToStaticMarkup(
      <ul>
        <UnitRow
          unit={unit({ id: "a", confidence_score: Number.NaN })}
          onSaveEdit={async () => {}}
        />
      </ul>,
    );
    expect(html).toContain("0%");
    expect(html).not.toContain("NaN%");
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

  describe("approval actions (#82)", () => {
    const noopApproval = async () => {};

    it("does NOT render the action cluster when onSetApproval is absent (backward compat)", () => {
      const html = renderToStaticMarkup(
        <ul>
          <UnitRow unit={unit({ id: "a" })} />
        </ul>,
      );
      expect(html).not.toContain('data-action-cluster="true"');
      expect(html).not.toContain('data-action="approve"');
      expect(html).not.toContain('data-action="flag"');
      expect(html).not.toContain('data-action="reject"');
    });

    it("renders Approve / Flag / Reject buttons when onSetApproval is wired", () => {
      const html = renderToStaticMarkup(
        <ul>
          <UnitRow unit={unit({ id: "a" })} onSetApproval={noopApproval} />
        </ul>,
      );
      expect(html).toContain('data-action-cluster="true"');
      expect(html).toContain('data-action="approve"');
      expect(html).toContain('data-action="flag"');
      expect(html).toContain('data-action="reject"');
    });

    /**
     * Returns true if the rendered button with the given
     * data-action attribute carries the `disabled` HTML
     * attribute. We can't substring-match for "disabled"
     * because Tailwind class variants like `disabled:opacity-50`
     * contain the literal word — that's a class prefix, not the
     * boolean attribute. Match `disabled=""` or ` disabled `
     * specifically.
     */
    const isDisabled = (html: string, action: string): boolean => {
      const re = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`);
      const match = html.match(re);
      if (!match) {
        throw new Error(`No button with data-action="${action}" in HTML`);
      }
      const tag = match[0];
      // React serializes boolean disabled as `disabled=""`. The
      // class string "disabled:opacity-50" doesn't match this
      // pattern (the colon prevents the `="` form).
      return /\sdisabled=""/.test(tag) || /\sdisabled\s/.test(tag);
    };

    it("disables Approve when the Unit is already approved (no-op prevention)", () => {
      const html = renderToStaticMarkup(
        <ul>
          <UnitRow
            unit={unit({ id: "a", user_approved: true })}
            onSetApproval={noopApproval}
          />
        </ul>,
      );
      // Approve button disabled (already in that state). Reject
      // remains enabled (transitions away from approved).
      expect(isDisabled(html, "approve")).toBe(true);
      expect(isDisabled(html, "reject")).toBe(false);
    });

    it("disables Reject when the Unit is already rejected", () => {
      const html = renderToStaticMarkup(
        <ul>
          <UnitRow
            unit={unit({ id: "a", user_approved: false, rejected: true })}
            onSetApproval={noopApproval}
          />
        </ul>,
      );
      expect(isDisabled(html, "reject")).toBe(true);
    });

    it("does NOT render the reject confirmation dialog on first SSR", () => {
      // The confirmation surface only appears after the user
      // clicks Reject. SSR is a single synchronous render.
      const html = renderToStaticMarkup(
        <ul>
          <UnitRow unit={unit({ id: "a" })} onSetApproval={noopApproval} />
        </ul>,
      );
      expect(html).not.toContain('data-confirm="reject"');
    });

    // The reject-confirm gate (the Codex-P2 / Phase-4b-r2 fix
    // that prevents the confirmation panel from rendering
    // alongside the edit form) is exercised exhaustively at the
    // pure-predicate level in `inlineEditState.test.ts` →
    // `shouldShowRejectConfirm`. SSR can't drive the state
    // transitions that exercise the gate; the prior version of
    // this test asserted only the initial-mount shape and was
    // false-confidence — would have passed even if the
    // view-mode check were removed (nathanpayne-codex Phase 4b
    // on #93). The pure-predicate test pins all three
    // preconditions and would fail on any single removal.

    it("aria-labels on action buttons identify the Unit by summary", () => {
      const html = renderToStaticMarkup(
        <ul>
          <UnitRow
            unit={unit({
              id: "a",
              normalized_summary: "Shipped playback SDK to 40M CTVs.",
            })}
            onSetApproval={noopApproval}
          />
        </ul>,
      );
      expect(html).toContain(
        'aria-label="Approve Shipped playback SDK to 40M CTVs."',
      );
      expect(html).toContain(
        'aria-label="Flag Shipped playback SDK to 40M CTVs. for review"',
      );
      expect(html).toContain(
        'aria-label="Reject Shipped playback SDK to 40M CTVs."',
      );
    });
  });
});
