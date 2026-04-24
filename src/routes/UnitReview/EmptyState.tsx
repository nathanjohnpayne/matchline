/**
 * Rendered when the current user has zero ExperienceUnits. The
 * "Add Unit manually" CTA is present but its handler is a stub in
 * #79 — wiring lands in #83 (manual-add form).
 *
 * Copy is deliberately short + instructive rather than marketing-y,
 * matching the sign-in surface tone per `docs/design/ui-guidance.md`.
 */

import type { ReactElement } from "react";

export interface EmptyStateProps {
  /**
   * Called when the "Add Unit manually" CTA is activated. #79 passes
   * a stub that does nothing (the form doesn't exist yet); #83
   * replaces the stub with the form-opening handler.
   */
  readonly onAddManually?: () => void;
}

export default function EmptyState({
  onAddManually,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700"
      role="region"
      aria-label="Empty Unit Review"
    >
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        No Experience Units yet.
      </p>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        Paste a resume in Onboarding to extract Units automatically,
        or add one by hand.
      </p>
      <button
        type="button"
        onClick={onAddManually}
        disabled={onAddManually === undefined}
        className="mt-6 inline-flex items-center rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 transition duration-150 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus:ring-zinc-100 dark:focus:ring-offset-zinc-950"
      >
        Add Unit manually
      </button>
    </div>
  );
}
