/**
 * Presentational component for the Unit Review surface. Receives
 * pre-fetched Units + an error state as props; does not subscribe or
 * talk to Firestore. Split from the container (`index.tsx`) so the
 * rendering shape can be exercised with `renderToStaticMarkup`
 * without mocking Firebase — matching the pattern used by the
 * Wordmark component.
 *
 * The container is responsible for:
 *   - subscribing to Firestore via `subscribeByOwner`
 *   - unsubscribing on unmount
 *   - handling loading + error states at the subscription layer
 *
 * This component is responsible for:
 *   - applying the rejected-exclusion filter (default for the main list)
 *   - rendering the empty state OR the list
 *   - rendering the approval counter
 */

import type { ReactElement } from "react";

import type { ExperienceUnit } from "../../types/capability.ts";

import ApprovalCounter from "./ApprovalCounter.tsx";
import EmptyState from "./EmptyState.tsx";
import UnitRow from "./UnitRow.tsx";
import {
  countApproved,
  excludeRejected,
  sortByUpdatedDesc,
} from "./filterUnits.ts";

/**
 * Subscription load state. Explicit three-way discriminated union
 * so loading, error, and "genuinely empty" never render the same
 * way. nathanpayne-codex review on #86 caught the prior
 * conflation: with a single `units: []` prop, a fresh mount showed
 * "No Experience Units yet" before the first Firestore snapshot
 * arrived (false empty), and on error the empty state rendered
 * under the error banner (double-misleading surface).
 */
export type LoadState = "loading" | "error" | "ready";

export interface UnitReviewViewProps {
  /**
   * Subscription state discriminator. Required — there is no
   * sensible default because every rendering branch depends on
   * which of the three states we're in.
   */
  readonly status: LoadState;
  /**
   * Full owner-scoped Unit set from the Firestore subscription.
   * Meaningful only when `status === "ready"`; should be an empty
   * array in the "loading" and "error" branches. Rejected Units
   * are included here — the view applies the rejected-exclusion
   * filter before rendering. Future filter sub-issue (#80)
   * composes additional filters on top.
   */
  readonly units: readonly ExperienceUnit[];
  /**
   * Error from the subscription, surfaced when `status === "error"`.
   * Firestore's onSnapshot error is terminal for the subscription —
   * we don't auto-retry, so the error-state surface is the end of
   * the line until the route re-mounts.
   */
  readonly error?: Error | null;
  /**
   * Stub handler for the "Add Unit manually" CTA. `undefined` in
   * #79 (the form doesn't exist yet); #83 wires it.
   */
  readonly onAddManually?: () => void;
}

export default function UnitReviewView({
  status,
  units,
  error,
  onAddManually,
}: UnitReviewViewProps): ReactElement {
  // Counter counts ALL approved Units from the ready-state snapshot
  // — rejected don't enter the filter because the state machine
  // guarantees rejected → user_approved: false. See countApproved's
  // test for the corrupt-data edge case. In loading/error the
  // counter renders 0 of 20, which is accurate: we don't have a
  // snapshot to report against.
  const approved = countApproved(units);
  const visible = sortByUpdatedDesc(excludeRejected(units));

  return (
    <section className="mx-auto max-w-5xl space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Unit Review
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Approve, correct, or reject every extracted Experience Unit.
            No Unit enters matching until you approve it.
          </p>
        </div>
        <ApprovalCounter approved={approved} />
      </header>

      {status === "loading" && (
        <div
          className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
          role="status"
          aria-live="polite"
          data-load-state="loading"
        >
          Loading Units&hellip;
        </div>
      )}

      {status === "error" && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          data-load-state="error"
        >
          Couldn&rsquo;t load Units: {error?.message ?? "Unknown error."}
        </div>
      )}

      {status === "ready" &&
        (visible.length === 0 ? (
          <EmptyState onAddManually={onAddManually} />
        ) : (
          <ul
            className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
            aria-label="Experience Units"
            data-load-state="ready"
          >
            {visible.map((unit) => (
              <UnitRow key={unit.id} unit={unit} />
            ))}
          </ul>
        ))}
    </section>
  );
}
