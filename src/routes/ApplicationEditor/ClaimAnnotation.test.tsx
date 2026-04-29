import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";
import type { ValidationFlag } from "../../types/crm.ts";

import ClaimAnnotation, { annotationSeverity } from "./ClaimAnnotation.tsx";

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

function flag(
  partial: Partial<ValidationFlag> & { id: string },
): ValidationFlag {
  return {
    asset_id: "asset",
    bullet_id: "b1",
    claim_id: "c1",
    status: "untraceable",
    rationale: "no supporting Unit",
    created_at: "2026-04-01T00:00:00.000Z",
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

  // ── sub-issue #186: flag underlines + 3 resolution paths ────────

  it("renders an amber underline (untraceable) when only untraceable flags are present", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={[]}
        unitsById={new Map()}
        flags={[flag({ id: "f1", status: "untraceable" })]}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-annotation-severity="untraceable"');
    expect(html).toMatch(/<button[^>]*border-amber-/);
    expect(html).not.toMatch(/<button[^>]*border-red-/);
  });

  it("renders a red underline (specificity wins) when both untraceable and specificity flags are present", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={[]}
        unitsById={new Map()}
        flags={[
          flag({ id: "f1", status: "untraceable" }),
          flag({ id: "f2", status: "specificity" }),
        ]}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-annotation-severity="specificity"');
    expect(html).toMatch(/<button[^>]*border-red-/);
  });

  it("ignores 'traced' flags when computing severity (defense-in-depth — view pre-filters too)", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={["u-a"]}
        unitsById={new Map([["u-a", unit({ id: "u-a" })]])}
        flags={[flag({ id: "f1", status: "traced" })]}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    // No surfacable flags → neutral severity even though a flag
    // exists in the input array.
    expect(html).toContain('data-annotation-severity="neutral"');
    expect(html).toContain('data-flag-count="0"');
  });

  it("renders flag rationale + status label in the popover (always-in-DOM, closed-state visible to tests)", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={[]}
        unitsById={new Map()}
        flags={[
          flag({
            id: "f1",
            status: "specificity",
            rationale: "Specific number missing.",
          }),
        ]}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-flag-id="f1"');
    expect(html).toContain('data-flag-status="specificity"');
    expect(html).toContain("vague claim");
    expect(html).toContain("Specific number missing.");
  });

  it("renders all three resolution path buttons when handlers are wired AND canRemove=true", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={[]}
        unitsById={new Map()}
        flags={[flag({ id: "f1" })]}
        canRemove={true}
        onRemove={() => undefined}
        onAddSupportingUnit={() => undefined}
        onEdit={() => undefined}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-action="edit-bullet"');
    expect(html).toContain('data-action="remove-bullet"');
    expect(html).toContain('data-action="add-supporting-unit"');
  });

  it("hides Remove when canRemove is false (summary-flag annotation)", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Summary."
        sourceUnitIds={[]}
        unitsById={new Map()}
        flags={[flag({ id: "f1", bullet_id: "summary" })]}
        canRemove={false}
        onRemove={() => undefined}
        onAddSupportingUnit={() => undefined}
        onEdit={() => undefined}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).not.toContain('data-action="remove-bullet"');
    // Other resolution paths still appear.
    expect(html).toContain('data-action="edit-bullet"');
    expect(html).toContain('data-action="add-supporting-unit"');
  });

  it("hides each resolution button when its handler is absent (no silent no-ops)", () => {
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={[]}
        unitsById={new Map()}
        flags={[flag({ id: "f1" })]}
        canRemove={true}
        // onRemove omitted
        // onAddSupportingUnit omitted
        // onEdit omitted
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).not.toContain('data-action="edit-bullet"');
    expect(html).not.toContain('data-action="remove-bullet"');
    expect(html).not.toContain('data-action="add-supporting-unit"');
  });

  it("does not render the resolution-paths section when no flags are present (only source_unit_ids)", () => {
    // Neutral underline for source_unit_ids only — popover shows
    // Source Units, no Edit/Remove/Add affordances since there's
    // no flag to resolve.
    const html = renderToStaticMarkup(
      <ClaimAnnotation
        text="Claim."
        sourceUnitIds={["u-a"]}
        unitsById={new Map([["u-a", unit({ id: "u-a" })]])}
        canRemove={true}
        onRemove={() => undefined}
        onAddSupportingUnit={() => undefined}
        onEdit={() => undefined}
        onHoverUnits={noopHover}
        onScrollToUnit={noopScroll}
      />,
    );
    expect(html).toContain('data-annotation-severity="neutral"');
    expect(html).not.toContain('aria-label="Resolution paths"');
    expect(html).not.toContain('data-action="edit-bullet"');
    expect(html).not.toContain('data-action="remove-bullet"');
    expect(html).not.toContain('data-action="add-supporting-unit"');
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

describe("annotationSeverity (pure helper)", () => {
  it("returns 'none' when no source_unit_ids and no flags", () => {
    expect(annotationSeverity([], [])).toBe("none");
    expect(annotationSeverity([], undefined)).toBe("none");
  });

  it("returns 'neutral' when source_unit_ids non-empty and no surfaceable flags", () => {
    expect(annotationSeverity(["u"], [])).toBe("neutral");
    expect(annotationSeverity(["u"], undefined)).toBe("neutral");
  });

  it("returns 'untraceable' when only untraceable flags are present", () => {
    expect(
      annotationSeverity([], [flag({ id: "f", status: "untraceable" })]),
    ).toBe("untraceable");
  });

  it("returns 'specificity' when at least one specificity flag is present (beats untraceable)", () => {
    expect(
      annotationSeverity(
        [],
        [
          flag({ id: "f1", status: "untraceable" }),
          flag({ id: "f2", status: "specificity" }),
        ],
      ),
    ).toBe("specificity");
    expect(
      annotationSeverity([], [flag({ id: "f", status: "specificity" })]),
    ).toBe("specificity");
  });

  it("treats 'traced' flags as no-flag (defense in depth)", () => {
    expect(
      annotationSeverity([], [flag({ id: "f", status: "traced" })]),
    ).toBe("none");
    expect(
      annotationSeverity(["u"], [flag({ id: "f", status: "traced" })]),
    ).toBe("neutral");
  });
});
