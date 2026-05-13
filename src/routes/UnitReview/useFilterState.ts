/**
 * React hook wrapping the pure `filterState.ts` helpers with
 * `useSearchParams` from React Router. Owns the single URL ↔ state
 * sync for the Unit Review surface.
 *
 * Design choices:
 *   - **URL is the source of truth.** Reading the state always
 *     re-decodes from the current `useSearchParams()` value. That
 *     makes back/forward navigation work correctly and makes a
 *     pasted URL the canonical way to share a filter.
 *   - **Write is debounced-free.** Filter changes come from
 *     discrete user actions (chip click, date picker commit); no
 *     keystroke-level writes here. `Filters.tsx` is responsible
 *     for deciding when to commit an edit.
 *   - **Stable setter identity.** `setFilters` and `clearFilters`
 *     are wrapped with `useCallback` so child components don't
 *     re-render on every keystroke elsewhere.
 *
 * Query memoization (rule 4 in #80's acceptance criteria) is
 * handled in the container by `useMemo` over the filter state,
 * since that's where the list-view consumes it.
 */

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import {
  decodeFromSearchParams,
  encodeToSearchParams,
  EMPTY_FILTER_STATE,
  FILTER_SEARCH_PARAM_KEYS,
  type FilterState,
} from "./filterState.ts";

export interface UseFilterStateResult {
  readonly filters: FilterState;
  readonly setFilters: (next: FilterState) => void;
  readonly clearFilters: () => void;
}

export function useFilterState(): UseFilterStateResult {
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive FilterState from the URL on every render. Memoized on
  // the raw `URLSearchParams.toString()` so an unrelated render
  // (e.g. parent state change) doesn't rebuild the FilterState
  // object reference — keeps downstream `useMemo`s stable.
  const filters = useMemo<FilterState>(
    () => decodeFromSearchParams(searchParams),
    [searchParams],
  );

  const setFilters = useCallback(
    (next: FilterState) => {
      const encoded = encodeToSearchParams(next);
      // CodeRabbit Nit on PR #88: use the functional updater form so
      // the merge always reads the latest URL params, not the
      // snapshot from when this callback was last rebuilt. A rapid
      // sequence of filter changes (e.g., toggling two checkboxes
      // in quick succession) could otherwise merge against a stale
      // base and drop the intermediate update.
      setSearchParams((prev) => {
        // Preserve any query params NOT owned by the filter (none
        // today on this route, but cheap defensive — if the route
        // ever gains a tab param or similar, the filter sync won't
        // clobber it).
        const merged = new URLSearchParams(prev);
        // Clear every filter-owned key before re-appending, so a
        // previously-active filter value that's now removed is
        // actually removed from the URL. The key list comes from
        // filterState.ts to stay in lockstep with the encode/decode
        // helpers — a new axis added there updates here via this
        // import (CodeRabbit nit on #88).
        for (const key of FILTER_SEARCH_PARAM_KEYS) {
          merged.delete(key);
        }
        for (const [k, v] of encoded.entries()) {
          // append (not set) because the filter encoding uses
          // repeated same-key params for array fields
          // (?skills=sql&skills=python) — see filterState.ts
          // appendArray for rationale. Using set() here would
          // collapse the array to its last value.
          merged.append(k, v);
        }
        return merged;
      });
      // No `replace: true` — each filter change becomes a
      // distinct history entry so Back/Forward can step through
      // filter combinations. Codex P2 on #88 caught the prior
      // replace-on-every-change behavior, which undermined the
      // "URL is source of truth" contract for navigation.
    },
    [setSearchParams],
  );

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTER_STATE);
  }, [setFilters]);

  return { filters, setFilters, clearFilters };
}
