/**
 * Application Editor container (#24, PR 1 — shell + read-only render).
 *
 * Wires Firestore reads (Application one-shot, Units snapshot-
 * subscribed) into an `ApplicationEditorView`. Container/view split
 * mirrors UnitReview (#86) and RoleDetail (#129) so the view's
 * rendering shape can be exercised with `renderToStaticMarkup`
 * without mocking Firebase.
 *
 * Subscription lifecycle:
 *   - On mount with an applicationId: status = "loading". Fetch the
 *     Application doc (one-shot — its core fields don't churn within
 *     a session; Units do, hence the subscription) and open the
 *     Units subscription in parallel.
 *   - On Application doc resolved AND Units first snapshot:
 *     status = "ready". Subsequent Units snapshots flow into state
 *     without flipping status (matches RoleDetail's gate).
 *   - On error: status = "error", error = err.
 *   - On unmount or applicationId change: cancel the in-flight
 *     Application fetch via stale-closure guard, call Units unsub.
 *
 * PR 2 will add validation-flag rendering + the export button gate.
 * PR 3 will add inline edit + autosave (likely turning the
 * one-shot Application fetch into a subscription so saves appear
 * promptly across tabs). For PR 1 the read-only one-shot is enough.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useParams } from "react-router-dom";

import {
  addBulletToAsset,
  editBulletInAsset,
  getApplication,
  removeBulletFromAsset,
  reorderBulletsInAsset,
  restoreAssetState,
  type AddableSection,
  type AssetUndoSnapshot,
} from "../../services/applications.ts";
import {
  manualInsert,
  subscribeByOwner as subscribeUnitsByOwner,
} from "../../services/experienceUnits.ts";
import type { ManualUnitInput } from "../../services/experienceUnits-state.ts";
import { invokeValidateAsset } from "../../services/validation.ts";
import type { ExperienceUnit } from "../../types/capability.ts";
import type { Application } from "../../types/crm.ts";

import ApplicationEditorView, {
  type LoadState,
} from "./ApplicationEditorView.tsx";

/**
 * Cap on the undo stack (sub-issue #197). Older entries evict on
 * push. 10 is enough to undo a typical edit session; larger
 * stacks risk holding onto memory for content that will never be
 * restored.
 */
const UNDO_STACK_LIMIT = 10;
import ManualAddForm from "../UnitReview/ManualAddForm.tsx";
import { selectPrimaryResumeAsset } from "./selectPrimaryResumeAsset.ts";

export default function ApplicationEditor(): ReactElement {
  const { applicationId } = useParams<{ applicationId: string }>();
  // Key-based remount per applicationId — without this, navigating
  // between two valid Application IDs paints the previous
  // application's data + status under the new URL for one render
  // before the inner effect resets state. CodeRabbit Major on
  // PR #181. The "__missing__" sentinel keeps the key stable while
  // the URL is empty/undefined so we don't mount-then-immediately-
  // remount on the initial render.
  return (
    <ApplicationEditorInner
      key={applicationId ?? "__missing__"}
      applicationId={applicationId}
    />
  );
}

interface ApplicationEditorInnerProps {
  readonly applicationId: string | undefined;
}

function ApplicationEditorInner({
  applicationId,
}: ApplicationEditorInnerProps): ReactElement {
  const [status, setStatus] = useState<LoadState>("loading");
  const [application, setApplication] = useState<Application | null>(null);
  const [units, setUnits] = useState<readonly ExperienceUnit[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (applicationId === undefined || applicationId === "") {
      // No id in the URL — render the not-found surface rather than
      // sticking on "loading." Mirrors RoleDetail's handling.
      setStatus("ready");
      setApplication(null);
      return;
    }

    setStatus("loading");
    setApplication(null);
    setUnits([]);
    setError(null);

    // Stale-closure guard — same shape as RoleDetail's `active` flag.
    let active = true;
    // The `as` cast prevents TS5's control-flow analysis from
    // narrowing the variable to `null` inside the async IIFE below
    // (where it can't see the synchronous reassignment past the
    // first `await`). Without it, the early-unsubscribe branch
    // narrows to `never` and the function call type-errors.
    let unsubUnits = null as (() => void) | null;
    let appResolved = false;
    let unitsFirstSnapshotReceived = false;
    // `failed` latches when EITHER the Application fetch or the Units
    // subscription terminates with an error. Without it, a Units
    // listener error followed by `getApplication()` resolving to
    // `undefined` (or the symmetric Units-success-after-Units-error
    // pseudo-recovery) would let `setStatus("ready")` overwrite the
    // error surface, producing a false not-found render. Pin per
    // CodeRabbit Major on PR 181.
    let failed = false;

    const maybeMarkReady = () => {
      if (!active || failed) return;
      if (appResolved && unitsFirstSnapshotReceived) {
        setStatus("ready");
      }
    };

    void (async () => {
      try {
        const a = await getApplication(applicationId);
        if (!active) return;
        // Anti-enumeration: the rules layer collapses missing-OR-not-
        // yours into a single denied path. The view renders the
        // not-found state when the doc doesn't come back.
        setApplication(a ?? null);
        appResolved = true;
        if (a === undefined) {
          // No Application means there's nothing for the right pane
          // to gate on — flip ready immediately rather than waiting
          // on Units. But only if no prior error has latched (e.g.
          // a Units subscription error that landed first).
          if (!failed) setStatus("ready");
          // And tear down the Units subscription early — without
          // this, a foreign / not-found applicationId leaves an
          // owner-wide realtime listener open for the lifetime of
          // the route mount (extra reads/cost), and a later listener
          // error could flip the surface from not-found to error.
          // Codex P2 on PR #181.
          //
          // Explicit `if (unsubUnits !== null)` rather than `?.()`:
          // TS5 control-flow narrowing inside this async IIFE looks
          // at the lexical declaration (let ... = null) and infers
          // the variable is still null here, even though the
          // synchronous line below the IIFE assigns it before the
          // microtask resumes. The `if` re-widens the type via the
          // null check.
          if (unsubUnits !== null) {
            unsubUnits();
            unsubUnits = null;
          }
          return;
        }
        maybeMarkReady();
      } catch (err) {
        if (!active) return;
        failed = true;
        // Tear down the Units subscription on Application fetch
        // error too — symmetric with the not-found branch's early
        // unsubscribe. Otherwise an owner-scoped realtime listener
        // keeps consuming reads after the surface has terminated
        // on an error, and a later listener payload can churn
        // state behind the error banner. CodeRabbit Major on
        // PR #181.
        if (unsubUnits !== null) {
          unsubUnits();
          unsubUnits = null;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      }
    })();

    unsubUnits = subscribeUnitsByOwner(
      (next) => {
        // The `failed` gate stops late Units snapshots from
        // overwriting state once an error has latched (either via
        // the Application catch above or this listener's own error
        // branch below). CodeRabbit Major on PR #181.
        if (!active || failed) return;
        setUnits(next);
        unitsFirstSnapshotReceived = true;
        maybeMarkReady();
      },
      (err) => {
        if (!active) return;
        failed = true;
        setUnits([]);
        setError(err);
        setStatus("error");
      },
    );

    return () => {
      active = false;
      unsubUnits?.();
    };
  }, [applicationId]);

  // `generated_assets` is typed as required on `Application`, but the
  // server-side generation + validation paths read it with `?? []`
  // (functions/src/generation/runGenerateResume.ts and
  // functions/src/validation/validate.ts) — i.e. the runtime allows
  // legacy docs to omit the field. Mirror that defense here so a
  // pre-#22 / pre-pipeline Application doesn't crash the editor.
  // Codex P1 on PR #181.
  const asset =
    application !== null
      ? selectPrimaryResumeAsset(application.generated_assets ?? [])
      : null;

  // Manual-add modal state for the "Add a supporting Unit" resolution
  // path (#24, PR 2). Opens the existing UnitReview ManualAddForm in
  // a modal overlay; on submit, calls `manualInsert` and closes. The
  // new Unit appears in the right pane via the Units subscription.
  // PR 3 will wire the new Unit's id back into the offending bullet's
  // `source_unit_ids[]` — for PR 2 the user closes the deadlock by
  // creating the Unit, then re-runs validation.
  const [manualAddOpen, setManualAddOpen] = useState(false);

  // Undo stack (sub-issue #197). Each entry captures the asset's
  // pre-mutation state (content + validation_status + flags) plus a
  // human-readable label. Cap at UNDO_STACK_LIMIT — older entries
  // evict on push. In-memory only (lost on refresh; per V1 scope).
  //
  // The stack is `useState`, not a ref, because the inline Undo
  // affordance + the keyboard handler both need to re-render when
  // the stack length changes (so the affordance hides at empty).
  interface UndoEntry {
    readonly label: string;
    readonly assetId: string;
    readonly snapshot: AssetUndoSnapshot;
  }
  const [undoStack, setUndoStack] = useState<readonly UndoEntry[]>([]);

  // One-shot refetch of the Application after a mutation (e.g. bullet
  // removal). PR 1 fetches once on mount; PR 2's mutations need an
  // explicit refresh because we don't subscribe. PR 3 may switch to
  // a subscription if mutation churn warrants it.
  const refetchApplication = useCallback(async () => {
    if (applicationId === undefined || applicationId === "") return;
    const next = await getApplication(applicationId);
    setApplication(next ?? null);
  }, [applicationId]);

  // Capture-then-commit pattern (Codex P2 round 4 on PR #198).
  // The handlers used to push the undo entry BEFORE the service
  // call landed, but `editBulletInAsset` (and `reorderBulletsInAsset`)
  // can return `no-change` for a no-op write. Pushing on the
  // pre-call path meant repeated no-op saves filled the 10-entry
  // cap with junk entries and evicted real history — Cmd+Z then
  // popped no-op snapshots before reaching a real mutation.
  //
  // Now: handlers call `snapshotAsset(label)` BEFORE the call to
  // capture the pre-mutation state into a local entry, then call
  // `commitUndo(entry)` only after the service confirms an actual
  // change. Returns null when there's no current asset (handler
  // bypasses commit too).
  const snapshotAsset = useCallback(
    (label: string): UndoEntry | null => {
      if (asset === null || asset.generated_content === undefined) return null;
      return {
        label,
        assetId: asset.id,
        snapshot: {
          content: asset.generated_content,
          validation_status: asset.validation_status,
          validation_flags:
            asset.validation_flags === undefined
              ? undefined
              : [...asset.validation_flags],
        },
      };
    },
    [asset],
  );

  const commitUndo = useCallback((entry: UndoEntry): void => {
    setUndoStack((prev) => {
      const next = [...prev, entry];
      return next.length > UNDO_STACK_LIMIT
        ? next.slice(next.length - UNDO_STACK_LIMIT)
        : next;
    });
  }, []);

  const onUndo = useCallback(async (): Promise<void> => {
    if (applicationId === undefined) return;
    if (mutationInFlightRef.current) return;
    // Read the current top of the stack BEFORE pop so the gated
    // call can reject without mutating state.
    const top = undoStack[undoStack.length - 1];
    if (top === undefined) return;
    mutationInFlightRef.current = true;
    // Pop optimistically — the affordance updates immediately so
    // the user sees the stack shrink. If the restore fails, we
    // re-push to keep the stack consistent (the Firestore state
    // didn't change, so the snapshot is still the right next-undo
    // target).
    setUndoStack((prev) => prev.slice(0, prev.length - 1));
    try {
      const r = await restoreAssetState(
        applicationId,
        top.assetId,
        top.snapshot,
      );
      if (r.status !== "restored") {
        // application-/asset-not-found: re-push so the user can
        // retry. Doc layer hasn't changed — same snapshot still
        // applies.
        setUndoStack((prev) => [...prev, top]);
        return;
      }
      try {
        await refetchApplication();
      } catch (err) {
         
        console.warn("refetchApplication failed after undo", err);
      }
    } catch (err) {
       
      console.warn("restoreAssetState failed during undo", err);
      // Re-push on transport failure too so the user can retry.
      setUndoStack((prev) => [...prev, top]);
    } finally {
      mutationInFlightRef.current = false;
    }
  }, [applicationId, refetchApplication, undoStack]);

  // Serialize all asset mutations (edit / remove / add / reorder).
  // Originally a per-handler gate (reorderInFlightRef on PR #196,
  // undoInFlightRef on PR #198), but Codex P1 round 3 on PR #198
  // surfaced a cross-handler bug: two rapid Add clicks before
  // the first refetch both captured the same pre-mutation
  // `asset` from the closure, so both pushed the SAME undo
  // snapshot. The undo stack then collapsed both actions into
  // one revert. Same shape applies to any cross-handler
  // overlap: Edit → Add, Reorder → Edit, etc.
  //
  // Single in-flight ref gates EVERY mutation: pushUndo + service
  // call + refetch run as one atomic unit; subsequent mutations
  // wait for the in-flight one to finish (their click is dropped
  // — the user can re-press). The gate replaces the per-handler
  // reorderInFlightRef + undoInFlightRef.
  const mutationInFlightRef = useRef(false);

  const onReorderBullet = useCallback(
    async (
      section: AddableSection,
      fromIndex: number,
      toIndex: number,
    ): Promise<void> => {
      if (asset === null || applicationId === undefined) return;
      if (mutationInFlightRef.current) return;
      mutationInFlightRef.current = true;
      // Capture pre-mutation snapshot up front (so we capture
      // the state BEFORE refetch races); only commit to the
      // stack if the service confirms a real reorder happened.
      // Codex P2 round 4 on PR #198.
      const undoEntry = snapshotAsset("reorder");
      try {
        const result = await reorderBulletsInAsset(
          applicationId,
          asset.id,
          section,
          fromIndex,
          toIndex,
        );
        if (result.status !== "reordered") {
          // no-change / index-not-found / *-not-found are silent;
          // shouldn't happen from the UI in normal flow (the drag
          // handler bounds-checks before calling). Don't commit
          // the undo snapshot — the asset didn't change.
          return;
        }
        if (undoEntry !== null) commitUndo(undoEntry);
        // Refetch so the pane sees the new order. Skip the
        // validateAsset round-trip — reorder is a position-only
        // change, so existing flags remain valid + the asset's
        // `validation_status` is preserved by the service helper
        // (Codex P1 round 2 on PR #196: marking stale here would
        // permanently block export until the user made an
        // unrelated text edit).
        try {
          await refetchApplication();
        } catch (err) {
           
          console.warn(
            "refetchApplication failed after successful reorder",
            err,
          );
        }
      } catch (err) {
         
        console.warn("reorderBulletsInAsset failed", err);
      } finally {
        mutationInFlightRef.current = false;
      }
    },
    [applicationId, asset, refetchApplication, snapshotAsset, commitUndo],
  );

  const onAddBullet = useCallback(
    async (section: AddableSection): Promise<string | null> => {
      if (asset === null || applicationId === undefined) return null;
      if (mutationInFlightRef.current) return null;
      mutationInFlightRef.current = true;
      // Capture pre-mutation snapshot; commit only on success.
      const undoEntry = snapshotAsset("add");
      try {
        const result = await addBulletToAsset(
          applicationId,
          asset.id,
          section,
        );
        if (result.status !== "added") {
          // application-not-found / asset-not-found shouldn't
          // happen from the editor's UI (we just loaded both).
           
          console.warn("addBulletToAsset returned", result.status);
          return null;
        }
        if (undoEntry !== null) commitUndo(undoEntry);
        // Fresh bullet — just persisted to Firestore. Skip the
        // validateAsset round-trip (an empty bullet has nothing
        // to validate; status is already "stale" which the export
        // gate respects). Refetch so the pane sees the new id +
        // can auto-enter edit mode for it.
        await refetchApplication();
        return result.bulletId;
      } catch (err) {
         
        console.warn("addBulletToAsset failed", err);
        return null;
      } finally {
        mutationInFlightRef.current = false;
      }
    },
    [applicationId, asset, refetchApplication, snapshotAsset, commitUndo],
  );

  const onSaveBulletEdit = useCallback(
    async (bulletId: string, newText: string): Promise<void> => {
      if (asset === null || applicationId === undefined) return;
      if (mutationInFlightRef.current) return;
      mutationInFlightRef.current = true;
      // Capture pre-mutation snapshot up front; commit only on
      // a real "edited" result. no-change / empty-text / *-not-
      // found short-circuit without filling the undo cap with
      // junk. Codex P2 round 4 on PR #198.
      const undoEntry = snapshotAsset("edit");
      try {
      // 1. Patch the Application doc — flips validation_status to
      //    "stale" + clears the bullet's source_unit_ids on success.
      const result = await editBulletInAsset(
        applicationId,
        asset.id,
        bulletId,
        newText,
      );
      if (result.status !== "edited") {
        // No-change is a quiet success (the user opened an editor
        // and saved without modifying text — no orchestrator
        // round-trip needed). Surface the unexpected statuses to
        // the editor inline by throwing; BulletEditor catches and
        // shows the message.
        if (
          result.status === "application-not-found" ||
          result.status === "asset-not-found" ||
          result.status === "bullet-not-found"
        ) {
          throw new Error(
            `Couldn't save edit: ${result.status}. Refresh to reload the latest state.`,
          );
        }
        // empty-text + no-change are silent. Don't commit
        // the undo snapshot — the asset didn't change.
        return;
      }
      // Mutation landed — commit the snapshot now.
      if (undoEntry !== null) commitUndo(undoEntry);
      // 2. Re-run validation server-side. This atomically writes
      //    fresh flags + flips validation_status to passed/failed.
      //    Errors here are non-fatal for the edit itself — the
      //    edit landed; validation just couldn't run. Surface as
      //    a console warning + leave the UI in stale state until
      //    the user retries.
      try {
        await invokeValidateAsset(applicationId, asset.id);
      } catch (err) {
         
        console.warn(
          "validateAsset failed after edit; asset remains in stale state",
          err,
        );
      }
      // 3. Refetch so the editor reflects the fresh flags + status.
      //    Catch + log: the edit + validation already landed
      //    server-side; a transient read failure here shouldn't
      //    bubble up as a "save failed" error to BulletEditor
      //    (it would flip the editor to error state, leave
      //    `lastSavedRef` stale, and prompt the user to retry a
      //    write that already succeeded — duplicate edit +
      //    validation invocation). The next render that depends
      //    on Application state will retry on its own. Codex P2
      //    on PR #192.
      try {
        await refetchApplication();
      } catch (err) {
         
        console.warn(
          "refetchApplication failed after successful edit; UI may be briefly stale",
          err,
        );
      }
      } finally {
        // Outer try/finally wraps the whole post-pushUndo flow so
        // the gate clears on every exit path (success, throw on
        // unexpected status, no-change return, validateAsset
        // error, refetch error). Without this, an early
        // `throw new Error("Couldn't save edit: ...")` would
        // leave the gate locked indefinitely.
        mutationInFlightRef.current = false;
      }
    },
    [applicationId, asset, refetchApplication, snapshotAsset, commitUndo],
  );

  const onRemoveBullet = useCallback(
    async (bulletId: string) => {
      if (asset === null) return;
      if (mutationInFlightRef.current) return;
      mutationInFlightRef.current = true;
      // Capture pre-mutation snapshot; commit only on success.
      const undoEntry = snapshotAsset("remove");
      try {
        const result = await removeBulletFromAsset(
          applicationId ?? "",
          asset.id,
          bulletId,
        );
        if (result.status === "removed") {
          if (undoEntry !== null) commitUndo(undoEntry);
          await refetchApplication();
        }
        // Other result statuses are silent for now — application-/
        // asset-not-found shouldn't happen from the editor's UI (we
        // just loaded both), and bullet-not-found means a concurrent
        // edit already removed it. PR 3's autosave + edit flow will
        // surface these via inline errors when there's a real input
        // surface for them to attach to.
      } catch (err) {
        // Swallow + log so the caller's onClick promise doesn't
        // surface as an unhandled rejection. PR 2 has no toast UI;
        // a future visible error surface will replace this log.
        // CodeRabbit Major on PR #182.
         
        console.warn("removeBulletFromAsset failed", err);
      } finally {
        mutationInFlightRef.current = false;
      }
    },
    [applicationId, asset, refetchApplication, snapshotAsset, commitUndo],
  );

  const onAddSupportingUnit = useCallback(() => {
    setManualAddOpen(true);
  }, []);

  const onSubmitManualAdd = useCallback(
    async (input: ManualUnitInput) => {
      // `manualInsert` stamps source_type:"manual",
      // user_approved:true, etc. via experienceUnits-state.ts's
      // `buildManualUnit`. The Units subscription delivers the new
      // Unit on the next snapshot, so the right pane and chip
      // lookup pick it up automatically.
      //
      // ManualAddForm catches and inlines submit errors via its own
      // try/catch; rethrow keeps that in-form error surface working
      // (the user sees a message and can adjust + retry without
      // losing their input). Don't close the modal on rejection.
      // CodeRabbit Major on PR #182.
      try {
        await manualInsert(input);
        setManualAddOpen(false);
      } catch (err) {
         
        console.warn("manualInsert failed", err);
        throw err;
      }
    },
    [],
  );

  const onCloseManualAdd = useCallback(() => setManualAddOpen(false), []);

  // Export action — Phase 2 (PDF/DOCX) per the issue spec is a
  // non-goal for #24. PR 2 wires the gate; the click handler is a
  // placeholder that logs, so a future hookup can replace this
  // single line. Disabled state is computed in the view from the
  // asset's `validation_status`.
  const onExport = useCallback(() => {
     
    console.info("Export not yet implemented (Phase 2)", {
      applicationId,
      assetId: asset?.id,
    });
  }, [applicationId, asset]);

  return (
    <>
      <ApplicationEditorView
        status={status}
        application={application}
        asset={asset}
        units={units}
        error={error}
        onRemoveBullet={onRemoveBullet}
        onAddSupportingUnit={onAddSupportingUnit}
        onExport={onExport}
        onSaveBulletEdit={onSaveBulletEdit}
        onAddBullet={onAddBullet}
        onReorderBullet={onReorderBullet}
        undoLabel={undoStack[undoStack.length - 1]?.label}
        onUndo={undoStack.length > 0 ? onUndo : undefined}
      />
      {manualAddOpen && (
        <ManualAddForm
          onSubmit={onSubmitManualAdd}
          onClose={onCloseManualAdd}
        />
      )}
    </>
  );
}
