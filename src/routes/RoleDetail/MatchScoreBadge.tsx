/**
 * Score badge with sub-score breakdown tooltip (#131).
 * Replaces the inline `final_score` rendering in
 * `MatchCard`.
 *
 * Visible: the final score as 0–100 with 1 decimal.
 *
 * Hover/focus tooltip shows:
 *   - The 7 weighted sub-components from
 *     `buildBreakdownRows`, each with sub-score + weight
 *     + contribution.
 *   - The Unit's `confidence_score` as the multiplier
 *     applied to `rule_score` to produce `final_score`.
 *
 * Accessibility:
 *   - Badge has `tabIndex={0}` so keyboard users can focus
 *     it.
 *   - `aria-describedby` on the badge points to the
 *     popover (#131 spec).
 *   - Popover is rendered always (CSS-controlled visibility
 *     via `:hover` + `:focus-within` on the wrapper) so
 *     screen readers can find it via the `aria-describedby`
 *     reference even when the wrapper isn't actively
 *     hovered/focused. SSR-safe.
 *
 * Legacy data: pre-#131 matches in storage don't have
 * `components` populated. The breakdown helper returns
 * `null` and the tooltip renders a "rerun matching to see
 * the breakdown" hint.
 */

import { useId, type ReactElement } from "react";

import type { ScoreComponents } from "../../types/capability.ts";

import { buildBreakdownRows } from "./scoreBreakdown.ts";

export interface MatchScoreBadgeProps {
  /** Final score in [0, 1]; rendered as 0–100 with 1 decimal. */
  readonly finalScore: number;
  /** Persisted sub-components — `undefined` for legacy rows. */
  readonly components: ScoreComponents | undefined;
  /**
   * Source Unit's `confidence_score` in [0, 1]. Multiplied
   * against `rule_score` to produce `final_score`.
   * `null` when the source Unit isn't in the loaded set
   * (deleted between matching persist and read).
   */
  readonly confidence: number | null;
}

export default function MatchScoreBadge({
  finalScore,
  components,
  confidence,
}: MatchScoreBadgeProps): ReactElement {
  const popoverId = useId();
  const score100 = (finalScore * 100).toFixed(1);
  const rows = buildBreakdownRows(components);

  return (
    <span
      className="relative inline-block group"
      data-testid="match-score-badge"
    >
      <span
        tabIndex={0}
        role="button"
        aria-describedby={popoverId}
        aria-label={`Match score: ${score100} out of 100. Hover or focus for the breakdown.`}
        className="shrink-0 rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs font-mono tabular-nums text-zinc-700 dark:text-zinc-300 cursor-help focus:outline-none focus:ring-2 focus:ring-zinc-500"
      >
        {score100}
      </span>
      <span
        id={popoverId}
        role="tooltip"
        data-testid="match-score-popover"
        className="invisible group-hover:visible group-focus-within:visible absolute z-10 right-0 top-full mt-1 w-72 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 shadow-lg text-xs space-y-1.5"
      >
        {rows === null ? (
          <p
            className="italic text-zinc-500"
            data-testid="match-score-breakdown-unavailable"
          >
            Breakdown unavailable for this match. Re-run matching to populate
            the per-component scores.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 gap-y-0.5 items-baseline">
              <span className="font-medium text-zinc-500 uppercase tracking-wide">
                Component
              </span>
              <span className="font-medium text-zinc-500 uppercase tracking-wide text-right">
                Score
              </span>
              <span className="font-medium text-zinc-500 uppercase tracking-wide text-right">
                Weight
              </span>
              <span className="font-medium text-zinc-500 uppercase tracking-wide text-right">
                Contrib
              </span>
              {rows.map((row) => (
                <span key={row.key} className="contents" data-testid="match-score-row">
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {row.label}
                  </span>
                  <span className="font-mono tabular-nums text-right text-zinc-900 dark:text-zinc-100">
                    {row.value.toFixed(2)}
                  </span>
                  <span className="font-mono tabular-nums text-right text-zinc-500">
                    ×{row.weight.toFixed(2)}
                  </span>
                  <span className="font-mono tabular-nums text-right text-zinc-700 dark:text-zinc-300">
                    {row.contribution.toFixed(3)}
                  </span>
                </span>
              ))}
            </div>
            <div className="border-t border-zinc-200 dark:border-zinc-700 pt-1.5 mt-1.5 text-zinc-600 dark:text-zinc-400">
              {confidence !== null ? (
                <p data-testid="match-score-confidence">
                  Unit confidence multiplier:{" "}
                  <span className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                    ×{confidence.toFixed(2)}
                  </span>
                </p>
              ) : (
                <p
                  className="italic text-zinc-500"
                  data-testid="match-score-confidence-missing"
                >
                  Source Unit unavailable; confidence multiplier hidden.
                </p>
              )}
              <p className="text-zinc-500 mt-0.5">
                Final score = Σ(score × weight) × confidence.
              </p>
            </div>
          </>
        )}
      </span>
    </span>
  );
}
