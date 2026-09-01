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
 *   - Approve / Reject buttons. Visual state is derived
 *     via `approvalStateOf(match)`:
 *       "none"      → "Approve" + "Reject" both clickable
 *       "approved"  → "Approved ✓" (clickable to revert)
 *       "rejected"  → "Rejected ✗" (clickable to revert)
 *
 * Click semantics (single-setter, #133 r1):
 *   - Each click computes the NEXT `MatchApprovalState`
 *     locally and calls `onApprovalStateChange(matchId,
 *     nextState)` once. The container issues exactly one
 *     `updateDoc` per click; per-doc per-client Firestore
 *     write ordering means the LAST submitted write wins
 *     deterministically — no out-of-order race across
 *     offline resync, multi-tab, or rapid double-clicks.
 *   - Approve button: toggles between "approved" and
 *     "none" (revert).
 *   - Reject button: toggles between "rejected" and
 *     "none" (revert).
 *   - Mutual exclusion is structural in the enum:
 *     "approved" and "rejected" are distinct values.
 *     Clicking Approve on a rejected match goes to
 *     "approved" directly; the persisted flag pair
 *     becomes `{ approved_for_use: true, user_rejected:
 *     false }` atomically.
 */

import type { ReactElement } from "react";

import type { ExperienceUnit, UnitMatch } from "../../types/capability.ts";
import {
  approvalStateOf,
  type MatchApprovalState,
} from "../../services/matches.ts";

import MatchScoreBadge from "./MatchScoreBadge.tsx";

export interface MatchCardProps {
  readonly match: UnitMatch;
  readonly unit: ExperienceUnit | null;
  /**
   * True while a matching run is in flight. The run replaces
   * the Role's entire match set — `replaceMatchesForRole()`
   * deletes every existing doc and writes replacements under
   * NEW ids — so a click landing between the transaction
   * committing and the subscription delivering would target a
   * deleted id, fail in the console only, and silently lose the
   * user's decision. Codex P2 on #435.
   *
   * Disabling is the honest surface: the decision cannot be
   * recorded right now, so don't accept it and pretend.
   */
  readonly actionsDisabled?: boolean;
  readonly onApprovalStateChange: (
    matchId: string,
    state: MatchApprovalState,
  ) => void;
}

export default function MatchCard({
  match,
  unit,
  actionsDisabled = false,
  onApprovalStateChange,
}: MatchCardProps): ReactElement {
  const state = approvalStateOf(match);

  const onClickApprove = () => {
    // Approve toggles between "approved" and "none." If the
    // match was previously "rejected", a single click flips
    // straight to "approved" (mutual exclusion via the enum,
    // not a two-step revert).
    onApprovalStateChange(match.id, state === "approved" ? "none" : "approved");
  };
  const onClickReject = () => {
    onApprovalStateChange(match.id, state === "rejected" ? "none" : "rejected");
  };

  return (
    <article
      className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 space-y-2 bg-white dark:bg-zinc-900"
      data-testid="match-card"
      data-approval-state={state}
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
        <MatchScoreBadge
          finalScore={match.final_score}
          components={match.components}
          confidence={unit !== null ? unit.confidence_score : null}
        />
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
          disabled={actionsDisabled}
          title={
            actionsDisabled
              ? "Re-scoring this Role — approvals are paused so a decision isn't lost."
              : undefined
          }
          onClick={onClickApprove}
          aria-pressed={state === "approved"}
          data-testid="match-approve-button"
          className={
            "rounded px-2 py-1 text-xs font-medium transition-colors " +
            (state === "approved"
              ? "bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
              : "border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800")
          }
        >
          {state === "approved" ? "Approved ✓" : "Approve"}
        </button>
        <button
          type="button"
          disabled={actionsDisabled}
          title={
            actionsDisabled
              ? "Re-scoring this Role — approvals are paused so a decision isn't lost."
              : undefined
          }
          onClick={onClickReject}
          aria-pressed={state === "rejected"}
          data-testid="match-reject-button"
          className={
            "rounded px-2 py-1 text-xs font-medium transition-colors " +
            (state === "rejected"
              ? "bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-600"
              : "border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800")
          }
        >
          {state === "rejected" ? "Rejected ✗" : "Reject"}
        </button>
      </footer>
    </article>
  );
}
