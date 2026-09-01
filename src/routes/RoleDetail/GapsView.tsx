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
import type { UnverifiableReason } from "../../../functions/src/types/evidence.ts";

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
  /**
   * Non-rejected matches that would have cleared the threshold but
   * point at a Requirement that no longer exists. A Role-level
   * number: see `GapReport.strandedMatches`.
   */
  readonly strandedMatches?: number;
}

/**
 * Plain-language cause, per reason.
 *
 * The panel used to carry one fixed sentence blaming the
 * Experience Unit — "deleted, edited since, or is not currently
 * approved" — which is wrong for both of the Requirement-side
 * reasons. The linked Unit can be present, approved and untouched
 * while the Requirement's own embedding is missing or has the
 * wrong dimension, and pointing the user at the Unit sends them to
 * fix something that was never broken. Codex P2 on PR #446.
 *
 * Some of these are not the user's to remedy at all, so the
 * wording states the cause and stops rather than implying an
 * action that does not exist.
 */
const REASON_TEXT: Readonly<Record<UnverifiableReason, string>> = {
  unit_missing: "the linked Experience Unit no longer exists",
  // Unreachable through `Gap.reasons`: `computeGaps` detects a
  // stranded match structurally and counts it in
  // `strandedMatches` before any verdict is read. The key is
  // required because the map is exhaustive over
  // `UnverifiableReason`, and the callable does still return this
  // reason.
  requirement_missing:
    "this requirement was replaced, so the match points at an older version of it",
  unit_unapproved: "the linked Experience Unit is not currently approved",
  unit_reembed_pending:
    "the linked Experience Unit was edited and is awaiting re-embedding",
  unit_embedding_missing: "the linked Experience Unit has no usable embedding",
  requirement_embedding_missing: "this requirement has no usable embedding",
  embedding_dimension_mismatch:
    "the requirement and the Experience Unit were embedded by different models",
};

function RequirementRow({
  req,
  reasons = [],
}: {
  readonly req: JobRequirementUnit;
  readonly reasons?: readonly UnverifiableReason[];
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
      {reasons.length > 0 && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
          Could not verify: {reasons.map((r) => REASON_TEXT[r]).join("; ")}.
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

/**
 * Exported because `MatchesTab` renders it outside `GapsView` too:
 * when a re-parse removes every Requirement, that tab returns
 * early and `GapsView` never mounts — which is precisely when
 * every surviving match is stranded and the notice matters most.
 * Codex P2 on PR #446. One component so the two sites cannot say
 * different things.
 */
export function StrandedNotice({
  count,
}: {
  readonly count: number;
}): ReactElement | null {
  if (count === 0) return null;
  return (
    <p
      className="text-xs text-zinc-600 dark:text-zinc-400"
      data-testid="gaps-stranded"
    >
      {count} match{count === 1 ? "" : "es"} point
      {count === 1 ? "s" : ""} at a requirement that no longer exists, so
      {count === 1 ? " it is" : " they are"} not counted here. Re-running
      matching will rebuild them against the current requirements.
    </p>
  );
}

export default function GapsView({
  gaps,
  evidenceStatus = "current",
  strandedMatches = 0,
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
          {evidenceStatus === "current"
            ? "✓ Every must-have requirement has a qualifying match."
            : "No gaps to show yet — the evidence behind older matches has " +
              "not been established, so this is not yet a clean bill of health."}
        </p>
        <EvidenceNotice status={evidenceStatus} />
        <StrandedNotice count={strandedMatches} />
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
              These have a match, but its evidence could not be checked. Treat
              them as unproven rather than as gaps.
            </p>
          </header>
          <ul className="space-y-2">
            {unverifiable.map((g) => (
              <RequirementRow
                key={g.requirement.id}
                req={g.requirement}
                reasons={g.reasons}
              />
            ))}
          </ul>
        </section>
      )}

      <EvidenceNotice status={evidenceStatus} />
      <StrandedNotice count={strandedMatches} />
    </section>
  );
}
