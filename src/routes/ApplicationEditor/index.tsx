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
  useEffect,
  useState,
  type ReactElement,
} from "react";
import { useParams } from "react-router-dom";

import { getApplication } from "../../services/applications.ts";
import { subscribeByOwner as subscribeUnitsByOwner } from "../../services/experienceUnits.ts";
import type { ExperienceUnit } from "../../types/capability.ts";
import type { Application } from "../../types/crm.ts";

import ApplicationEditorView, {
  type LoadState,
} from "./ApplicationEditorView.tsx";
import { selectPrimaryResumeAsset } from "./selectPrimaryResumeAsset.ts";

export default function ApplicationEditor(): ReactElement {
  const { applicationId } = useParams<{ applicationId: string }>();
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
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      }
    })();

    unsubUnits = subscribeUnitsByOwner(
      (next) => {
        if (!active) return;
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

  return (
    <ApplicationEditorView
      status={status}
      application={application}
      asset={asset}
      units={units}
      error={error}
    />
  );
}
