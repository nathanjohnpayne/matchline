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

import { useEffect, useState, type ReactElement } from "react";

import { subscribeByOwner } from "../../services/experienceUnits.ts";
import type { ExperienceUnit } from "../../types/capability.ts";

import UnitReviewView, { type LoadState } from "./UnitReviewView.tsx";

export default function UnitReview(): ReactElement {
  const [status, setStatus] = useState<LoadState>("loading");
  const [units, setUnits] = useState<readonly ExperienceUnit[]>([]);
  const [error, setError] = useState<Error | null>(null);

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

  return <UnitReviewView status={status} units={units} error={error} />;
}
