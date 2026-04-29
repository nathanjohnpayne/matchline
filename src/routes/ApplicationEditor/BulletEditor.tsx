/**
 * Inline edit row for a single GeneratedItem (#24, sub-issue
 * #188).
 *
 * Replaces the static `ClaimAnnotation` rendering when the user
 * enters edit mode (via the FlagBadge popover's "Edit this
 * bullet" button, or via a per-row Edit affordance on a clean
 * bullet). Holds its own draft text in a textarea, fires
 * `onSave(newText)` on explicit Save and on debounced autosave,
 * and fires `onCancel()` on explicit Cancel.
 *
 * **Keybindings** per `docs/design/ui-guidance.md` rule 4 (Inline
 * over modal: "click the field, type, Enter commits, Escape
 * cancels"):
 *   - `Enter` (without Shift) commits the current draft and exits
 *     edit mode. Same effect as the Save button.
 *   - `Shift+Enter` inserts a newline (so multi-paragraph claim
 *     edits are still possible).
 *   - `Escape` cancels the edit — discards the draft and exits
 *     edit mode. Same effect as the Cancel button.
 *
 * **Autosave** fires 1500ms after the most recent keystroke when
 * the draft differs from the last-saved text. Stays in edit mode
 * (preserves the user's cursor + scroll position); only explicit
 * Save / `Enter` exits.
 *
 * Status states match the InlineEditForm precedent in UnitReview:
 *   - "editing": user is typing, no save in flight
 *   - "saving":  save call in flight; inputs disabled
 *   - "error":   last save failed; render error banner above the
 *                textarea, allow retry on next keystroke / Save
 *
 * The component is split out from the view so its rendering shape
 * is unit-testable via `renderToStaticMarkup` (no React-Testing-
 * Library dep) — same convention as the rest of this route.
 */

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";

export type BulletEditorStatus = "editing" | "saving" | "error";

export interface BulletEditorProps {
  /** Current persisted text — the starting draft. */
  readonly initialText: string;
  /**
   * Save handler. Called on explicit Save / `Enter` AND on
   * debounced autosave (the row passes the same `onSave` for
   * both — no special "this is autosave" flag, since the
   * backend doesn't care which triggered it). Async because the
   * service write talks to Firestore + the validation re-run
   * callable; the row flips to "saving" while in flight.
   */
  readonly onSave: (newText: string) => Promise<void>;
  /** Cancel handler — exits edit mode without saving. */
  readonly onCancel: () => void;
  /**
   * Idle delay (ms) before autosave fires. Defaults to
   * `AUTOSAVE_DEBOUNCE_MS`; tests can pass a smaller value to
   * pin the debounce shape without sleep().
   */
  readonly autosaveMs?: number;
}

/** Default autosave idle window — 1.5 seconds. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

export default function BulletEditor({
  initialText,
  onSave,
  onCancel,
  autosaveMs = AUTOSAVE_DEBOUNCE_MS,
}: BulletEditorProps): ReactElement {
  const [draft, setDraft] = useState(initialText);
  const [status, setStatus] = useState<BulletEditorStatus>("editing");
  const [error, setError] = useState<Error | null>(null);
  // Track the last text we successfully saved so autosave doesn't
  // re-fire for the same value (idempotent debounce).
  const lastSavedRef = useRef(initialText);

  // Debounced autosave — fires `autosaveMs` after the last
  // keystroke when the draft differs from the last-saved snapshot
  // AND we aren't already saving. Cleanup clears the timer on
  // every keystroke so it always tracks the LATEST keystroke.
  useEffect(() => {
    if (status === "saving") return;
    if (draft === lastSavedRef.current) return;
    if (draft.trim().length === 0) return;
    const handle = setTimeout(async () => {
      // Re-check inside the timer in case a keystroke landed
      // during the wait that brought draft back to the saved
      // value.
      if (draft === lastSavedRef.current) return;
      setStatus("saving");
      setError(null);
      try {
        await onSave(draft);
        lastSavedRef.current = draft;
        setStatus("editing");
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    }, autosaveMs);
    return () => clearTimeout(handle);
  }, [draft, autosaveMs, onSave, status]);

  const onChangeDraft = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    if (status === "error") setStatus("editing");
  };

  const commitDraft = async (): Promise<void> => {
    if (status === "saving") return;
    if (draft.trim().length === 0) {
      setStatus("error");
      setError(
        new Error("Bullet text can't be empty. Use Remove instead."),
      );
      return;
    }
    if (draft === lastSavedRef.current) {
      // No-op save — just exit edit mode.
      onCancel();
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      await onSave(draft);
      lastSavedRef.current = draft;
      onCancel(); // explicit save exits edit mode
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    await commitDraft();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter (without Shift) commits — Shift+Enter inserts a
    // newline (default browser behavior). Escape cancels. Both
    // shortcuts match the UnitReview precedent + the UI
    // guidance rule 4 spec ("Enter commits, Escape cancels").
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commitDraft();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const saving = status === "saving";

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-2"
      data-testid="bullet-editor"
      data-edit-status={status}
    >
      {status === "error" && error !== null && (
        <p
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          data-testid="bullet-editor-error"
        >
          {error.message}
        </p>
      )}
      <textarea
        value={draft}
        onChange={onChangeDraft}
        onKeyDown={onKeyDown}
        disabled={saving}
        rows={3}
        autoFocus
        aria-label="Bullet text"
        data-testid="bullet-editor-textarea"
        className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
      />
      <div className="flex items-center justify-between gap-2">
        <p
          className="text-xs text-zinc-400 dark:text-zinc-500"
          data-testid="bullet-editor-hint"
        >
          <kbd className="font-mono">Enter</kbd> commits ·{" "}
          <kbd className="font-mono">Shift+Enter</kbd> for newline ·{" "}
          <kbd className="font-mono">Esc</kbd> cancels
        </p>
        <div className="flex items-center gap-2">
          {saving && (
            <span
              className="text-xs italic text-zinc-500"
              data-testid="bullet-editor-saving"
              aria-live="polite"
            >
              Saving&hellip;
            </span>
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            data-action="bullet-cancel"
            className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || draft.trim().length === 0}
            data-action="bullet-save"
            className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Save
          </button>
        </div>
      </div>
    </form>
  );
}
