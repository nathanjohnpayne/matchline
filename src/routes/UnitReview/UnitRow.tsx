/**
 * One row of the Unit Review list. Has two modes:
 *
 *   - **view**: the read-only summary-line render used by #79.
 *   - **editing / saving / error**: the inline-edit form from #81
 *     composed under the same <li>, with an optimistic
 *     `applyOptimistic` render of the view row on top so the user
 *     sees their draft in the preview while saving.
 *
 * Action buttons in the right cluster (view mode only): Approve,
 * Flag, Reject, Edit. Reject opens an inline confirmation
 * because rejected Units are excluded from matching — that's a
 * decision worth a one-click confirm. Approve and Flag commit
 * directly. The integration test in
 * `tests/rejected-exclusion.integration.test.ts` pins the
 * zero-fabrication invariant end-to-end (#82).
 */

import { useEffect, useState, type ReactElement } from "react";

import {
  displayStateOf,
  type ApprovalState,
} from "../../services/experienceUnits-state.ts";
import type { ExperienceUnit } from "../../types/capability.ts";

import InlineEditForm from "./InlineEditForm.tsx";
import {
  draftDiff,
  editableFromUnit,
  presentationUnit,
  shouldShowRejectConfirm,
  type ApprovalUiStatus,
  type EditableUnitFields,
  type EditStatus,
} from "./inlineEditState.ts";
import { beginAppBusy, beginUnsavedWork } from "../../lib/appBusy.ts";

export interface UnitRowProps {
  readonly unit: ExperienceUnit;
  /**
   * Handler to commit an edit. Receives the changed-fields partial
   * (diff between the draft and the current Unit). The row
   * calls this on Save; the promise's resolve / reject drives the
   * edit-state machine. Absent when the view is rendered without
   * edit-mode wiring.
   */
  readonly onSaveEdit?: (
    id: string,
    partial: Partial<EditableUnitFields>,
  ) => Promise<void>;
  /**
   * Handler to flip the Unit's approval state via `setApproval`.
   * The row calls this from the Approve / Reject / Flag buttons.
   * Absent when the view is rendered without action wiring (the
   * pre-#82 view-only tests). Reject path passes through a
   * confirmation step in the row itself before invoking the
   * handler — the handler doesn't see a second-thoughts cancel.
   */
  readonly onSetApproval?: (
    id: string,
    state: ApprovalState,
  ) => Promise<void>;
}

type DisplayState = ApprovalState;

// EditStatus is imported from inlineEditState.ts so the row's
// state shape and the pure helpers (presentationUnit, draftDiff,
// applyMetricUpdate) all agree on the discriminated-union
// definition. Each row owns its own useState<EditStatus> so
// concurrent edits to two different Units can't cross-contaminate.

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
  const safeScore = Number.isFinite(score) ? score : 0;
  const pct = Math.round(Math.max(0, Math.min(1, safeScore)) * 100);
  return `${pct}%`;
}

// ApprovalUiStatus is imported from inlineEditState.ts so the
// row's state shape and the pure gate predicate
// (`shouldShowRejectConfirm`) agree on the discriminated-union
// definition.

export default function UnitRow({
  unit,
  onSaveEdit,
  onSetApproval,
}: UnitRowProps): ReactElement {
  const [status, setStatus] = useState<EditStatus>({ kind: "view" });

  // An open inline edit holds its draft only in React state, so the
  // update banner must confirm before a reload discards it (#456).
  //
  // Unlike the busy leases in this file, an effect is the right shape
  // here: unsaved work IS a property of render state (an editor is
  // open with a draft), not of a promise, so acquiring after the
  // commit and releasing on unmount is exactly the desired lifetime.
  //
  // "saving" holds this lease too. The write is in flight, so that is
  // the window where a reload does the MOST damage — the edit is
  // neither in the document nor recoverable from the form. The busy
  // lease already suppresses the prompt outright then; keeping the
  // unsaved lease as well means a failed save drops back to "error"
  // with the draft still protected, rather than opening a gap.
  useEffect(() => {
    if (status.kind === "view") return;
    return beginUnsavedWork("unitReview.inlineEdit");
  }, [status.kind]);


  const [approvalUi, setApprovalUi] = useState<ApprovalUiStatus>({
    kind: "idle",
  });

  // If the underlying Unit changes while we're in view mode (e.g.
  // subscription delivered a new snapshot), nothing to do. If the
  // Unit id itself changes (row re-used for a different Unit —
  // shouldn't happen in the current keyed-by-id list but defensive),
  // drop back to view to avoid showing stale drafts.
  useEffect(() => {
    setStatus({ kind: "view" });
    setApprovalUi({ kind: "idle" });
    // Intentional: react only to id changes, not other field
    // changes. A subscription update on the same id during an edit
    // keeps the user's draft in place.

  }, [unit.id]);

  const handleApproval = async (state: ApprovalState) => {
    if (onSetApproval === undefined) return;
    setApprovalUi({ kind: "pending" });
    // Acquired synchronously, not from an effect keyed on the pending
    // state. An effect runs after the commit, so the write starts
    // unleased, and unmounting — navigating away from the review list —
    // runs its cleanup while the Firestore promise is still outstanding.
    // Either window leaves Reload actionable over a pending write
    // (Codex P1, #434). Bound to this invocation, released in its
    // finally.
    const releaseBusy = beginAppBusy("unitReview.setApproval");
    try {
      await onSetApproval(unit.id, state);
      setApprovalUi({ kind: "idle" });
    } catch (err) {
      setApprovalUi({
        kind: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      releaseBusy();
    }
  };

  const requestReject = () => {
    if (onSetApproval === undefined) return;
    setApprovalUi({ kind: "confirming-reject" });
  };
  const cancelReject = () => {
    setApprovalUi({ kind: "idle" });
  };
  const confirmReject = () => {
    void handleApproval("rejected");
  };

  const approvalPending = approvalUi.kind === "pending";
  const showApprovalButtons =
    onSetApproval !== undefined && status.kind === "view";
  // Pure predicate — see `shouldShowRejectConfirm` docstring.
  // The three preconditions (handler wired + confirming-reject
  // approval state + view-mode edit status) are tested in
  // inlineEditState.test.ts so a refactor that drops one of
  // them fails the unit test, not just runtime UX.
  const showRejectConfirm = shouldShowRejectConfirm(
    approvalUi,
    status,
    onSetApproval !== undefined,
  );
  const approvalError =
    approvalUi.kind === "error" ? approvalUi.error : null;

  // Row preview policy lives in `presentationUnit` (pure):
  //   - view / editing / error: live persisted Unit
  //   - saving: optimistic merge of draft over edit-start snapshot
  // See `presentationUnit` docstring for rationale.
  const presentedUnit = presentationUnit(unit, status);

  const state: DisplayState = displayStateOf(presentedUnit);
  const provenance =
    presentedUnit.source_ref.length > 0
      ? `${presentedUnit.source_type} · ${presentedUnit.source_ref}`
      : presentedUnit.source_type;

  const startEdit = () => {
    // Clear any in-flight approval UI on entering edit mode.
    // The action cluster (Approve/Flag/Reject + the reject
    // confirmation panel) is gated on status.kind === "view",
    // so leaving approvalUi at e.g. "confirming-reject" while
    // entering edit mode would leave the confirmation panel
    // rendered alongside the edit form — overlapping state
    // machines, and a click on the panel's Reject button would
    // commit while the user thinks they're editing. Codex P2
    // on #93.
    setApprovalUi({ kind: "idle" });
    // Snapshot the live Unit as our diff base. All subsequent
    // comparisons and the optimistic render happen against this
    // snapshot, not the subscription's latest echo — the user
    // edits a stable target.
    setStatus({
      kind: "editing",
      draft: editableFromUnit(unit),
      baseSnapshot: unit,
    });
  };

  const cancelEdit = () => {
    setStatus({ kind: "view" });
  };

  const save = async () => {
    if (status.kind !== "editing" && status.kind !== "error") return;
    if (onSaveEdit === undefined) return;
    const { draft, baseSnapshot } = status;
    // Diff the draft against the EDIT-START snapshot, not the
    // live `unit` prop. nathanpayne-codex Phase 4b on #90 caught
    // this: if a concurrent subscription update lands mid-edit
    // (re-embed callable clearing the pending flag, another tab,
    // etc.), the live base has drifted and diffing against it
    // would (a) silently drop fields the user edited but whose
    // new value happens to equal the drifted base, or (b)
    // spuriously include base-side changes the user didn't
    // touch. The snapshot is stable from click-Edit to
    // click-Save.
    const partial = draftDiff(baseSnapshot, draft);
    if (Object.keys(partial).length === 0) {
      // No changes; just exit edit mode.
      setStatus({ kind: "view" });
      return;
    }
    setStatus({ kind: "saving", draft, baseSnapshot });
    // Same reasoning as `handleApproval`: the lease is bound to this
    // invocation rather than to a render state, so it covers the write
    // from the moment it starts until it settles, and survives unmount.
    const releaseBusy = beginAppBusy("unitReview.saveEdit");
    try {
      await onSaveEdit(baseSnapshot.id, partial);
      setStatus({ kind: "view" });
    } catch (err) {
      setStatus({
        kind: "error",
        draft,
        baseSnapshot,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      releaseBusy();
    }
  };

  const onDraftChange = (next: EditableUnitFields) => {
    if (status.kind === "editing") {
      setStatus({ kind: "editing", draft: next, baseSnapshot: status.baseSnapshot });
    } else if (status.kind === "error") {
      // Typing while in error state dismisses the error and
      // returns to editing — user is actively fixing. The
      // baseSnapshot is preserved so the retry still diffs
      // against the original edit-start base.
      setStatus({
        kind: "editing",
        draft: next,
        baseSnapshot: status.baseSnapshot,
      });
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
        {showApprovalButtons && (
          <div
            className="flex shrink-0 items-center gap-2 text-xs"
            data-action-cluster="true"
          >
            <button
              type="button"
              onClick={() => void handleApproval("approved")}
              disabled={approvalPending || state === "approved"}
              aria-label={`Approve ${unit.normalized_summary}`}
              className="text-zinc-400 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-zinc-100"
              data-action="approve"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => void handleApproval("flagged")}
              disabled={approvalPending || state === "flagged"}
              aria-label={`Flag ${unit.normalized_summary} for review`}
              className="text-zinc-400 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-zinc-100"
              data-action="flag"
            >
              Flag
            </button>
            <button
              type="button"
              onClick={requestReject}
              disabled={approvalPending || state === "rejected"}
              aria-label={`Reject ${unit.normalized_summary}`}
              className="text-zinc-400 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-zinc-100"
              data-action="reject"
            >
              Reject
            </button>
          </div>
        )}
        {onSaveEdit !== undefined && status.kind === "view" && (
          <button
            type="button"
            onClick={startEdit}
            disabled={approvalPending}
            aria-label={`Edit ${unit.normalized_summary}`}
            className="shrink-0 text-xs text-zinc-400 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-zinc-100"
            data-action="edit"
          >
            Edit
          </button>
        )}
      </div>

      {showRejectConfirm && (
        <div
          role="dialog"
          aria-label="Confirm reject"
          className="border-t border-zinc-200 bg-amber-50 px-4 py-3 dark:border-zinc-800 dark:bg-amber-950"
          data-confirm="reject"
        >
          <p className="text-sm text-amber-900 dark:text-amber-200">
            Reject this Unit? Rejected Units stay in the database
            but are excluded from matching.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={confirmReject}
              disabled={approvalPending}
              className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              data-action="confirm-reject"
            >
              {approvalPending ? "Rejecting…" : "Reject"}
            </button>
            <button
              type="button"
              onClick={cancelReject}
              disabled={approvalPending}
              className="rounded-md px-3 py-1 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
              data-action="cancel-reject"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {approvalError !== null && (
        <div
          role="alert"
          className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          data-approval-error="true"
        >
          Action failed: {approvalError.message}
        </div>
      )}

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
