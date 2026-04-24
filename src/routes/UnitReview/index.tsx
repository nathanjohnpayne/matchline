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
 *   - On mount: subscribe via `subscribeByOwner`. The service layer
 *     throws if no user is signed in; the `AuthProvider` gate in
 *     `App.tsx` ensures we never render this route without a
 *     resolved user.
 *   - On snapshot: update local state.
 *   - On error: capture into local state for the view to surface.
 *   - On unmount: call the returned `Unsubscribe`.
 */

import { useEffect, useState, type ReactElement } from "react";

import { subscribeByOwner } from "../../services/experienceUnits.ts";
import type { ExperienceUnit } from "../../types/capability.ts";

import UnitReviewView from "./UnitReviewView.tsx";

export default function UnitReview(): ReactElement {
  const [units, setUnits] = useState<readonly ExperienceUnit[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Reset error on each subscribe attempt so a transient rules
    // rejection doesn't persist across a resubscribe.
    setError(null);
    const unsubscribe = subscribeByOwner(
      (next) => setUnits(next),
      (err) => setError(err),
    );
    return unsubscribe;
  }, []);

  return <UnitReviewView units={units} error={error} />;
}
