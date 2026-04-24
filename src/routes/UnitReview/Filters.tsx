/**
 * Filter panel for the Unit Review list. Presentational — receives
 * current filter state + an `onChange` callback, renders controls.
 * The `useFilterState` hook owns URL sync and feeds this component
 * through the container.
 *
 * Chip lists for skills/tools/domains are seeded from values that
 * actually appear in the user's Units (passed as a prop) rather
 * than from a static ontology. V1 single-user rationale: the user
 * only wants to filter on things they have, and we don't need
 * ontology lookup for autocomplete — a straight pick-from-list is
 * the shortest path. When an ontology lands (Phase 0 leftover),
 * this can swap the chip source without re-shaping the component.
 */

import type { ChangeEvent, ReactElement } from "react";

import {
  APPROVAL_FILTER_VALUES,
  type ApprovalFilterValue,
  type FilterState,
} from "./filterState.ts";

export interface FiltersProps {
  readonly filters: FilterState;
  readonly onChange: (next: FilterState) => void;
  readonly onClear: () => void;
  /**
   * Values that appear on the user's current Unit corpus, per
   * field. The UI renders these as the available chip choices for
   * each multi-select. The container derives them from the live
   * subscription.
   */
  readonly availableSkills: readonly string[];
  readonly availableTools: readonly string[];
  readonly availableDomains: readonly string[];
  /**
   * True if any filter is active — drives the visibility of the
   * "Clear filters" CTA. The container computes this via
   * `isFilterActive` so the `Filters` component doesn't duplicate
   * the logic.
   */
  readonly active: boolean;
}

/**
 * Toggle `value` in `list`: add if absent, remove if present.
 * Case-preserving (stores the value as typed) — `applyFilters`
 * does case-insensitive matching, so casing differences on the
 * stored side don't affect filter correctness.
 */
function toggleIn(
  list: readonly string[],
  value: string,
): readonly string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

const APPROVAL_LABELS: Record<ApprovalFilterValue, string> = {
  approved: "Approved",
  pending: "Pending",
  flagged: "Flagged",
};

export default function Filters({
  filters,
  onChange,
  onClear,
  availableSkills,
  availableTools,
  availableDomains,
  active,
}: FiltersProps): ReactElement {
  const setDateFrom = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    onChange({ ...filters, dateFrom: value === "" ? null : value });
  };
  const setDateTo = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    onChange({ ...filters, dateTo: value === "" ? null : value });
  };

  return (
    <div
      className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
      role="region"
      aria-label="Unit filters"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Filter
        </h2>
        {active && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Clear filters
          </button>
        )}
      </div>

      <ChipMultiSelect
        label="Skills"
        values={filters.skills}
        available={availableSkills}
        onToggle={(v) =>
          onChange({ ...filters, skills: toggleIn(filters.skills, v) })
        }
      />
      <ChipMultiSelect
        label="Tools"
        values={filters.tools}
        available={availableTools}
        onToggle={(v) =>
          onChange({ ...filters, tools: toggleIn(filters.tools, v) })
        }
      />
      <ChipMultiSelect
        label="Domains"
        values={filters.domains}
        available={availableDomains}
        onToggle={(v) =>
          onChange({ ...filters, domains: toggleIn(filters.domains, v) })
        }
      />

      <div>
        <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Status
        </p>
        <div className="flex flex-wrap gap-1.5">
          {APPROVAL_FILTER_VALUES.map((value) => {
            const selected = filters.approval.includes(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  onChange({
                    ...filters,
                    approval: toggleIn(
                      filters.approval,
                      value,
                    ) as readonly ApprovalFilterValue[],
                  })
                }
                className={
                  selected
                    ? "rounded-full bg-zinc-900 px-3 py-0.5 text-xs text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                    : "rounded-full border border-zinc-200 px-3 py-0.5 text-xs text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500"
                }
              >
                {APPROVAL_LABELS[value]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            From
          </span>
          <input
            type="date"
            value={filters.dateFrom ?? ""}
            onChange={setDateFrom}
            className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            To
          </span>
          <input
            type="date"
            value={filters.dateTo ?? ""}
            onChange={setDateTo}
            className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
      </div>
    </div>
  );
}

interface ChipMultiSelectProps {
  readonly label: string;
  readonly values: readonly string[];
  readonly available: readonly string[];
  readonly onToggle: (value: string) => void;
}

/**
 * One-line chip multi-select. Shows ALL available values as
 * clickable chips; selected chips render with the "pressed"
 * treatment. When there are no available values (e.g. no Unit
 * has a `tools` entry yet), renders a quiet placeholder instead
 * of an empty chip row.
 */
function ChipMultiSelect({
  label,
  values,
  available,
  onToggle,
}: ChipMultiSelectProps): ReactElement {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
      </p>
      {available.length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          No {label.toLowerCase()} in the corpus yet.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {available.map((value) => {
            const selected = values.includes(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => onToggle(value)}
                className={
                  selected
                    ? "rounded-full bg-zinc-900 px-3 py-0.5 text-xs text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                    : "rounded-full border border-zinc-200 px-3 py-0.5 text-xs text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-500"
                }
              >
                {value}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
