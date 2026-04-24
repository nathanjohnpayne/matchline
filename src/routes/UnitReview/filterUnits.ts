/**
 * Pure filtering helpers for the Unit Review surface. Factored out of
 * the view so the rejected-exclusion (+ sort ordering) logic can be
 * unit-tested without booting React — matching the pattern used by
 * `src/services/experienceUnits-state.ts`.
 *
 * The primary concern in #79 is: rejected Units do not appear in the
 * main list. Future filters (skills, tools, domains, date range,
 * approval status) land in #80 — those add more filtering on top of
 * this baseline, they don't replace it.
 */

import type { ExperienceUnit } from "../../types/capability.ts";

/**
 * Exclude rejected Units from a list. Used as the default display
 * filter for the main Unit Review list — rejected Units are retained
 * in Firestore (for the rejected-review tab in #82) but must not
 * appear in the primary review flow where the user is deciding what
 * to approve.
 */
export function excludeRejected(
  units: readonly ExperienceUnit[],
): ExperienceUnit[] {
  return units.filter((u) => u.rejected !== true);
}

/**
 * Sort Units for the main list. Convention: most-recently-updated
 * first, so after an edit the Unit rises to the top and the user
 * sees their change immediately.
 *
 * Stable when `updated_at` ties — falls back to `created_at` so new
 * manual inserts in rapid succession stay in insert order rather
 * than shuffling on re-render.
 */
export function sortByUpdatedDesc(
  units: readonly ExperienceUnit[],
): ExperienceUnit[] {
  return [...units].sort((a, b) => {
    if (a.updated_at !== b.updated_at) {
      return a.updated_at < b.updated_at ? 1 : -1;
    }
    return a.created_at < b.created_at ? 1 : -1;
  });
}

/**
 * Count approved Units. The Unit Review success metric in
 * `specs/matchline.md` is "≥ 20 approved Units", surfaced as a
 * milestone counter in the header — `ApprovalCounter.tsx`.
 */
export function countApproved(units: readonly ExperienceUnit[]): number {
  return units.filter((u) => u.user_approved).length;
}
