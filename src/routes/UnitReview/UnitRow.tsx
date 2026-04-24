/**
 * One row of the Unit Review list. Presentational — receives a Unit
 * and renders it; does not subscribe, write, or subscribe to auth.
 *
 * Per #79 scope, the row shows five columns:
 *   1. `normalized_summary` — primary text
 *   2. `unit_type` — secondary tag
 *   3. Approval state pill — approved / rejected / pending / flagged
 *   4. `confidence_score` — rendered as 0–100 %
 *   5. Source provenance — `source_type · source_ref`
 *
 * Interaction (approve/reject/flag buttons, inline edit) lands in
 * subsequent sub-issues (#81, #82). This component is the render
 * target for both.
 */

import type { ReactElement } from "react";

import type { ExperienceUnit } from "../../types/capability.ts";

export interface UnitRowProps {
  readonly unit: ExperienceUnit;
}

type DisplayState = "approved" | "rejected" | "flagged" | "pending";

/**
 * Derive the user-facing approval state from the three flag fields.
 * Mirrors (read-direction) what `flagsForApprovalState()` does on
 * write. Kept local to the row component because this is display
 * concern — the service's write path is the authoritative mapping.
 */
function displayState(unit: ExperienceUnit): DisplayState {
  if (unit.rejected === true) return "rejected";
  if (unit.flagged === true) return "flagged";
  if (unit.user_approved) return "approved";
  return "pending";
}

/**
 * Tailwind classes per display state. Monochrome + one slate accent
 * (approved = slate) per `docs/design/ui-guidance.md`. Rejected uses
 * a muted zinc so it fades; flagged uses an amber-tinted zinc as a
 * visible-but-not-alarming accent.
 */
const STATE_PILL_CLASSES: Record<DisplayState, string> = {
  approved:
    "bg-slate-900 text-slate-50 dark:bg-slate-100 dark:text-slate-900",
  rejected:
    "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-500",
  flagged:
    "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  pending:
    "bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
};

const STATE_LABELS: Record<DisplayState, string> = {
  approved: "Approved",
  rejected: "Rejected",
  flagged: "Flagged",
  pending: "Pending",
};

/**
 * Format confidence 0–1 as "87%". Clamps to [0, 100] for display so
 * a pathological server-side value (e.g. 1.2) doesn't render as
 * "120%" in the UI.
 */
function formatConfidence(score: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return `${pct}%`;
}

export default function UnitRow({ unit }: UnitRowProps): ReactElement {
  const state = displayState(unit);
  const provenance =
    unit.source_ref.length > 0
      ? `${unit.source_type} · ${unit.source_ref}`
      : unit.source_type;

  return (
    <li
      className="flex items-start gap-4 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800"
      data-state={state}
      data-unit-id={unit.id}
    >
      <div className="flex-1 min-w-0">
        <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">
          {unit.normalized_summary}
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="uppercase tracking-wide">{unit.unit_type}</span>
          <span aria-hidden="true"> · </span>
          <span>{provenance}</span>
          {unit.reembed_pending === true && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="text-amber-700 dark:text-amber-300">
                re-embed pending
              </span>
            </>
          )}
        </p>
      </div>
      <span
        className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATE_PILL_CLASSES[state]}`}
      >
        {STATE_LABELS[state]}
      </span>
      <span
        className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400"
        aria-label={`Confidence ${formatConfidence(unit.confidence_score)}`}
      >
        {formatConfidence(unit.confidence_score)}
      </span>
    </li>
  );
}
