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

export interface UnitReviewViewProps {
  /**
   * Full owner-scoped Unit set from the Firestore subscription.
   * Rejected Units are included here — the view applies the
   * rejected-exclusion filter before rendering. Future filter sub-
   * issue (#80) composes additional filters on top.
   */
  readonly units: readonly ExperienceUnit[];
  /**
   * Error from the subscription, surfaced if Firestore returns a
   * terminal error (most commonly: rules rejection because auth
   * resolved later than the route was rendered). Pass `null` for
   * the normal case.
   */
  readonly error?: Error | null;
  /**
   * Stub handler for the "Add Unit manually" CTA. `undefined` in
   * #79 (the form doesn't exist yet); #83 wires it.
   */
  readonly onAddManually?: () => void;
}

export default function UnitReviewView({
  units,
  error,
  onAddManually,
}: UnitReviewViewProps): ReactElement {
  // Note: the counter counts ALL approved Units — rejected don't
  // enter the filter because the state machine guarantees
  // rejected → user_approved: false. See countApproved's test for
  // the corrupt-data edge case.
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

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          Couldn&rsquo;t load Units: {error.message}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState onAddManually={onAddManually} />
      ) : (
        <ul
          className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
          aria-label="Experience Units"
        >
          {visible.map((unit) => (
            <UnitRow key={unit.id} unit={unit} />
          ))}
        </ul>
      )}
    </section>
  );
}
