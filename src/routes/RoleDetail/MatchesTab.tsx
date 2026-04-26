/**
 * Matches tab — read-only render (sub-issue #129).
 *
 * Renders one row per Requirement, with the top-K matches
 * grouped underneath. Empty Requirements still render with
 * a "No matches found" placeholder so the user can see what
 * needs work (the dedicated Gaps view in #130 surfaces
 * unmet must_haves more explicitly; this is just the
 * faithful rendering of the read state).
 *
 * This component is pure: receives pre-fetched data + a
 * pre-resolved unit map from the container. No Firestore,
 * no business logic. Mirrors the UnitReview/View pattern.
 */

import type { ReactElement } from "react";

import type { ExperienceUnit, JobRequirementUnit } from "../../types/capability.ts";

import GapsView from "./GapsView.tsx";
import MatchCard from "./MatchCard.tsx";
import type { RequirementWithMatches } from "./groupMatchesByRequirement.ts";

export interface MatchesTabProps {
  readonly groups: readonly RequirementWithMatches[];
  /** Pre-computed unmet must-haves (#130). */
  readonly gaps: readonly JobRequirementUnit[];
  /**
   * Lookup map for pre-resolving each Match's source Unit
   * by id. The container builds this from a single Units
   * subscription so we don't fetch one-Unit-per-Match.
   */
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
  /** Approve/Reject handlers wired by the container (#130). */
  readonly onApproveToggle: (
    matchId: string,
    nextApproved: boolean,
  ) => void;
  readonly onRejectToggle: (
    matchId: string,
    nextRejected: boolean,
  ) => void;
}

export default function MatchesTab({
  groups,
  gaps,
  unitsById,
  onApproveToggle,
  onRejectToggle,
}: MatchesTabProps): ReactElement {
  if (groups.length === 0) {
    // No Requirements at all — different from "Requirements
    // exist but no matches." This rendering pin avoids
    // confusing an unparsed Role with a Role nobody can
    // qualify for.
    return (
      <p
        className="text-sm text-zinc-500"
        data-testid="matches-tab-no-requirements"
      >
        No Requirements parsed for this Role yet. Parse the JD on the
        Requirements tab first.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="matches-tab">
      <GapsView gaps={gaps} />
      <ul className="space-y-4">
        {groups.map(({ requirement, matches }) => (
        <li
          key={requirement.id}
          className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 bg-zinc-50 dark:bg-zinc-950"
        >
          <header className="mb-3 space-y-0.5">
            <p className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {requirement.normalized_requirement}
            </p>
            <p className="text-xs text-zinc-500 flex items-center gap-2">
              <span className="rounded border border-zinc-200 dark:border-zinc-700 px-1.5 py-0.5 uppercase tracking-wide font-medium">
                {requirement.category}
              </span>
              <span>•</span>
              <span>priority: {requirement.priority}</span>
              {requirement.must_have && (
                <>
                  <span>•</span>
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    must-have
                  </span>
                </>
              )}
            </p>
          </header>
          {matches.length === 0 ? (
            <p
              className="text-sm italic text-zinc-500"
              data-testid="match-row-empty"
            >
              No matches found.
            </p>
          ) : (
            <ul className="space-y-2">
              {matches.map((match) => (
                <li key={match.id}>
                  <MatchCard
                    match={match}
                    unit={unitsById.get(match.experience_unit_id) ?? null}
                    onApproveToggle={onApproveToggle}
                    onRejectToggle={onRejectToggle}
                  />
                </li>
              ))}
            </ul>
          )}
        </li>
        ))}
      </ul>
    </div>
  );
}
