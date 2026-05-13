import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";

import { APPROVED_MILESTONE } from "./ApprovalCounter.tsx";
import {
  EMPTY_FILTER_STATE,
  type FilterState,
} from "./filterState.ts";
import UnitReviewView from "./UnitReviewView.tsx";

/**
 * Static render of the presentational view. No testing-library dep
 * — the view is pure with respect to props, so `renderToStaticMarkup`
 * is sufficient to exercise every rendering branch. Subscription
 * logic lives in the container (`index.tsx`); it's exercised via
 * the existing Firestore emulator rules-test harness.
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
    user_approved: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  return { ...defaults, ...partial };
}

describe("UnitReviewView", () => {
  it("renders a loading indicator when status is 'loading' (NOT the empty state, NOT the counter)", () => {
    // Regression pin for nathanpayne-codex Phase 4b on #86: before
    // the explicit load-state prop, a fresh mount with `units: []`
    // rendered "No Experience Units yet" before the first Firestore
    // snapshot arrived — a misleading false-empty surface on the
    // landing page. Loading state must be distinct from empty
    // corpus AND must not render the approval counter (we have no
    // snapshot, so any count is a lie).
    const html = renderToStaticMarkup(
      <UnitReviewView status="loading" units={[]} />,
    );
    expect(html).toContain('data-load-state="loading"');
    expect(html).toContain("Loading Units");
    // The empty-state copy and CTA must NOT render while loading
    // — otherwise the user briefly sees "No Experience Units yet"
    // with an "Add Unit manually" CTA before the list populates.
    expect(html).not.toContain("No Experience Units yet.");
    expect(html).not.toContain("Add Unit manually");
    // Counter must NOT render in loading.
    expect(html).not.toContain("approved");
    expect(html).not.toContain("data-milestone");
  });

  it("renders the error alert when status is 'error' (NOT the empty state, NOT the counter)", () => {
    // Second half of the load-state discrimination: on error the
    // empty state must not render under the error banner. The
    // error surface is terminal for this subscription — showing
    // the empty state alongside would mislead the user into
    // thinking the corpus is empty rather than unreadable. And the
    // approval counter must NOT render in error (this is the
    // "error-after-success leaks stale count" regression from
    // nathanpayne-codex Phase 4b round 2).
    const err = new Error("Permission denied");
    const html = renderToStaticMarkup(
      <UnitReviewView status="error" units={[]} error={err} />,
    );
    expect(html).toContain('data-load-state="error"');
    expect(html).toContain("Permission denied");
    expect(html).not.toContain("No Experience Units yet.");
    expect(html).not.toContain("Add Unit manually");
    expect(html).not.toContain("Loading Units");
    expect(html).not.toContain("data-milestone");
  });

  it("does NOT render the approval counter when status is 'error' even with a stale populated units prop", () => {
    // Specific regression: error-after-success transition. The
    // container should clear `units` on error (belt-and-suspenders
    // in index.tsx), but even if some code path leaves a populated
    // array in place, the view's `status === "ready"` gate on the
    // counter must prevent a stale count from rendering next to
    // the error banner. Pin both layers of the defense.
    const err = new Error("Permission denied after snapshot");
    const staleUnits = [
      unit({ id: "a", user_approved: true }),
      unit({ id: "b", user_approved: true }),
      unit({ id: "c", user_approved: true }),
    ];
    const html = renderToStaticMarkup(
      <UnitReviewView status="error" units={staleUnits} error={err} />,
    );
    // Error surface renders.
    expect(html).toContain('data-load-state="error"');
    expect(html).toContain("Permission denied after snapshot");
    // Counter's "3 of 20" or "3 approved" MUST NOT leak. Neither
    // the milestone marker nor any variant of the approved-count
    // copy should appear.
    expect(html).not.toContain("data-milestone");
    expect(html).not.toContain("of 20 approved");
    // And the list itself must not render either — the status gate
    // must hide everything except the error banner.
    expect(html).not.toMatch(/data-unit-id="/);
  });

  it("renders the error alert with a fallback message when error is null", () => {
    // Defensive: if the container fires setStatus("error") without
    // also setting the error object, the alert still renders with
    // a "Unknown error." fallback rather than a hanging colon.
    const html = renderToStaticMarkup(
      <UnitReviewView status="error" units={[]} error={null} />,
    );
    expect(html).toContain("Unknown error.");
  });

  it("renders the empty state only when status is 'ready' AND no Units", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView status="ready" units={[]} />,
    );
    expect(html).toContain("No Experience Units yet.");
    expect(html).toContain("Add Unit manually");
    // Counter is still rendered in the header, showing 0 of 20
    expect(html).toContain(`0 of ${APPROVED_MILESTONE} approved`);
    // The three load-state markers are mutually exclusive. Pin the
    // positive "ready" marker as well (CodeRabbit Nitpick on PR #86)
    // — without it, a regression that dropped `data-load-state="ready"`
    // entirely could still pass the negative assertions below.
    expect(html).toContain('data-load-state="ready"');
    expect(html).not.toContain('data-load-state="loading"');
    expect(html).not.toContain('data-load-state="error"');
  });

  it("renders one <li> per non-rejected Unit", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
        status="ready"
        units={[
          unit({ id: "a" }),
          unit({ id: "b" }),
          unit({ id: "c" }),
        ]}
      />,
    );
    const rows = html.match(/data-unit-id="/g) ?? [];
    expect(rows).toHaveLength(3);
  });

  it("excludes rejected Units from the main list", () => {
    // Core zero-fabrication boundary: rejected Units must not
    // appear in the main review flow. Same semantic the matching
    // pipeline will see via listApprovedExperienceUnits.
    const html = renderToStaticMarkup(
      <UnitReviewView
        status="ready"
        units={[
          unit({ id: "approved-one", user_approved: true }),
          unit({ id: "rejected-one", rejected: true, user_approved: false }),
          unit({ id: "pending-one" }),
        ]}
      />,
    );
    expect(html).toContain('data-unit-id="approved-one"');
    expect(html).toContain('data-unit-id="pending-one"');
    expect(html).not.toContain('data-unit-id="rejected-one"');
  });

  it("truncates the primary text visually + exposes the full summary via title attribute (native tooltip)", () => {
    // #79 contract: "normalized_summary ... truncated with full-text
    // tooltip." Truncation is visual (Tailwind `.truncate` = CSS
    // text-overflow: ellipsis). Tooltip is the native `title`
    // attribute — accessible hover-tooltip without a new dep.
    // CodeRabbit Major on the original PR flagged that the tooltip
    // wasn't wired; this test pins both halves of the contract.
    const longSummary =
      "Drove a 14-month replatform of the streaming playback SDK across Roku, Fire TV, Apple TV, Android TV, web, iOS, and Android, cutting rebuffer rate from 3.1% to 0.7% across 40M monthly CTV viewers while preserving feature parity with the legacy stack.";
    const html = renderToStaticMarkup(
      <UnitReviewView
        status="ready"
        units={[unit({ id: "long", normalized_summary: longSummary })]}
      />,
    );
    // Truncation class applied on the primary text <p>.
    expect(html).toMatch(/<p[^>]*class="[^"]*truncate[^"]*"[^>]*>/);
    // Full text present via the title attribute even though the
    // visible rendering will ellipsis-clip.
    expect(html).toContain(`title="${longSummary}"`);
    // And the visible text itself is still the full string — the
    // CSS handles the visual truncation, not the markup.
    expect(html).toContain(longSummary);
  });

  it("renders all five columns on each row (summary, type, state, confidence, provenance)", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
        status="ready"
        units={[
          unit({
            id: "only",
            normalized_summary: "Shipped streaming-video SDK to 40M CTVs.",
            unit_type: "achievement",
            source_type: "resume",
            source_ref: "resume.pdf · line 47-52",
            confidence_score: 0.87,
            user_approved: true,
          }),
        ]}
      />,
    );
    expect(html).toContain("Shipped streaming-video SDK to 40M CTVs.");
    expect(html).toContain("achievement");
    expect(html).toContain("Approved");
    expect(html).toContain("87%");
    expect(html).toContain("resume.pdf");
  });

  it("shows the 'pending' milestone state when below 20 approved", () => {
    const units = Array.from({ length: 19 }, (_, i) =>
      unit({ id: `u-${i}`, user_approved: true }),
    );
    const html = renderToStaticMarkup(
      <UnitReviewView status="ready" units={units} />,
    );
    expect(html).toContain('data-milestone="pending"');
    expect(html).toContain(`19 of ${APPROVED_MILESTONE} approved`);
    expect(html).not.toContain("onboarding complete");
  });

  it("shows the 'hit' milestone state at exactly 20 approved", () => {
    const units = Array.from({ length: APPROVED_MILESTONE }, (_, i) =>
      unit({ id: `u-${i}`, user_approved: true }),
    );
    const html = renderToStaticMarkup(
      <UnitReviewView status="ready" units={units} />,
    );
    expect(html).toContain('data-milestone="hit"');
    expect(html).toContain("onboarding complete");
  });

  it("shows the 'hit' milestone state above 20 approved", () => {
    const units = Array.from({ length: 25 }, (_, i) =>
      unit({ id: `u-${i}`, user_approved: true }),
    );
    const html = renderToStaticMarkup(
      <UnitReviewView status="ready" units={units} />,
    );
    expect(html).toContain('data-milestone="hit"');
    expect(html).toContain("25 approved — onboarding complete");
  });

  it("renders each approval state with its distinct pill", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
        status="ready"
        units={[
          unit({ id: "a", user_approved: true }),
          unit({ id: "b" }),
          unit({ id: "c", flagged: true, user_approved: false }),
        ]}
      />,
    );
    expect(html).toContain('data-state="approved"');
    expect(html).toContain('data-state="pending"');
    expect(html).toContain('data-state="flagged"');
    // Rejected wasn't in the input for the main list — that's
    // pinned in the excludes-rejected test above.
  });

  it("surfaces a subscription error via role=alert", () => {
    const err = new Error("Permission denied");
    const html = renderToStaticMarkup(
      <UnitReviewView status="error" units={[]} error={err} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Permission denied");
  });

  it("renders the re-embed-pending badge when set on a Unit", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
        status="ready"
        units={[unit({ id: "freshly-manual", reembed_pending: true })]}
      />,
    );
    expect(html).toContain("re-embed pending");
  });

  it("does not render the re-embed-pending badge by default", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView status="ready" units={[unit({ id: "normal" })]} />,
    );
    expect(html).not.toContain("re-embed pending");
  });

  describe("filter integration (#80)", () => {
    const withFilter = (partial: Partial<FilterState>): FilterState => ({
      ...EMPTY_FILTER_STATE,
      ...partial,
    });
    const noop = () => {};

    it("renders the Filters panel when onFiltersChange + onClearFilters are both wired", () => {
      const html = renderToStaticMarkup(
        <UnitReviewView
          status="ready"
          units={[unit({ id: "a" })]}
          filters={EMPTY_FILTER_STATE}
          onFiltersChange={noop}
          onClearFilters={noop}
        />,
      );
      expect(html).toContain('aria-label="Unit filters"');
    });

    it("does NOT render the Filters panel when handlers are absent (backward compat)", () => {
      // Pre-#80 callers passed no filter props; rendering the
      // filter panel in that shape would surface a non-functional
      // UI. The "both wired or neither" contract is explicit.
      const html = renderToStaticMarkup(
        <UnitReviewView status="ready" units={[unit({ id: "a" })]} />,
      );
      expect(html).not.toContain('aria-label="Unit filters"');
    });

    it("applies skills filter to the visible row list", () => {
      const html = renderToStaticMarkup(
        <UnitReviewView
          status="ready"
          units={[
            unit({ id: "a", skills: ["sql"] }),
            unit({ id: "b", skills: ["python"] }),
            unit({ id: "c", skills: ["sql", "python"] }),
          ]}
          filters={withFilter({ skills: ["sql"] })}
          onFiltersChange={noop}
          onClearFilters={noop}
        />,
      );
      expect(html).toContain('data-unit-id="a"');
      expect(html).not.toContain('data-unit-id="b"');
      expect(html).toContain('data-unit-id="c"');
    });

    it("renders the 'no filter match' panel (NOT the empty state) when filters hide everything", () => {
      // Distinct surface when corpus is non-empty but filters hit
      // nothing. The empty-state CTA ("Add Unit manually") would
      // be wrong here — the user should clear the filter, not add
      // a new Unit. Pin the distinct copy + data attribute.
      const html = renderToStaticMarkup(
        <UnitReviewView
          status="ready"
          units={[
            unit({ id: "a", skills: ["sql"] }),
            unit({ id: "b", skills: ["python"] }),
          ]}
          filters={withFilter({ skills: ["firebase"] })}
          onFiltersChange={noop}
          onClearFilters={noop}
        />,
      );
      expect(html).toContain('data-filter-state="empty"');
      expect(html).toContain("No Units match these filters.");
      // Empty-state CTA MUST NOT render here — it would mislead
      // the user into adding a Unit when the fix is to clear the
      // filter.
      expect(html).not.toContain("No Experience Units yet.");
      expect(html).not.toContain("Add Unit manually");
    });

    it("still renders the genuine empty state (not filter-empty) when corpus is empty, even with active filters", () => {
      // If corpus is empty AND filters happen to be active (e.g.
      // user navigated via a shared URL with filter params to a
      // signed-in account with no Units), the empty state is
      // still the right surface — "Add Unit manually" is the
      // actionable fix, clearing filters wouldn't help.
      const html = renderToStaticMarkup(
        <UnitReviewView
          status="ready"
          units={[]}
          filters={withFilter({ skills: ["sql"] })}
          onFiltersChange={noop}
          onClearFilters={noop}
        />,
      );
      expect(html).toContain("No Experience Units yet.");
      expect(html).toContain("Add Unit manually");
      expect(html).not.toContain('data-filter-state="empty"');
    });

    it("counter shows the GLOBAL approved count, not the filtered count", () => {
      // The "≥20 approved" milestone is about onboarding
      // progress, not filter-specific. Filtering should never
      // rubber-band the counter.
      const units = Array.from({ length: 15 }, (_, i) =>
        unit({
          id: `u-${i}`,
          user_approved: true,
          skills: i < 5 ? ["sql"] : ["python"],
        }),
      );
      const html = renderToStaticMarkup(
        <UnitReviewView
          status="ready"
          units={units}
          filters={withFilter({ skills: ["sql"] })}
          onFiltersChange={noop}
          onClearFilters={noop}
        />,
      );
      // 15 approved globally, filter restricts visible list to 5
      expect(html).toContain(`15 of ${APPROVED_MILESTONE} approved`);
      // Visible list has only the 5 sql Units
      const visibleIds = Array.from(
        html.matchAll(/data-unit-id="([^"]+)"/g),
      ).map((m) => m[1]);
      expect(visibleIds).toHaveLength(5);
    });

    it("chip sources seed from the full non-rejected corpus, not the currently-filtered set", () => {
      // If a user filters to skill=sql, the Tools chip list should
      // still show tools from other Units — otherwise the user
      // gets trapped in a reduced filter space and can never pick
      // up a second filter axis. Pin the "chips seed from corpus,
      // not filtered view" invariant.
      const html = renderToStaticMarkup(
        <UnitReviewView
          status="ready"
          units={[
            unit({ id: "a", skills: ["sql"], tools: ["snowflake"] }),
            unit({ id: "b", skills: ["python"], tools: ["airflow"] }),
          ]}
          filters={withFilter({ skills: ["sql"] })}
          onFiltersChange={noop}
          onClearFilters={noop}
        />,
      );
      // Snowflake chip visible (sql Unit's tool)
      expect(html).toContain(">snowflake<");
      // Airflow chip ALSO visible (python Unit's tool, even though
      // that Unit is filtered out of the list)
      expect(html).toContain(">airflow<");
    });
  });

  it("orders rows by updated_at descending (most recent first)", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
        status="ready"
        units={[
          unit({ id: "old", updated_at: "2026-01-01T00:00:00.000Z" }),
          unit({ id: "new", updated_at: "2026-04-01T00:00:00.000Z" }),
          unit({ id: "mid", updated_at: "2026-02-15T00:00:00.000Z" }),
        ]}
      />,
    );
    const newIdx = html.indexOf('data-unit-id="new"');
    const midIdx = html.indexOf('data-unit-id="mid"');
    const oldIdx = html.indexOf('data-unit-id="old"');
    expect(newIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(oldIdx);
  });
});
