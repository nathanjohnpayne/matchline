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

import {
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";

import { invokeExtractFromResume } from "../services/extraction.ts";

export type OnboardingStatus = "editing" | "extracting" | "error";

export default function Onboarding(): ReactElement {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<OnboardingStatus>("editing");
  const [error, setError] = useState<Error | null>(null);

  const onChangeText = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value);
    if (status === "error") setStatus("editing");
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (status === "extracting") return;
    if (text.trim().length === 0) {
      setStatus("error");
      setError(new Error("Paste resume text first."));
      return;
    }
    setStatus("extracting");
    setError(null);
    try {
      await invokeExtractFromResume(text);
      // Pipeline persisted the Units; the Unit Review
      // subscription will deliver them on /units.
      navigate("/units");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err : new Error(String(err)));
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
        <div
          role="progressbar"
          aria-label="Extracting Experience Units"
          aria-busy="true"
          data-testid="onboarding-progress"
          className="h-0.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          <div className="h-full w-1/3 animate-pulse bg-zinc-900 dark:bg-zinc-100" />
        </div>
      )}

      {status === "error" && error !== null && (
        <p
          role="alert"
          data-testid="onboarding-error"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error.message}
        </p>
      )}

      <form onSubmit={onSubmit} className="space-y-3">
        <label
          htmlFor="onboarding-text"
          className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
        >
          Resume text
        </label>
        <textarea
          id="onboarding-text"
          value={text}
          onChange={onChangeText}
          disabled={extracting}
          rows={20}
          aria-label="Resume text"
          aria-describedby="onboarding-helper"
          placeholder={"Paste your resume as plain text. Headers and bullet points are fine — we'll structure it."}
          data-testid="onboarding-textarea"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
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
          <span>{extracting ? "Extracting…" : ""}</span>
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
