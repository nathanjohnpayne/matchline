/**
 * Onboarding route — paste-resume entry point of the core loop
 * (sub-issue #199, front-end for #17).
 *
 * The user pastes a resume; the route calls `invokeExtractFromResume`
 * which runs the full server-side pipeline (extract → embed →
 * persist) and returns the persisted Units. On success the route
 * navigates to `/units` (Unit Review) so the user can approve
 * before any Unit enters the matching pipeline (zero-fabrication
 * invariant — only user-approved Units ground generation).
 *
 * V1 simplification per UI guidance § Onboarding: the spec calls
 * for a three-pane layout (input method selection / pasted content
 * / extracted Units streaming in). This V1 ships the single
 * paste-resume textarea + the redirect-to-Unit-Review handoff.
 * LinkedIn HTML / long-form context paste flows are deferred —
 * the underlying extraction pipeline is text-only at V1 anyway.
 *
 * Status states mirror the BulletEditor convention from sub-issue
 * #188 + InlineEditForm from #81:
 *   - "editing": user is composing input, no extract in flight
 *   - "extracting": call in flight; textarea + button disabled,
 *     thin top progress bar visible (UI guidance rule 6: "no
 *     spinner overlays")
 *   - "error": last extract failed; inline error banner above
 *     the textarea, allow retry on next keystroke / Submit
 */

import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";

import OperationProgress from "../components/OperationProgress.tsx";
import ResumeEditor from "../components/ResumeEditor.tsx";
import { beginAppBusy, beginUnsavedWork } from "../lib/appBusy.ts";
import { friendlyCallableError } from "../lib/callable-errors.ts";
import { invokeExtractFromResume } from "../services/extraction.ts";
import {
  EXTRACTION_VOCABULARY,
  TYPICAL_DURATION_MS,
  type ProgressEvent,
} from "../services/progress.ts";

export type OnboardingStatus = "editing" | "extracting" | "error";

export default function Onboarding(): ReactElement {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<OnboardingStatus>("editing");
  // Holds display copy, not the raw failure. Callable errors reach
  // this route with a message that is sometimes just the status code
  // (#422 rendered a banner reading "internal"), so the mapping to
  // user-facing text happens on the way in, at the one place that
  // knows the call failed.
  const [error, setError] = useState<string | null>(null);
  // Progress state for the ~108s extraction (#428). `null` until the
  // first chunk lands, which OperationProgress renders as elapsed time
  // plus a duration expectation rather than a guessed stage.
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [startedAt, setStartedAt] = useState<number>(0);

  // The pasted résumé lives only in React state — no draft persistence
  // anywhere in the repo — so a one-click reload from the update banner
  // would silently discard it (#456). Declaring it as unsaved work gates
  // that reload behind a confirmation; the extraction's busy lease is
  // separate and suppresses the prompt outright while the call runs.
  useEffect(() => {
    if (text.trim().length === 0) return;
    return beginUnsavedWork("onboarding.resumeDraft");
  }, [text]);


  const onEditorChange = (markdown: string): void => {
    setText(markdown);
    if (status === "error") setStatus("editing");
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (status === "extracting") return;
    if (text.trim().length === 0) {
      setStatus("error");
      setError("Paste resume text first.");
      return;
    }
    setStatus("extracting");
    setError(null);
    setProgress(null);
    setStartedAt(Date.now());
    // Suppress the update-reload banner for the duration: extraction
    // runs ~108s, and offering a reload mid-call invites destroying
    // work that is about to succeed (#429). A per-invocation lease, so
    // one extraction settling cannot un-suppress another that is still
    // running (Codex P2 on PR #434).
    const releaseBusy = beginAppBusy("onboarding.extract");
    try {
      await invokeExtractFromResume(text, setProgress);
      // Pipeline persisted the Units; the Unit Review
      // subscription will deliver them on /units.
      navigate("/units");
    } catch (err) {
      setStatus("error");
      setError(
        friendlyCallableError(err, {
          operation: "extracting your resume",
          timeoutHint:
            "Trimming it to the roles most relevant to your target market usually helps.",
        }),
      );
    } finally {
      // finally, not the two branches: the success path navigates away
      // and an unreleased lease would suppress the banner for the rest
      // of the session.
      releaseBusy();
    }
  };

  const extracting = status === "extracting";
  const charCount = text.length;
  // Rough character ceiling on what we'll actually pass to the
  // model. The extraction pipeline accepts longer inputs but tail
  // content past ~50k chars is rarely useful — the user usually
  // wants to paste a focused résumé, not a multi-page CV with
  // every project. Soft warning above 50k; not a hard block.
  const SOFT_LIMIT = 50000;

  return (
    <section
      className="mx-auto max-w-3xl space-y-4"
      data-testid="onboarding"
      data-onboarding-status={status}
    >
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Onboarding
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Paste your resume below. We&rsquo;ll extract structured Experience
          Units that you review before they enter matching. Nothing
          enters the matching pipeline without your explicit approval.
        </p>
      </header>

      {/* Thin top progress bar per UI guidance rule 6 — replaces
          a spinner overlay. Only visible during extraction. */}
      {extracting && (
        <OperationProgress
          event={progress}
          startedAt={startedAt}
          vocabulary={EXTRACTION_VOCABULARY}
          typicalMs={TYPICAL_DURATION_MS.extraction}
          label="Extracting Experience Units"
          testId="onboarding-progress"
        />
      )}

      {status === "error" && error !== null && (
        <p
          role="alert"
          data-testid="onboarding-error"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <form onSubmit={onSubmit} className="space-y-3">
        <span
          className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
        >
          Resume text
        </span>
        <ResumeEditor
          onChange={onEditorChange}
          disabled={extracting}
          placeholder="Paste your resume — Markdown renders (# headers, **bold**, - bullet lists). We'll structure it."
        />
        <div
          id="onboarding-helper"
          className="flex items-center justify-between text-xs text-zinc-500"
        >
          <span data-testid="onboarding-char-count">
            {charCount.toLocaleString()} character
            {charCount === 1 ? "" : "s"}
            {charCount > SOFT_LIMIT && (
              <span
                className="ml-2 text-amber-700 dark:text-amber-400"
                data-testid="onboarding-soft-limit-warning"
              >
                (long input — consider focusing on roles relevant to your
                target market)
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={extracting || text.trim().length === 0}
            data-action="extract-units"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Extract Units
          </button>
        </div>
      </form>
    </section>
  );
}
