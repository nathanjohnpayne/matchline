/**
 * View-layer tests for `MatchesTab`'s zero-Requirements branch.
 *
 * That branch returns before `GapsView` mounts, so anything the
 * panel would have said is invisible there — and it is reached
 * exactly when a JD re-parse has removed every Requirement, which
 * is also when every surviving match is stranded. The one state
 * where the stranded warning matters most was the one state that
 * could not render it. Codex P2 on PR #446.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";

import MatchesTab from "./MatchesTab.tsx";

const EMPTY_UNITS = new Map<string, ExperienceUnit>();

function render(props: {
  readonly strandedMatches?: number;
  readonly evidenceStatus?: "current" | "pending" | "unavailable";
}): string {
  return renderToStaticMarkup(
    <MatchesTab
      groups={[]}
      gaps={[]}
      unitsById={EMPTY_UNITS}
      onApprovalStateChange={() => {}}
      computingMatches={false}
      {...props}
    />,
  );
}

describe("MatchesTab: the no-Requirements branch", () => {
  it("warns about stranded matches even though GapsView never mounts", () => {
    const html = render({ strandedMatches: 3 });
    expect(html).toContain("gaps-stranded");
    expect(html).toContain("3 matches point");
  });

  it("does not tell the user to parse a JD that was already parsed", () => {
    // A Role reaching this branch WITH stranded matches has been
    // parsed — that parse is what stranded them. "Parse the JD
    // first" would send the user to repeat the action that caused
    // the problem.
    const html = render({ strandedMatches: 2 });
    expect(html).not.toContain("Parse the JD on");
    expect(html).toContain("previous version of the job description");
  });

  it("keeps the original guidance for a genuinely unparsed Role", () => {
    const html = render({ strandedMatches: 0 });
    expect(html).toContain("No Requirements parsed for this Role yet");
    expect(html).not.toContain("gaps-stranded");
  });

  it("treats an absent count as none stranded", () => {
    const html = render({});
    expect(html).toContain("No Requirements parsed for this Role yet");
    expect(html).not.toContain("gaps-stranded");
  });
});

describe("MatchesTab: evidence disclosure in the no-Requirements branch", () => {
  it("discloses an unavailable derivation there too", () => {
    // Hiding it in one branch and showing it in the other is the
    // inconsistency that produced this whole class of bug.
    const html = render({ evidenceStatus: "unavailable" });
    expect(html).toContain("gaps-evidence-unavailable");
  });

  it("discloses a pending derivation", () => {
    expect(render({ evidenceStatus: "pending" })).toContain(
      "gaps-evidence-pending",
    );
  });

  it("says nothing extra when evidence is current", () => {
    const html = render({ evidenceStatus: "current" });
    expect(html).not.toContain("gaps-evidence-unavailable");
    expect(html).not.toContain("gaps-evidence-pending");
  });

  it("defaults to current when the status is absent", () => {
    const html = render({});
    expect(html).not.toContain("gaps-evidence-unavailable");
    expect(html).not.toContain("gaps-evidence-pending");
  });
});
