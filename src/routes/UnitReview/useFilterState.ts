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
      // Preserve any query params NOT owned by the filter (none
      // today on this route, but cheap defensive — if the route
      // ever gains a tab param or similar, the filter sync won't
      // clobber it).
      const merged = new URLSearchParams(searchParams);
      for (const key of ["skills", "tools", "domains", "approval", "from", "to"]) {
        merged.delete(key);
      }
      for (const [k, v] of encoded.entries()) {
        merged.set(k, v);
      }
      setSearchParams(merged, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_FILTER_STATE);
  }, [setFilters]);

  return { filters, setFilters, clearFilters };
}
