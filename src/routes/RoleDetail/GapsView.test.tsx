/**
 * View-layer tests for `GapsView`. Pure `renderToStaticMarkup`
 * shape checks — no Firebase, no router.
 *
 * The behaviour under test is #441's: an unverified must-have
 * and an unmet one are different claims, and the panel has to
 * make them look different. A test on `computeGaps` alone would
 * not have caught the #435-era bug where a correct helper was
 * never wired to what rendered.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { JobRequirementUnit } from "../../types/capability.ts";

import type { Gap } from "./computeGaps.ts";
import type { UnverifiableReason } from "../../../functions/src/types/evidence.ts";
import GapsView from "./GapsView.tsx";

function makeReq(id: string): JobRequirementUnit {
  return {
    id,
    owner_uid: "u",
    role_id: "role-1",
    raw_text: `${id} raw`,
    normalized_requirement: `${id} normalized`,
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
  };
}

const unmet: Gap = {
  requirement: makeReq("r-unmet"),
  status: "unmet",
  reasons: [],
};
const unverifiable: Gap = {
  requirement: makeReq("r-doubt"),
  status: "unverifiable",
  reasons: ["unit_missing"],
};

describe("GapsView: the two kinds of gap", () => {
  it("renders an unmet gap under the gaps heading only", () => {
    const html = renderToStaticMarkup(<GapsView gaps={[unmet]} />);
    expect(html).toContain("1 unmet must-have requirement");
    expect(html).toContain("r-unmet normalized");
    expect(html).not.toContain("gaps-unverifiable");
  });

  it("renders an unverifiable gap in its own block, not as unmet", () => {
    const html = renderToStaticMarkup(<GapsView gaps={[unverifiable]} />);
    expect(html).toContain("gaps-unverifiable");
    expect(html).toContain("1 must-have requirement");
    expect(html).toContain("could not be checked");
    // The critical negative: calling this "unmet" would be the
    // same over-claim as calling an unverified match "covered",
    // pointed the other way.
    expect(html).not.toContain("unmet must-have requirement");
    expect(html).not.toContain(
      "No Experience Unit qualifies for these",
    );
  });

  it("renders both blocks when both kinds are present, counted separately", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[unmet, unverifiable]} />,
    );
    expect(html).toContain("1 unmet must-have requirement");
    expect(html).toContain("gaps-unverifiable");
    expect(html).toContain("r-unmet normalized");
    expect(html).toContain("r-doubt normalized");
  });

  it("still shows the affirmative empty state with no gaps", () => {
    const html = renderToStaticMarkup(<GapsView gaps={[]} />);
    expect(html).toContain("gaps-view-empty");
    expect(html).toContain("Every must-have requirement has a qualifying match");
  });
});

describe("GapsView: the accessible name must not over-claim", () => {
  // Codex P2 on PR #446: the visible heading tracked the
  // statuses but a fixed aria-label did not, so a panel holding
  // only unverified entries announced "Unmet must-have
  // requirements" — the stronger claim, audible only to
  // assistive technology. The exact conflation this change
  // exists to undo, reintroduced through the accessibility layer.
  it("announces unverified-only content as unverified", () => {
    const html = renderToStaticMarkup(<GapsView gaps={[unverifiable]} />);
    expect(html).toContain('aria-label="Unverified must-have requirements"');
  });

  it("announces unmet-only content as unmet", () => {
    const html = renderToStaticMarkup(<GapsView gaps={[unmet]} />);
    expect(html).toContain('aria-label="Unmet must-have requirements"');
  });

  it("names both when both are present", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[unmet, unverifiable]} />,
    );
    expect(html).toContain(
      'aria-label="Unmet and unverified must-have requirements"',
    );
  });
});

describe("GapsView: disclosing that the evidence check did not run", () => {
  it("says nothing extra when the derivation is current", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[unmet]} evidenceStatus="current" />,
    );
    expect(html).not.toContain("gaps-evidence-unavailable");
    expect(html).not.toContain("gaps-evidence-pending");
  });

  it("discloses an unavailable derivation over the permissive reading", () => {
    // `computeGaps` degrades permissively on failure by design —
    // a failed call must never invent gaps. The cost of that
    // choice is that a must-have can read as covered by a match
    // whose evidence was never established, so the panel has to
    // say so rather than let the silence imply a clean check.
    const html = renderToStaticMarkup(
      <GapsView gaps={[]} evidenceStatus="unavailable" />,
    );
    expect(html).toContain("gaps-evidence-unavailable");
    expect(html).toContain("could not be checked");
    expect(html).toContain("never verified");
  });

  it("shows the pending notice while the derivation is in flight", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[unmet]} evidenceStatus="pending" />,
    );
    expect(html).toContain("gaps-evidence-pending");
  });

  it("discloses on the empty state too, where the risk is highest", () => {
    // "✓ Every must-have requirement has a qualifying match" is
    // the single most load-bearing sentence in the view. An
    // unchecked derivation must not let it stand alone.
    const html = renderToStaticMarkup(
      <GapsView gaps={[]} evidenceStatus="unavailable" />,
    );
    expect(html).toContain("gaps-view-empty");
    expect(html).toContain("gaps-evidence-unavailable");
  });
});

describe("GapsView: the cause must name the right side of the pair (#446)", () => {
  function gapWith(...reasons: readonly UnverifiableReason[]): Gap {
    return {
      requirement: makeReq("r-doubt"),
      status: "unverifiable",
      reasons,
    };
  }

  it("does not blame the Experience Unit for a Requirement-side failure", () => {
    // The linked Unit can be present, approved and untouched
    // while the REQUIREMENT has no usable embedding. The old copy
    // said the Unit had been "deleted, edited since, or is not
    // currently approved" for every reason alike, which sent the
    // user to fix something that was never broken.
    const html = renderToStaticMarkup(
      <GapsView gaps={[gapWith("requirement_embedding_missing")]} />,
    );
    expect(html).toContain("this requirement has no usable embedding");
    expect(html).not.toContain("Experience Unit");
  });

  it("names the model mismatch as being about the pair, not one side", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[gapWith("embedding_dimension_mismatch")]} />,
    );
    expect(html).toContain("embedded by different models");
  });

  it("does blame the Unit when the Unit IS the cause", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[gapWith("unit_unapproved")]} />,
    );
    expect(html).toContain("not currently approved");
  });

  it("lists several distinct causes together", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[gapWith("unit_missing", "requirement_missing")]} />,
    );
    expect(html).toContain("no longer exists");
    expect(html).toContain("older version of it");
  });

  it("says nothing per-row for an ordinary unmet gap", () => {
    const html = renderToStaticMarkup(<GapsView gaps={[unmet]} />);
    expect(html).not.toContain("Could not verify");
  });
});

describe("GapsView: the empty state must not assert a clean bill of health (#446)", () => {
  it("claims every must-have is covered only when evidence is current", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[]} evidenceStatus="current" />,
    );
    expect(html).toContain("Every must-have requirement has a qualifying match");
  });

  for (const status of ["pending", "unavailable"] as const) {
    it(`withholds that claim while evidence is ${status}`, () => {
      // The empty list can be the permissive fallback rather than
      // a real result. A tick and "every must-have has a
      // qualifying match" is the single most load-bearing
      // sentence in the view, and it must not stand on a check
      // that has not happened. CodeRabbit on PR #446, out of
      // diff — the disclosure underneath was not enough while the
      // headline still asserted.
      const html = renderToStaticMarkup(
        <GapsView gaps={[]} evidenceStatus={status} />,
      );
      expect(html).not.toContain(
        "Every must-have requirement has a qualifying match",
      );
      expect(html).toContain("not yet a clean bill of health");
    });
  }
});

describe("GapsView: stranded matches (#446)", () => {
  it("reports matches pointing at a requirement that no longer exists", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[]} strandedMatches={2} />,
    );
    expect(html).toContain("gaps-stranded");
    expect(html).toContain("2 matches point");
    expect(html).toContain("no longer exists");
  });

  it("says nothing when none are stranded", () => {
    const html = renderToStaticMarkup(<GapsView gaps={[]} />);
    expect(html).not.toContain("gaps-stranded");
  });

  it("reports them alongside real gaps too", () => {
    const html = renderToStaticMarkup(
      <GapsView gaps={[unmet]} strandedMatches={1} />,
    );
    expect(html).toContain("gaps-stranded");
    expect(html).toContain("1 match point");
  });
});
