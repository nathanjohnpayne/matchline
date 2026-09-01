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

const unmet: Gap = { requirement: makeReq("r-unmet"), status: "unmet" };
const unverifiable: Gap = {
  requirement: makeReq("r-doubt"),
  status: "unverifiable",
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
