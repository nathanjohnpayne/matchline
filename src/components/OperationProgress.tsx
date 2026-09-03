/**
 * Progress report for a long-running callable (#428).
 *
 * Replaces a 2px indeterminate bar and the word "Extracting…" — which
 * was the entire feedback for a **108.6 second** extraction — with the
 * stage actually running, elapsed time, and an expectation of how long
 * the whole thing takes.
 *
 * Still a thin bar plus text, not a spinner overlay, per
 * `docs/design/ui-guidance.md` rule 6. The bar stays indeterminate on
 * purpose: the pipeline's stages are not equal in duration (the LLM
 * call dominates), so a proportional bar would be a more precise lie
 * than an honest pulse.
 *
 * **Degrades honestly.** Given no event — an older deployed function,
 * a dropped stream, a non-streaming caller — it shows elapsed time and
 * the duration expectation, never a fabricated stage. That fallback is
 * the reason route A of #428 was rejected as the primary design: a
 * timer-driven UI claims "Saving" while attempt 2 is still running.
 */

import { useEffect, useState, type ReactElement } from "react";

import {
  durationHint,
  formatElapsed,
  progressMessage,
  type ProgressEvent,
  type ProgressVocabulary,
} from "../services/progress.ts";

/** Tick often enough to look live, rarely enough to be free. */
const TICK_MS = 1000;

export interface OperationProgressProps {
  /** Latest event received, or `null` before the first chunk arrives. */
  readonly event: ProgressEvent | null;
  /** Epoch ms when the operation started; drives elapsed time. */
  readonly startedAt: number;
  /** Nouns for this operation. */
  readonly vocabulary: ProgressVocabulary;
  /** Typical duration for the expectation line. */
  readonly typicalMs: number;
  /** Accessible label for the progress bar. */
  readonly label: string;
  readonly testId?: string;
}

export default function OperationProgress({
  event,
  startedAt,
  vocabulary,
  typicalMs,
  label,
  testId = "operation-progress",
}: OperationProgressProps): ReactElement {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Clamp: a clock adjustment mid-operation would otherwise render a
  // negative elapsed time.
  const elapsedMs = Math.max(0, now - startedAt);
  const retrying = event?.stage === "analyzing" && (event.attempt ?? 1) > 1;
  const statusText = progressMessage(event, vocabulary);

  return (
    <div className="space-y-2" data-testid={testId}>
      <div
        role="progressbar"
        aria-label={label}
        aria-busy="true"
        // Dynamic `aria-valuetext`, not just a static label. The bar is
        // intentionally indeterminate (no aria-valuenow), so valuetext
        // is the only channel that carries the stage and retry count to
        // a screen reader. RequirementsTab previously supplied a static
        // one and replacing it with visual-only text was a regression —
        // Codex P2 on PR #436.
        aria-valuetext={statusText}
        data-testid={`${testId}-bar`}
        className="h-0.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      >
        <div
          className={`h-full w-1/3 animate-pulse ${
            retrying
              ? "bg-amber-500 dark:bg-amber-400"
              : "bg-zinc-900 dark:bg-zinc-100"
          }`}
        />
      </div>
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span
          // `role="status"` + polite live region so stage and retry
          // changes are announced as they happen. Assertive would
          // interrupt; these are informational, and the operation can
          // run for minutes.
          role="status"
          aria-live="polite"
          data-testid={`${testId}-message`}
          data-stage={event?.stage ?? "unknown"}
          className={
            retrying
              ? "text-amber-700 dark:text-amber-400"
              : "text-zinc-600 dark:text-zinc-400"
          }
        >
          {statusText}
        </span>
        <span
          data-testid={`${testId}-elapsed`}
          className="tabular-nums text-zinc-500"
        >
          {formatElapsed(elapsedMs)}
        </span>
      </div>
      <p className="text-xs text-zinc-500" data-testid={`${testId}-hint`}>
        {durationHint(elapsedMs, typicalMs)}
      </p>
    </div>
  );
}
