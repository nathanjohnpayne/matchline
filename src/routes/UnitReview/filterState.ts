/**
 * Pure filter state for the Unit Review surface. Everything in this
 * module is URL-serializable and testable without booting React.
 * The React hook `useFilterState.ts` wraps these pure helpers with
 * `useSearchParams` for the URL sync; the UI panel `Filters.tsx`
 * calls the hook.
 *
 * Filter semantics:
 *   - AND across fields (skills AND tools AND domains AND approval AND date)
 *   - OR within a field (skills: [a, b] means skills contain `a` OR `b`)
 *   - Empty field = no constraint on that axis
 *
 * Rejected Units are never part of this surface — they're excluded
 * by `excludeRejected` in `filterUnits.ts` before filters apply, and
 * the rejected-review tab (#82) has its own query path. The approval
 * filter here only offers approved / pending / flagged.
 *
 * Date semantics:
 *   - A Unit passes the date filter if its `date_range` overlaps
 *     with the filter's `[dateFrom, dateTo]` window. Either bound
 *     can be null (open-ended on that side).
 *   - Units with no `date_range` are included only when no date
 *     filter is set. Rationale: "if I set a date, I want dated
 *     Units" is the clearest V1 semantic; undated Units ambiguous
 *     by definition.
 */

import type { ExperienceUnit } from "../../types/capability.ts";

/**
 * The three approval states the main-list filter offers. Rejected
 * is deliberately absent — see module docstring.
 */
export type ApprovalFilterValue = "approved" | "pending" | "flagged";

export const APPROVAL_FILTER_VALUES: readonly ApprovalFilterValue[] = [
  "approved",
  "pending",
  "flagged",
] as const;

export interface FilterState {
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly domains: readonly string[];
  readonly approval: readonly ApprovalFilterValue[];
  /** ISO date string (YYYY-MM-DD). Inclusive lower bound on `date_range` overlap. */
  readonly dateFrom: string | null;
  /** ISO date string (YYYY-MM-DD). Inclusive upper bound on `date_range` overlap. */
  readonly dateTo: string | null;
}

export const EMPTY_FILTER_STATE: FilterState = Object.freeze({
  skills: [],
  tools: [],
  domains: [],
  approval: [],
  dateFrom: null,
  dateTo: null,
});

/**
 * Is any filter set? Used by the container to skip `applyFilters`
 * (and its allocations) on the common case where no filter is
 * active, and by the UI to toggle the "Clear filters" CTA.
 */
export function isFilterActive(state: FilterState): boolean {
  return (
    state.skills.length > 0 ||
    state.tools.length > 0 ||
    state.domains.length > 0 ||
    state.approval.length > 0 ||
    state.dateFrom !== null ||
    state.dateTo !== null
  );
}

// ---------------------------------------------------------------------------
// URL serialization
// ---------------------------------------------------------------------------

/**
 * Search-param keys. Centralized so tests, the hook, and external
 * consumers can't drift on casing. Kept short because URLs get
 * ugly fast.
 */
const KEYS = {
  skills: "skills",
  tools: "tools",
  domains: "domains",
  approval: "approval",
  dateFrom: "from",
  dateTo: "to",
} as const;

/**
 * The full list of search-param keys the filter owns. Exported so
 * `useFilterState`'s "clear only filter-owned params" logic stays
 * in lockstep — a future filter-axis addition that updates `KEYS`
 * automatically updates the hook via this export. CodeRabbit nit
 * on #88.
 */
export const FILTER_SEARCH_PARAM_KEYS: readonly string[] = Object.values(KEYS);

/**
 * Append each array value as a repeated same-key param. This is
 * load-bearing over a comma-joined encoding: skill/tool/domain
 * labels can legitimately contain commas (e.g. "Sales, Marketing"
 * as a domain), and a comma-joined round-trip would silently
 * split that into two filters on reload. URLSearchParams supports
 * repeated keys natively — `.getAll(key)` on decode returns every
 * occurrence.
 *
 * Codex P2 on #88 caught this. The fix preserves the pure contract:
 * any string array value (including ones with commas) round-trips
 * to the exact same array.
 */
function appendArray(
  params: URLSearchParams,
  key: string,
  values: readonly string[],
): void {
  for (const v of values) {
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    params.append(key, trimmed);
  }
}

function decodeAllTrimmed(params: URLSearchParams, key: string): string[] {
  return params
    .getAll(key)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read a scalar string param, returning `null` for both missing
 * AND blank (whitespace-only) values. Load-bearing for date
 * params — `?from=` with no value was previously decoding to `""`,
 * which made `isFilterActive` return `true` and changed filtering
 * behavior unexpectedly. CodeRabbit Major on #88.
 */
function decodeNullableParam(
  params: URLSearchParams,
  key: string,
): string | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A full FilterState → URLSearchParams. Empty fields are OMITTED
 * from the result so a "no filter" state serializes to an empty
 * URL (clean default). Array fields encode as repeated same-key
 * params (`?skills=sql&skills=python`) rather than comma-joined —
 * see `appendArray` for rationale.
 */
export function encodeToSearchParams(state: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  appendArray(params, KEYS.skills, state.skills);
  appendArray(params, KEYS.tools, state.tools);
  appendArray(params, KEYS.domains, state.domains);
  appendArray(params, KEYS.approval, state.approval);
  if (state.dateFrom !== null) params.set(KEYS.dateFrom, state.dateFrom);
  if (state.dateTo !== null) params.set(KEYS.dateTo, state.dateTo);
  return params;
}

/**
 * URLSearchParams → FilterState. Unknown approval values are
 * dropped silently (e.g. a URL pasted from a future version with a
 * new approval category) rather than throwing — keeps shareable
 * links stable across minor schema drift.
 */
export function decodeFromSearchParams(params: URLSearchParams): FilterState {
  const approvalRaw = decodeAllTrimmed(params, KEYS.approval);
  const approval: ApprovalFilterValue[] = approvalRaw.filter(
    (v): v is ApprovalFilterValue =>
      APPROVAL_FILTER_VALUES.includes(v as ApprovalFilterValue),
  );
  return {
    skills: decodeAllTrimmed(params, KEYS.skills),
    tools: decodeAllTrimmed(params, KEYS.tools),
    domains: decodeAllTrimmed(params, KEYS.domains),
    approval,
    dateFrom: decodeNullableParam(params, KEYS.dateFrom),
    dateTo: decodeNullableParam(params, KEYS.dateTo),
  };
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

/**
 * Case-insensitive OR-match: does `values` intersect with `filter`?
 * Uses normalized (lowercased, trimmed) comparisons so the filter
 * matches user-typed chip values that might differ in case from
 * the stored values.
 *
 * Empty `filter` returns `true` (no constraint) — callers MUST
 * pass an empty array when they mean "no filter on this axis."
 */
function hasAnyMatch(
  values: readonly string[],
  filter: readonly string[],
): boolean {
  if (filter.length === 0) return true;
  const normalized = new Set(values.map((v) => v.trim().toLowerCase()));
  return filter.some((f) => normalized.has(f.trim().toLowerCase()));
}

/**
 * True if the Unit's `date_range` overlaps with [dateFrom, dateTo].
 * A missing `date_range.end` is treated as "present" (open upper
 * bound on the Unit side) — a Unit that started in 2023 and hasn't
 * ended matches a 2024 filter window.
 *
 * If BOTH filter bounds are null, the filter is inactive — caller
 * should short-circuit. If the Unit has no `date_range` at all,
 * returns `false` (excluded when any date filter is set).
 */
function passesDateFilter(
  unit: ExperienceUnit,
  dateFrom: string | null,
  dateTo: string | null,
): boolean {
  if (dateFrom === null && dateTo === null) return true;
  if (unit.date_range === undefined) return false;
  const unitStart = unit.date_range.start;
  const unitEnd = unit.date_range.end ?? "9999-12-31";
  if (dateFrom !== null && unitEnd < dateFrom) return false;
  if (dateTo !== null && unitStart > dateTo) return false;
  return true;
}

/**
 * Derive the Unit's display state and match against the filter.
 * Rejected Units never pass this filter (they shouldn't reach
 * `applyFilters` in the first place — `excludeRejected` runs
 * upstream — but defensive: if one does leak through, the approval
 * filter treats it as never-matching).
 */
function passesApprovalFilter(
  unit: ExperienceUnit,
  filter: readonly ApprovalFilterValue[],
): boolean {
  if (filter.length === 0) return true;
  if (unit.rejected === true) return false;
  // Avoid importing displayStateOf for this one use — the mapping
  // is trivial and importing would create a cross-module cycle
  // risk (filterState is consumed by the route; the service
  // module is already imported by the row). Inline here with a
  // comment citing the shared helper as the authoritative mapping.
  let state: ApprovalFilterValue;
  if (unit.flagged === true) state = "flagged";
  else if (unit.user_approved) state = "approved";
  else state = "pending";
  return filter.includes(state);
}

/**
 * Collect distinct values of an array-valued field from a Unit
 * list, sorted case-insensitively. Used to seed the filter UI's
 * chip multi-selects from whatever actually appears in the user's
 * corpus — V1 UX is "only show chips for things you have."
 */
export function distinctFieldValues(
  units: readonly ExperienceUnit[],
  field: "skills" | "tools" | "domains",
): string[] {
  const seen = new Map<string, string>();
  for (const u of units) {
    for (const v of u[field]) {
      const key = v.trim().toLowerCase();
      if (key.length === 0) continue;
      // Keep the first casing we saw — if later Units disagree on
      // casing, we show the earlier form as the chip label. The
      // filter matches case-insensitively either way.
      if (!seen.has(key)) seen.set(key, v.trim());
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
}

/**
 * Apply the full filter state to a Unit list. Preserves input
 * order (caller applies sort afterward). Does not mutate input.
 */
export function applyFilters(
  units: readonly ExperienceUnit[],
  state: FilterState,
): ExperienceUnit[] {
  if (!isFilterActive(state)) {
    // Fast path: no constraints. Return a fresh array copy so
    // callers can sort without mutating the subscribed-state
    // reference (same rationale as `sortByUpdatedDesc`).
    return [...units];
  }
  return units.filter(
    (u) =>
      hasAnyMatch(u.skills, state.skills) &&
      hasAnyMatch(u.tools, state.tools) &&
      hasAnyMatch(u.domains, state.domains) &&
      passesApprovalFilter(u, state.approval) &&
      passesDateFilter(u, state.dateFrom, state.dateTo),
  );
}
