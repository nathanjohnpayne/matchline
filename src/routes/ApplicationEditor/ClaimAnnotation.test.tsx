import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";

import ClaimAnnotation from "./ClaimAnnotation.tsx";

/**
 * Static-render tests for the ClaimAnnotation primitive (#24,
 * sub-issue #185). The popover is always rendered in the DOM with
 * visibility gated by a class tied to React state — this lets
 * `renderToStaticMarkup` exercise the popover content shape on a
 * fresh mount even though the popover is click-triggered (closed
 * by default). Click-open and click-outside-close are async
 * behaviors covered by hand-testing per the route's test
 * convention.
 */

function unit(
  partial: Partial<ExperienceUnit> & { id: string },
): ExperienceUnit {
  return {
    owner_uid: "u",
    source_type: "resume",
    source_ref: "r",
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
    confidence_score: 1,
    user_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const noopHover = () => undefined;
const noopScroll = () => undefined;

describe("ClaimAnnotation", () => {
  it("renders plain text without an annotation when source_unit_ids is empty", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Ungrounded claim."
        sourceUnitIds={[]}
        unitsById={new Map()}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain("Ungrounded claim.");
    expect(html).not.toContain('data-testid="claim-annotation"');
    expect(html).not.toContain("border-b");
  });

  it("renders the underlined trigger when source_unit_ids has at least one entry", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Grounded claim."
        sourceUnitIds={["u-a"]}
        unitsById={new Map([["u-a", unit({ id: "u-a" })]])}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-testid="claim-annotation"');
    expect(html).toContain('data-source-unit-count="1"');
    // 1px underline (border-b) on the trigger.
    expect(html).toMatch(/<button[^>]*border-b[^>]*>/);
    expect(html).toContain("Grounded claim.");
  });

  it("starts with the popover closed (aria-hidden, data-popover-open='false', invisible class) but content present in DOM", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={["u-a"]}
        unitsById={new Map([["u-a", unit({ id: "u-a", normalized_summary: "Cited." })]])}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-testid="claim-popover"');
    expect(html).toContain('data-popover-open="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/data-testid="claim-popover"[^>]*invisible/);
    // Content present in DOM despite the visibility class.
    expect(html).toContain("Cited.");
  });

  it("renders the trigger with aria-expanded='false' on initial mount", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={["u-a"]}
        unitsById={new Map([["u-a", unit({ id: "u-a" })]])}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-controls=');
  });

  it("uses role='dialog' + aria-modal='false' on the popover (interactive content forbidden in role='tooltip')", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={["u-a"]}
        unitsById={new Map([["u-a", unit({ id: "u-a" })]])}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    expect(html).not.toMatch(/data-testid="claim-popover"[^>]*role="tooltip"/);
  });

  it("renders each source Unit summary in the popover with its id + resolved flag", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={["u-a", "u-b"]}
        unitsById={
          new Map([
            ["u-a", unit({ id: "u-a", normalized_summary: "Unit A summary." })],
            ["u-b", unit({ id: "u-b", normalized_summary: "Unit B summary." })],
          ])
        }
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-source-unit-id="u-a"');
    expect(html).toContain('data-source-unit-id="u-b"');
    expect(html).toContain('data-source-resolved="true"');
    expect(html).toContain("Unit A summary.");
    expect(html).toContain("Unit B summary.");
  });

  it("renders missing Unit refs with the (missing Unit) fallback + amber treatment", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={["ghost"]}
        unitsById={new Map()}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-source-unit-id="ghost"');
    expect(html).toContain('data-source-resolved="false"');
    expect(html).toContain("(missing Unit)");
    // Amber tone on the missing-Unit button (semantic warning).
    expect(html).toMatch(/data-source-unit-id="ghost"[^>]*amber/);
  });

  it("uses a composite key for popover entries so a duplicate Unit id does not collide", () => {
    // The schema doesn't disallow duplicates in source_unit_ids
    // (a generator could ground the same claim on the same Unit
    // twice). Without a composite key, React's reconciliation
    // would warn and the popover would render unstable order.
    // Indirect pin: render with duplicate ids and assert two
    // distinct buttons appear.
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={["u-a", "u-a"]}
        unitsById={new Map([["u-a", unit({ id: "u-a", normalized_summary: "Dup." })]])}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    const matches = html.match(/data-source-unit-id="u-a"/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});
