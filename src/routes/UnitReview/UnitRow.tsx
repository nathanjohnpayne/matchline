/**
 * One row of the Unit Review list. Has two modes:
 *
 *   - **view**: the read-only summary-line render used by #79.
 *   - **editing / saving / error**: the inline-edit form from #81
 *     composed under the same <li>, with an optimistic
 *     `applyOptimistic` render of the view row on top so the user
 *     sees their draft in the preview while saving.
 *
 * The "Edit" control is a small pencil-style button on the right
 * side of the row in view mode. Approval / reject / flag buttons
 * (sub-issue #82) will land adjacent to this in the same button
 * cluster.
 */

import { useEffect, useState, type ReactElement } from "react";

import {
  displayStateOf,
  type ApprovalState,
} from "../../services/experienceUnits-state.ts";
import type { ExperienceUnit } from "../../types/capability.ts";

import InlineEditForm from "./InlineEditForm.tsx";
import {
  applyOptimistic,
  draftDiff,
  editableFromUnit,
  type EditableUnitFields,
} from "./inlineEditState.ts";

export interface UnitRowProps {
  readonly unit: ExperienceUnit;
  /**
   * Handler to commit an edit. Receives the changed-fields partial
   * (diff between the draft and the current Unit). The row
   * calls this on Save; the promise's resolve / reject drives the
   * edit-state machine. Absent when the view is rendered without
   * edit-mode wiring (e.g. the `UnitReviewView` tests that pre-date
   * #81).
   */
  readonly onSaveEdit?: (
    id: string,
    partial: Partial<EditableUnitFields>,
  ) => Promise<void>;
}

type DisplayState = ApprovalState;

/**
 * Inline-edit status for this row. Kept local to the row so
 * concurrent edits to two different Units don't cross-contaminate
 * state. The discriminated union mirrors `inlineEditState.ts`.
 */
type EditStatus =
  | { kind: "view" }
  | { kind: "editing"; draft: EditableUnitFields }
  | { kind: "saving"; draft: EditableUnitFields }
  | { kind: "error"; draft: EditableUnitFields; error: Error };

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

function formatConfidence(score: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return `${pct}%`;
}

export default function UnitRow({
  unit,
  onSaveEdit,
}: UnitRowProps): ReactElement {
  const [status, setStatus] = useState<EditStatus>({ kind: "view" });

  // If the underlying Unit changes while we're in view mode (e.g.
  // subscription delivered a new snapshot), nothing to do. If the
  // Unit id itself changes (row re-used for a different Unit —
  // shouldn't happen in the current keyed-by-id list but defensive),
  // drop back to view to avoid showing stale drafts.
  useEffect(() => {
    setStatus({ kind: "view" });
    // Intentional: react only to id changes, not other field
    // changes. A subscription update on the same id during an edit
    // keeps the user's draft in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit.id]);

  const presentedUnit =
    status.kind === "saving" || status.kind === "error"
      ? applyOptimistic(unit, status.draft)
      : unit;

  const state: DisplayState = displayStateOf(presentedUnit);
  const provenance =
    presentedUnit.source_ref.length > 0
      ? `${presentedUnit.source_type} · ${presentedUnit.source_ref}`
      : presentedUnit.source_type;

  const startEdit = () => {
    setStatus({ kind: "editing", draft: editableFromUnit(unit) });
  };

  const cancelEdit = () => {
    setStatus({ kind: "view" });
  };

  const save = async () => {
    if (status.kind !== "editing" && status.kind !== "error") return;
    if (onSaveEdit === undefined) return;
    const draft = status.draft;
    const partial = draftDiff(unit, draft);
    if (Object.keys(partial).length === 0) {
      // No changes; just exit edit mode.
      setStatus({ kind: "view" });
      return;
    }
    setStatus({ kind: "saving", draft });
    try {
      await onSaveEdit(unit.id, partial);
      setStatus({ kind: "view" });
    } catch (err) {
      setStatus({
        kind: "error",
        draft,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  };

  const onDraftChange = (next: EditableUnitFields) => {
    if (status.kind === "editing") {
      setStatus({ kind: "editing", draft: next });
    } else if (status.kind === "error") {
      // Typing while in error state dismisses the error and
      // returns to editing — user is actively fixing.
      setStatus({ kind: "editing", draft: next });
    }
    // Ignore draft changes in saving/view states.
  };

  const formStatus =
    status.kind === "editing"
      ? "editing"
      : status.kind === "saving"
        ? "saving"
        : "error";
  const formError = status.kind === "error" ? status.error : null;

  return (
    <li
      className="border-b border-zinc-200 dark:border-zinc-800"
      data-state={state}
      data-unit-id={unit.id}
      data-edit-mode={status.kind === "view" ? "view" : "editing"}
    >
      <div className="flex items-start gap-4 px-4 py-3">
        <div className="flex-1 min-w-0">
          <p
            className="truncate text-sm text-zinc-900 dark:text-zinc-100"
            title={presentedUnit.normalized_summary}
          >
            {presentedUnit.normalized_summary}
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="uppercase tracking-wide">
              {presentedUnit.unit_type}
            </span>
            <span aria-hidden="true"> · </span>
            <span>{provenance}</span>
            {presentedUnit.reembed_pending === true && (
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
          aria-label={`Confidence ${formatConfidence(presentedUnit.confidence_score)}`}
        >
          {formatConfidence(presentedUnit.confidence_score)}
        </span>
        {onSaveEdit !== undefined && status.kind === "view" && (
          <button
            type="button"
            onClick={startEdit}
            aria-label={`Edit ${unit.normalized_summary}`}
            className="shrink-0 text-xs text-zinc-400 hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-zinc-100"
            data-action="edit"
          >
            Edit
          </button>
        )}
      </div>

      {(status.kind === "editing" ||
        status.kind === "saving" ||
        status.kind === "error") && (
        <InlineEditForm
          draft={status.draft}
          onChange={onDraftChange}
          onSave={save}
          onCancel={cancelEdit}
          status={formStatus}
          error={formError}
        />
      )}
    </li>
  );
}
