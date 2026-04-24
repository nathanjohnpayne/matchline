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
import Filters from "./Filters.tsx";
import UnitRow from "./UnitRow.tsx";
import type { EditableUnitFields } from "./inlineEditState.ts";
import {
  applyFilters,
  distinctFieldValues,
  EMPTY_FILTER_STATE,
  isFilterActive,
  type FilterState,
} from "./filterState.ts";
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
   * filter before rendering. The filter UI (#80) composes on top.
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
   * Current filter state. Defaults to `EMPTY_FILTER_STATE` for
   * callers that don't wire the filter UI (e.g. the view's own
   * tests that pre-date #80). The container uses
   * `useFilterState()` to thread URL-synced filters through.
   */
  readonly filters?: FilterState;
  /**
   * Called when the user mutates the filter state. Absent when
   * `filters` is also absent — the filter panel renders only when
   * both are wired (see render branch below).
   */
  readonly onFiltersChange?: (next: FilterState) => void;
  /**
   * Clear-all CTA handler in the filter panel. Same "both wired or
   * neither" contract as `onFiltersChange`.
   */
  readonly onClearFilters?: () => void;
  /**
   * Stub handler for the "Add Unit manually" CTA. `undefined` in
   * #79 (the form doesn't exist yet); #83 wires it.
   */
  readonly onAddManually?: () => void;
  /**
   * Commit an inline edit. Receives the changed-fields partial
   * (already diffed against the current Unit by the row). Passed
   * through to every `UnitRow` so edits work per-row. Absent in
   * pre-#81 callers — backward compat kept on the row component
   * via its own `onSaveEdit?` prop.
   */
  readonly onSaveEdit?: (
    id: string,
    partial: Partial<EditableUnitFields>,
  ) => Promise<void>;
}

export default function UnitReviewView({
  status,
  units,
  error,
  filters = EMPTY_FILTER_STATE,
  onFiltersChange,
  onClearFilters,
  onAddManually,
  onSaveEdit,
}: UnitReviewViewProps): ReactElement {
  // Counter is only rendered in the `ready` branch. Showing "N of 20"
  // in loading or error states would leak stale or unknown-truth
  // information into the header — specifically: an error AFTER a
  // successful snapshot would still display the now-stale approved
  // count next to the error banner. See nathanpayne-codex Phase 4b
  // round 2 on #86.
  //
  // The counter reports the GLOBAL approved count (over the full
  // unfiltered snapshot), not the filtered count. Rationale: "≥20
  // approved" is an onboarding milestone — the user wants to know
  // their absolute progress, not how many approved Units match their
  // current filter. Filtering the count would make the milestone
  // rubber-band confusingly with filter changes.
  const approved = countApproved(units);
  const nonRejected = excludeRejected(units);
  const filtered = applyFilters(nonRejected, filters);
  const visible = sortByUpdatedDesc(filtered);

  // Chip sources seeded from the CURRENT snapshot, not the filtered
  // view — otherwise applying a skill filter would hide the tools
  // field's other available chips until the filter was cleared
  // (chip for a tool that never appears in any skill=X Unit).
  const availableSkills = distinctFieldValues(nonRejected, "skills");
  const availableTools = distinctFieldValues(nonRejected, "tools");
  const availableDomains = distinctFieldValues(nonRejected, "domains");
  const filterPanelWired =
    onFiltersChange !== undefined && onClearFilters !== undefined;

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
        {status === "ready" && <ApprovalCounter approved={approved} />}
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

      {status === "ready" && filterPanelWired && (
        <Filters
          filters={filters}
          onChange={onFiltersChange}
          onClear={onClearFilters}
          availableSkills={availableSkills}
          availableTools={availableTools}
          availableDomains={availableDomains}
          active={isFilterActive(filters)}
        />
      )}

      {status === "ready" &&
        (nonRejected.length === 0 ? (
          // Genuinely-empty corpus — render the empty state with
          // the manual-add CTA, no filter-hit/miss message.
          <EmptyState onAddManually={onAddManually} />
        ) : visible.length === 0 ? (
          // Filters matched no Units but the corpus has some.
          // Distinct copy so the user knows to relax or clear the
          // filter rather than assuming the corpus is empty.
          <div
            className="rounded-lg border border-dashed border-zinc-300 px-6 py-10 text-center dark:border-zinc-700"
            role="region"
            aria-label="No filter matches"
            data-filter-state="empty"
          >
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              No Units match these filters.
            </p>
            {isFilterActive(filters) && onClearFilters !== undefined && (
              <button
                type="button"
                onClick={onClearFilters}
                className="mt-3 text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <ul
            className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
            aria-label="Experience Units"
            data-load-state="ready"
          >
            {visible.map((unit) => (
              <UnitRow key={unit.id} unit={unit} onSaveEdit={onSaveEdit} />
            ))}
          </ul>
        ))}
    </section>
  );
}
