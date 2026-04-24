import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";

import { APPROVED_MILESTONE } from "./ApprovalCounter.tsx";
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
  it("renders the empty state when no Units are provided", () => {
    const html = renderToStaticMarkup(<UnitReviewView units={[]} />);
    expect(html).toContain("No Experience Units yet.");
    expect(html).toContain("Add Unit manually");
    // Counter is still rendered in the header, showing 0 of 20
    expect(html).toContain(`0 of ${APPROVED_MILESTONE} approved`);
  });

  it("renders one <li> per non-rejected Unit", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
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

  it("renders all five columns on each row (summary, type, state, confidence, provenance)", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
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
    const html = renderToStaticMarkup(<UnitReviewView units={units} />);
    expect(html).toContain('data-milestone="pending"');
    expect(html).toContain(`19 of ${APPROVED_MILESTONE} approved`);
    expect(html).not.toContain("onboarding complete");
  });

  it("shows the 'hit' milestone state at exactly 20 approved", () => {
    const units = Array.from({ length: APPROVED_MILESTONE }, (_, i) =>
      unit({ id: `u-${i}`, user_approved: true }),
    );
    const html = renderToStaticMarkup(<UnitReviewView units={units} />);
    expect(html).toContain('data-milestone="hit"');
    expect(html).toContain("onboarding complete");
  });

  it("shows the 'hit' milestone state above 20 approved", () => {
    const units = Array.from({ length: 25 }, (_, i) =>
      unit({ id: `u-${i}`, user_approved: true }),
    );
    const html = renderToStaticMarkup(<UnitReviewView units={units} />);
    expect(html).toContain('data-milestone="hit"');
    expect(html).toContain("25 approved — onboarding complete");
  });

  it("renders each approval state with its distinct pill", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
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
      <UnitReviewView units={[]} error={err} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Permission denied");
  });

  it("renders the re-embed-pending badge when set on a Unit", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
        units={[unit({ id: "freshly-manual", reembed_pending: true })]}
      />,
    );
    expect(html).toContain("re-embed pending");
  });

  it("does not render the re-embed-pending badge by default", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView units={[unit({ id: "normal" })]} />,
    );
    expect(html).not.toContain("re-embed pending");
  });

  it("orders rows by updated_at descending (most recent first)", () => {
    const html = renderToStaticMarkup(
      <UnitReviewView
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
