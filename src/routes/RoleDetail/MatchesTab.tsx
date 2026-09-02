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

import type { ExperienceUnit } from "../../types/capability.ts";

import GapsView, { EvidenceNotice, StrandedNotice } from "./GapsView.tsx";
import type { EvidenceStatus } from "./GapsView.tsx";
import type { Gap } from "./computeGaps.ts";
import MatchCard from "./MatchCard.tsx";
import type { RequirementWithMatches } from "./groupMatchesByRequirement.ts";
import type { MatchApprovalState } from "../../services/matches.ts";

export interface MatchesTabProps {
  readonly groups: readonly RequirementWithMatches[];
  /** Pre-computed unmet must-haves (#130). */
  readonly gaps: readonly Gap[];
  readonly evidenceStatus?: EvidenceStatus;
  readonly strandedMatches?: number;
  /**
   * Lookup map for pre-resolving each Match's source Unit
   * by id. The container builds this from a single Units
   * subscription so we don't fetch one-Unit-per-Match.
   */
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
  /**
   * Approval-state handler (#130 + cursor #133 r1). Single
   * setter; MatchCard computes the next state locally and
   * passes it up.
   */
  readonly onApprovalStateChange: (
    matchId: string,
    state: MatchApprovalState,
  ) => void;
  /**
   * True while the auto-trigger's `runMatching` callable is
   * in flight (#131). Renders a "Computing matches…" hint
   * above the requirements grid.
   */
  readonly computingMatches: boolean;
  /**
   * Manual re-run of matching. Optional so the existing view
   * tests and any other caller keep working without it; the
   * control simply does not render when absent.
   */
  readonly onRerunMatching?: () => void;
  readonly matchingError?: Error | null;
}

export default function MatchesTab({
  groups,
  gaps,
  evidenceStatus,
  strandedMatches,
  unitsById,
  onApprovalStateChange,
  computingMatches,
  onRerunMatching,
  matchingError,
}: MatchesTabProps): ReactElement {
  if (groups.length === 0) {
    // No Requirements at all — different from "Requirements
    // exist but no matches." This rendering pin avoids
    // confusing an unparsed Role with a Role nobody can
    // qualify for.
    //
    // Stranded matches have to appear here as well. This branch
    // is reached when a re-parse removed every Requirement, which
    // is exactly the case where every surviving match is stranded
    // — the one state in which the notice matters most was the
    // one state that could not render it. Codex P2 on PR #446.
    //
    // The copy changes with it: "parse the JD first" is wrong
    // advice for a Role whose JD was parsed, since that parse is
    // what stranded the matches.
    return (
      <div className="space-y-2" data-testid="matches-tab-no-requirements">
        <p className="text-sm text-zinc-500">
          {strandedMatches !== undefined && strandedMatches > 0
            ? "This Role has no requirements right now, but it still has " +
              "matches from a previous version of the job description."
            : "No Requirements parsed for this Role yet. Parse the JD on " +
              "the Requirements tab first."}
        </p>
        <StrandedNotice count={strandedMatches ?? 0} />
        {/*
          No Requirements means no coverage claim is being made
          here, and the stranded count is structural — it does not
          depend on the derivation at all. The disclosure is shown
          anyway because hiding it in one branch and not the other
          is the inconsistency that produced this whole class of
          bug. CodeRabbit on PR #446.
        */}
        <EvidenceNotice status={evidenceStatus ?? "current"} />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="matches-tab">
      {computingMatches && (
        <p
          className="rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950 px-3 py-2 text-sm text-blue-800 dark:text-blue-300"
          data-testid="matches-computing"
          role="status"
          aria-live="polite"
        >
          Computing matches…
        </p>
      )}
      <GapsView
        gaps={gaps}
        evidenceStatus={evidenceStatus}
        strandedMatches={strandedMatches}
      />
      {onRerunMatching !== undefined && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={onRerunMatching}
            disabled={computingMatches}
            data-testid="rerun-matching"
            className="rounded border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            {computingMatches ? "Re-running matching…" : "Re-run matching"}
          </button>
          <p className="text-xs text-zinc-500">
            Rebuilds this Role&rsquo;s matches against its current
            requirements. Your approve and reject decisions are carried
            forward.
          </p>
          {matchingError !== undefined && matchingError !== null && (
            <p
              className="text-xs text-red-700 dark:text-red-400"
              data-testid="rerun-matching-error"
            >
              {matchingError.message}
            </p>
          )}
        </div>
      )}
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
                    onApprovalStateChange={onApprovalStateChange}
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
