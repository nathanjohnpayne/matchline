/**
 * "N of 20 approved" header widget for the Unit Review surface.
 *
 * The success metric for Unit Review per `specs/matchline.md` is ≥ 20
 * approved Units — that's when the onboarding loop is considered
 * "sufficient" and the user has enough of a Capability Graph to get
 * useful matches. This component surfaces that milestone as a small
 * counter with a visually distinct state at and above the threshold.
 *
 * The threshold is exported so the #82 integration test can import
 * it rather than hard-code a magic number.
 */

import type { ReactElement } from "react";

export const APPROVED_MILESTONE = 20;

export interface ApprovalCounterProps {
  readonly approved: number;
}

export default function ApprovalCounter({
  approved,
}: ApprovalCounterProps): ReactElement {
  const hit = approved >= APPROVED_MILESTONE;
  const label = hit
    ? `${approved} approved — onboarding complete`
    : `${approved} of ${APPROVED_MILESTONE} approved`;
  const tone = hit
    ? "bg-slate-900 text-slate-50 dark:bg-slate-100 dark:text-slate-900"
    : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

  return (
    <span
      data-milestone={hit ? "hit" : "pending"}
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${tone}`}
      aria-label={label}
      role="status"
    >
      {label}
    </span>
  );
}
