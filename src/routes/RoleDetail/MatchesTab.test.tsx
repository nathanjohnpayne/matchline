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
import type { RequirementWithMatches } from "./groupMatchesByRequirement.ts";

const EMPTY_UNITS = new Map<string, ExperienceUnit>();

function render(props: {
  readonly strandedMatches?: number;
  readonly evidenceStatus?: "current" | "pending" | "unavailable";
  readonly onRerunMatching?: () => void;
  readonly matchingError?: Error | null;
  readonly computingMatches?: boolean;
  readonly groups?: RequirementWithMatches[];
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

describe("MatchesTab: the re-run matching control (#442)", () => {
  // The generation gate refuses when every approved match is
  // stranded and tells the user to re-run matching. That
  // instruction was unreachable: the auto-trigger will not fire
  // while matches exist, and this tab had no control. A refusal
  // naming an impossible action is worse than no refusal. Codex
  // P2 on PR #449.
  const group: RequirementWithMatches = {
    requirement: {
      id: "req-1",
      owner_uid: "u",
      role_id: "role-1",
      raw_text: "raw",
      normalized_requirement: "norm",
      category: "skill",
      keywords: [],
      tools: [],
      domains: [],
      priority: "high",
      must_have: true,
      extracted_from: "qualifications",
    },
    matches: [],
  };

  it("renders the control when a handler is supplied", () => {
    const html = render({ groups: [group], onRerunMatching: () => {} });
    expect(html).toContain("rerun-matching");
    expect(html).toContain("Re-run matching");
  });

  it("says decisions carry forward, so the control does not read as destructive", () => {
    const html = render({ groups: [group], onRerunMatching: () => {} });
    expect(html).toContain("carry forward");
  });

  it("disables the control while matching is already running", () => {
    const html = render({
      groups: [group],
      onRerunMatching: () => {},
      computingMatches: true,
    });
    expect(html).toContain("disabled");
    expect(html).toContain("Re-running matching…");
  });

  it("surfaces a failure rather than failing silently", () => {
    const html = render({
      groups: [group],
      onRerunMatching: () => {},
      matchingError: new Error("Matching timed out."),
    });
    expect(html).toContain("rerun-matching-error");
    expect(html).toContain("Matching timed out.");
  });

  it("renders nothing extra when no handler is supplied", () => {
    const html = render({ groups: [group] });
    expect(html).not.toContain("rerun-matching");
  });

  it("renders in the zero-Requirements branch, where recovery matters most", () => {
    // A clear-and-replace parse that removes every Requirement
    // empties `groups` AND strands every prior match, so the
    // early return is precisely the state that needs this
    // control. Confining it to the populated branch put it out of
    // reach there — the same mistake made with the stranded
    // notice on PR #446. Codex and CodeRabbit on PR #449.
    const html = render({ groups: [], onRerunMatching: () => {} });
    expect(html).toContain("rerun-matching");
  });

  it("does not overpromise the carry-forward in the re-parse flow", () => {
    // `replaceMatchesForRole` keys carry-forward on the exact
    // (experience_unit_id, job_requirement_unit_id) pair. A
    // re-parse gives every Requirement a new id, so NO decisions
    // survive — and this button exists primarily for that flow.
    // The first copy said decisions "are carried forward" flatly.
    const html = render({ groups: [group], onRerunMatching: () => {} });
    expect(html).toContain("have not changed");
    expect(html).toContain("need reviewing again");
  });
});
