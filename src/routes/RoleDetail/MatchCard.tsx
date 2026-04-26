/**
 * Single UnitMatch card. Read-only render for sub-issue
 * #129. Approve / Reject buttons + sub-score breakdown
 * ship in #130 + #131 respectively.
 *
 * Renders:
 *   - The matched Unit's `normalized_summary` as the
 *     headline.
 *   - The `final_score` as a 0–100 number with 1 decimal.
 *   - The `rationale` explaining why the match scores
 *     where it does.
 *   - The `surface_evidence` — the specific piece of
 *     ground-truth content from the Unit being matched.
 *
 * The Unit's `normalized_summary` lookup happens in the
 * parent (MatchesTab) via the unit-id → Unit map; this
 * component is purely presentational and receives the
 * pre-resolved Unit (or null if the unit was deleted
 * between the matching pipeline's persist and this read).
 */

import type { ReactElement } from "react";

import type { ExperienceUnit, UnitMatch } from "../../types/capability.ts";

export interface MatchCardProps {
  readonly match: UnitMatch;
  readonly unit: ExperienceUnit | null;
}

export default function MatchCard({
  match,
  unit,
}: MatchCardProps): ReactElement {
  // 0-100 with 1 decimal — readable score, not a precision
  // signal. Score breakdown for the curious lives in #131's
  // tooltip.
  const score100 = (match.final_score * 100).toFixed(1);

  return (
    <article
      className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 space-y-2 bg-white dark:bg-zinc-900"
      data-testid="match-card"
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
    </article>
  );
}
