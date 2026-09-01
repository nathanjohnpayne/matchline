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
 * **Two kinds of gap (#441).** `unmet` is the original meaning:
 * nothing qualifies, and the user needs to add context to their
 * Capability Graph. `unverifiable` means something might
 * qualify but the evidence derivation could not reach a verdict
 * — a Requirement id stranded by a JD re-parse, a deleted Unit,
 * or a Unit the matching pipeline currently declines to score.
 * They are rendered in separate blocks because the remedy
 * differs, and because telling someone "you have no evidence for
 * this" when the truth is "we could not check" is the same
 * over-claim, pointed the other way, that this whole panel
 * exists to prevent.
 *
 * Empty state: when there ARE no gaps (every must-have
 * has a qualifying match), render a brief affirmative
 * line so the panel doesn't visually disappear and confuse
 * users about whether the check ran.
 */

import type { ReactElement } from "react";

import type { JobRequirementUnit } from "../../types/capability.ts";

import type { Gap } from "./computeGaps.ts";

/**
 * Whether the evidence derivation behind these gaps completed.
 *
 * `unavailable` is not an error state for the user to fix — the
 * view still renders, under the permissive pre-#441 reading. It
 * is a disclosure, because that reading can show a must-have as
 * covered by a match whose evidence was never established, and
 * the user is entitled to know the check did not run before they
 * generate against it.
 */
export type EvidenceStatus = "current" | "pending" | "unavailable";

export interface GapsViewProps {
  readonly gaps: readonly Gap[];
  readonly evidenceStatus?: EvidenceStatus;
}

function RequirementRow({
  req,
}: {
  readonly req: JobRequirementUnit;
}): ReactElement {
  return (
    <li
      className="rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-2"
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
  );
}

function EvidenceNotice({
  status,
}: {
  readonly status: EvidenceStatus;
}): ReactElement | null {
  if (status === "current") return null;
  return (
    <p
      className="text-xs text-zinc-600 dark:text-zinc-400"
      data-testid={
        status === "pending"
          ? "gaps-evidence-pending"
          : "gaps-evidence-unavailable"
      }
    >
      {status === "pending"
        ? "Checking the evidence behind older matches…"
        : "Evidence for older matches could not be checked, so some " +
          "requirements below may be listed as covered on the strength " +
          "of a match that was never verified."}
    </p>
  );
}

export default function GapsView({
  gaps,
  evidenceStatus = "current",
}: GapsViewProps): ReactElement {
  const unmet = gaps.filter((g) => g.status === "unmet");
  const unverifiable = gaps.filter((g) => g.status === "unverifiable");

  if (gaps.length === 0) {
    return (
      <section
        className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-3 space-y-2"
        data-testid="gaps-view-empty"
        aria-label="Gaps summary"
      >
        <p className="text-sm text-emerald-800 dark:text-emerald-300">
          ✓ Every must-have requirement has a qualifying match.
        </p>
        <EvidenceNotice status={evidenceStatus} />
      </section>
    );
  }

  // The accessible name has to track what the panel actually
  // contains. A fixed "Unmet must-have requirements" announced the
  // STRONGER claim — that no qualifying evidence exists — over a
  // panel that might hold only unverified entries, which is the
  // exact conflation this change exists to undo. Codex P2 on PR
  // #446: the visible heading was right and the label was not, so
  // the over-claim was audible only to assistive technology.
  const label =
    unmet.length > 0 && unverifiable.length > 0
      ? "Unmet and unverified must-have requirements"
      : unmet.length > 0
        ? "Unmet must-have requirements"
        : "Unverified must-have requirements";

  return (
    <section
      className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 p-4 space-y-3"
      data-testid="gaps-view"
      aria-label={label}
    >
      {unmet.length > 0 && (
        <>
          <header>
            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Gaps · {unmet.length} unmet must-have requirement
              {unmet.length === 1 ? "" : "s"}
            </h3>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              No Experience Unit qualifies for these. Consider adding context to
              your Capability Graph before generating.
            </p>
          </header>
          <ul className="space-y-2">
            {unmet.map((g) => (
              <RequirementRow key={g.requirement.id} req={g.requirement} />
            ))}
          </ul>
        </>
      )}

      {unverifiable.length > 0 && (
        <section className="space-y-2" data-testid="gaps-unverifiable">
          <header>
            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Unverified · {unverifiable.length} must-have requirement
              {unverifiable.length === 1 ? "" : "s"}
            </h3>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              These have a match, but its evidence could not be checked — the
              Experience Unit it points to has been deleted, edited since, or
              is not currently approved. Treat them as unproven rather than as
              gaps.
            </p>
          </header>
          <ul className="space-y-2">
            {unverifiable.map((g) => (
              <RequirementRow key={g.requirement.id} req={g.requirement} />
            ))}
          </ul>
        </section>
      )}

      <EvidenceNotice status={evidenceStatus} />
    </section>
  );
}
