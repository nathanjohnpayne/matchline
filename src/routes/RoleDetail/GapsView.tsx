/**
 * Gaps view (#130). Renders the unmet must-have
 * Requirements for a Role — Requirements where the user
 * has no qualifying match (per `computeGaps`'s threshold).
 *
 * Honest by design: if the user can't ground a hard
 * requirement, they need to know BEFORE generation. The
 * Application Editor (#24) will eventually surface this
 * inline; for now, the Matches tab renders this panel
 * alongside the Requirements grid.
 *
 * Empty state: when there ARE no gaps (every must-have
 * has a qualifying match), render a brief affirmative
 * line so the panel doesn't visually disappear and confuse
 * users about whether the check ran.
 */

import type { ReactElement } from "react";

import type { JobRequirementUnit } from "../../types/capability.ts";

export interface GapsViewProps {
  readonly gaps: readonly JobRequirementUnit[];
}

export default function GapsView({ gaps }: GapsViewProps): ReactElement {
  if (gaps.length === 0) {
    return (
      <section
        className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-3"
        data-testid="gaps-view-empty"
        aria-label="Gaps summary"
      >
        <p className="text-sm text-emerald-800 dark:text-emerald-300">
          ✓ Every must-have requirement has a qualifying match.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 p-4 space-y-3"
      data-testid="gaps-view"
      aria-label="Unmet must-have requirements"
    >
      <header>
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Gaps · {gaps.length} unmet must-have requirement
          {gaps.length === 1 ? "" : "s"}
        </h3>
        <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
          No Experience Unit qualifies for these. Consider adding context to
          your Capability Graph before generating.
        </p>
      </header>
      <ul className="space-y-2">
        {gaps.map((req) => (
          <li
            key={req.id}
            className="rounded border border-amber-200 dark:border-amber-900 bg-white dark:bg-zinc-900 p-2"
            data-testid="gap-row"
          >
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {req.normalized_requirement}
            </p>
            <p className="text-xs text-zinc-500 mt-0.5">
              <span className="rounded border border-zinc-200 dark:border-zinc-700 px-1.5 py-0.5 uppercase tracking-wide font-medium">
                {req.category}
              </span>
              <span className="ml-2">priority: {req.priority}</span>
            </p>
            {req.raw_text !== req.normalized_requirement && (
              <p className="text-xs italic text-zinc-500 mt-1">
                Original: {req.raw_text}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
