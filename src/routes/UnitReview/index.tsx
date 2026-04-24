/**
 * Unit Review container. Wires the Firestore subscription (via
 * `subscribeByOwner` from sub-issue #78) into a `UnitReviewView`.
 *
 * The split between this container and `UnitReviewView` lets the
 * view's rendering shape be exercised in isolation with
 * `renderToStaticMarkup`, matching the convention used by the
 * Wordmark component and the pure-helper split in
 * `src/services/experienceUnits-state.ts`.
 *
 * Subscription lifecycle:
 *   - On mount: status = "loading". Subscribe via `subscribeByOwner`.
 *     The service layer throws if no user is signed in; the
 *     `AuthProvider` gate in `App.tsx` ensures we never render this
 *     route without a resolved user.
 *   - On first snapshot: status = "ready", units = snapshot payload.
 *   - On error: status = "error", error = err. nathanpayne-codex
 *     review on #86 caught the prior loading/empty conflation — a
 *     fresh mount was rendering "No Experience Units yet" before the
 *     first snapshot arrived, and the empty state also rendered under
 *     the error banner. Three states must be distinct: pre-first-
 *     snapshot loading, terminal error, genuinely-empty corpus.
 *   - On unmount: call the returned `Unsubscribe`.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  manualInsert,
  setApproval,
  subscribeByOwner,
  updateFields,
} from "../../services/experienceUnits.ts";
import type {
  ApprovalState,
  ManualUnitInput,
} from "../../services/experienceUnits-state.ts";
import type { ExperienceUnit } from "../../types/capability.ts";

import type { EditableUnitFields } from "./inlineEditState.ts";
import UnitReviewView, { type LoadState } from "./UnitReviewView.tsx";
import { useFilterState } from "./useFilterState.ts";

export default function UnitReview(): ReactElement {
  const [status, setStatus] = useState<LoadState>("loading");
  const [units, setUnits] = useState<readonly ExperienceUnit[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [manualAddOpen, setManualAddOpen] = useState(false);
  const { filters, setFilters, clearFilters } = useFilterState();

  const onSaveEdit = useCallback(
    async (id: string, partial: Partial<EditableUnitFields>) => {
      // Service layer's updateFields owns re-embed-flag setting,
      // updated_at stamping, and the state-machine-owned-field
      // guard (throws if `user_approved` / `rejected` / `flagged`
      // / `reembed_pending` / identity fields slip in — they
      // shouldn't, the EditableUnitFields type excludes them, but
      // belt-and-suspenders). The row's save flow catches any
      // reject and surfaces it as an inline error; the
      // subscription's next snapshot carries the written state.
      await updateFields(id, partial);
    },
    [],
  );

  const onAddManually = useCallback(() => setManualAddOpen(true), []);
  const onCloseManualAdd = useCallback(() => setManualAddOpen(false), []);
  const onSubmitManualAdd = useCallback(
    async (input: ManualUnitInput) => {
      // The service layer's manualInsert delegates to the pure
      // `buildManualUnit` for stamping (source_type, evidence_type,
      // confidence_score default, user_approved default,
      // reembed_pending: true) — so this handler stays tiny. On
      // success we close the modal; the subscription's next
      // snapshot delivers the new Unit. On error the form
      // surfaces the message inline; we leave the modal open so
      // the user can adjust + retry.
      await manualInsert(input);
      setManualAddOpen(false);
    },
    [],
  );

  const onSetApproval = useCallback(
    async (id: string, state: ApprovalState) => {
      // Service's setApproval ALWAYS writes the full
      // user_approved / rejected / flagged triple via
      // flagsForApprovalState — guarantees a state transition
      // can't leave a stale flag from the prior state. The row's
      // approval-button cluster catches any reject and surfaces
      // it inline. The rejected-exclusion integration test in
      // tests/rejected-exclusion.integration.test.ts pins the
      // zero-fabrication invariant end-to-end against the
      // matching pipeline's input query.
      await setApproval(id, state);
    },
    [],
  );

  useEffect(() => {
    // Reset to loading on each subscribe so a resubscribe (e.g. if
    // the route re-mounts after a sign-out/sign-in cycle) doesn't
    // carry a stale error or stale units.
    setStatus("loading");
    setError(null);
    setUnits([]);

    const unsubscribe = subscribeByOwner(
      (next) => {
        setUnits(next);
        setStatus("ready");
      },
      (err) => {
        // Clear the prior snapshot on error transition. Belt-and-
        // suspenders against any future code that reads `units`
        // outside the `status === "ready"` gate — a successful
        // snapshot followed by an error (e.g. a rules change, a
        // transient permission flip) would otherwise leave stale
        // Units in state that the view's non-ready branches could
        // pick up. nathanpayne-codex Phase 4b round 2 on #86.
        //
        // Firestore's onSnapshot error is terminal for the
        // subscription — no auto-recovery happens here. The stale
        // data would sit until the component unmounts. Clearing
        // now matches the semantic of "this subscription is dead."
        setUnits([]);
        setError(err);
        setStatus("error");
      },
    );
    return unsubscribe;
  }, []);

  return (
    <UnitReviewView
      status={status}
      units={units}
      error={error}
      filters={filters}
      onFiltersChange={setFilters}
      onClearFilters={clearFilters}
      onSaveEdit={onSaveEdit}
      onSetApproval={onSetApproval}
      onAddManually={onAddManually}
      manualAddOpen={manualAddOpen}
      onSubmitManualAdd={onSubmitManualAdd}
      onCloseManualAdd={onCloseManualAdd}
    />
  );
}
