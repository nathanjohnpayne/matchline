/**
 * Single UnitMatch card. Shipped read-only in #129; this
 * version adds Approve / Reject buttons (#130). Sub-score
 * breakdown ships in #131.
 *
 * Renders:
 *   - The matched Unit's `normalized_summary` as the
 *     headline.
 *   - The `final_score` as a 0–100 number with 1 decimal.
 *   - The `rationale` explaining why the match scores
 *     where it does.
 *   - The `surface_evidence` — the specific piece of
 *     ground-truth content from the Unit being matched.
 *   - Approve / Reject buttons. State is derived from
 *     `match.approved_for_use` + `match.user_rejected`:
 *       both false → "Approve" + "Reject" both clickable
 *       approved_for_use:true → "Approved ✓" (clickable to revert)
 *       user_rejected:true → "Rejected ✗" (clickable to revert)
 *     Mutual exclusion is ENFORCED at the service layer
 *     (`setMatchApproval` / `setMatchRejection` clear the
 *     other flag); the UI just exposes the right click
 *     surface for each state.
 *
 * Click semantics:
 *   - `onApproveToggle(matchId, nextApproved)` — passes the
 *     intended next state. The container resolves to the
 *     service write and Firestore subscription delivers
 *     the new snapshot.
 *   - `onRejectToggle(matchId, nextRejected)` — symmetric.
 *
 * Optimism: the container fires the write but doesn't lock
 * the UI; the snapshot's next delivery resolves the visible
 * state. If the write fails, the snapshot reverts. This
 * matches the UnitReview pattern at #86.
 */

import type { ReactElement } from "react";

import type { ExperienceUnit, UnitMatch } from "../../types/capability.ts";

export interface MatchCardProps {
  readonly match: UnitMatch;
  readonly unit: ExperienceUnit | null;
  readonly onApproveToggle: (
    matchId: string,
    nextApproved: boolean,
  ) => void;
  readonly onRejectToggle: (
    matchId: string,
    nextRejected: boolean,
  ) => void;
}

export default function MatchCard({
  match,
  unit,
  onApproveToggle,
  onRejectToggle,
}: MatchCardProps): ReactElement {
  // 0-100 with 1 decimal — readable score, not a precision
  // signal. Score breakdown for the curious lives in #131's
  // tooltip.
  const score100 = (match.final_score * 100).toFixed(1);

  return (
    <article
      className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 space-y-2 bg-white dark:bg-zinc-900"
      data-testid="match-card"
      data-approved={match.approved_for_use}
      data-rejected={match.user_rejected}
    >
      <header className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-medium leading-5 text-zinc-900 dark:text-zinc-100 flex-1">
          {unit !== null ? (
            unit.normalized_summary
          ) : (
            <span className="italic text-zinc-500">
              (Unit no longer available)
            </span>
          )}
        </h4>
        <span
          className="shrink-0 rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs font-mono tabular-nums text-zinc-700 dark:text-zinc-300"
          data-testid="match-score"
          aria-label={`Match score: ${score100} out of 100`}
        >
          {score100}
        </span>
      </header>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">Why: </span>
        {match.rationale}
      </p>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">Evidence: </span>
        <q className="italic">{match.surface_evidence}</q>
      </p>
      <footer className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => onApproveToggle(match.id, !match.approved_for_use)}
          aria-pressed={match.approved_for_use}
          data-testid="match-approve-button"
          className={
            "rounded px-2 py-1 text-xs font-medium transition-colors " +
            (match.approved_for_use
              ? "bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
              : "border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800")
          }
        >
          {match.approved_for_use ? "Approved ✓" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => onRejectToggle(match.id, !match.user_rejected)}
          aria-pressed={match.user_rejected}
          data-testid="match-reject-button"
          className={
            "rounded px-2 py-1 text-xs font-medium transition-colors " +
            (match.user_rejected
              ? "bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-600"
              : "border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800")
          }
        >
          {match.user_rejected ? "Rejected ✗" : "Reject"}
        </button>
      </footer>
    </article>
  );
}
