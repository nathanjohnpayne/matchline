/**
 * Inline "add a task" form (#34), shared by the Pipeline card's
 * `+ task` affordance and Role Detail's Applications tab. Inline, not
 * a modal (UI guidance rule 4): Enter adds, Escape cancels, and a
 * failed write stays in the form with an inline error (rule 10).
 */

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";

import { dateInputToIso, isoToDateInput } from "../lib/taskDates.ts";

export interface TaskQuickAddProps {
  /** Names the Application in the accessible label, e.g. "Acme: Staff PM". */
  readonly label: string;
  /** Pre-filled due date (ISO), or undefined for none. */
  readonly defaultDueAt?: string;
  /** Persist the task. Rejecting keeps the form open with the error. */
  readonly onSubmit: (title: string, dueAt: string | undefined) => Promise<void>;
  readonly onCancel: () => void;
}

export default function TaskQuickAdd({
  label,
  defaultDueAt,
  onSubmit,
  onCancel,
}: TaskQuickAddProps): ReactElement {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(() => isoToDateInput(defaultDueAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (saving || title.trim() === "") return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(title.trim(), dateInputToIso(due));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key === "Escape" && !saving) {
      e.preventDefault();
      onCancel();
    }
  };

  const fieldClass =
    "rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100";

  return (
    <form
      onSubmit={(e) => void submit(e)}
      onKeyDown={onKeyDown}
      aria-label={`Add task for ${label}`}
      data-testid="task-quick-add"
      className="space-y-1.5 rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <input
        ref={titleRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={saving}
        maxLength={200}
        placeholder="Follow up with the recruiter"
        aria-label="Task"
        data-testid="task-quick-add-title"
        className={`w-full ${fieldClass}`}
      />
      {/* One field per row: the form also opens inside a narrow board
          column, where a date input beside the buttons collapses. */}
      <input
        type="date"
        value={due}
        onChange={(e) => setDue(e.target.value)}
        disabled={saving}
        aria-label="Due date"
        data-testid="task-quick-add-due"
        className={`w-full ${fieldClass}`}
      />
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:focus-visible:ring-zinc-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || title.trim() === ""}
          data-action="task-quick-add-submit"
          className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-zinc-50 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus-visible:ring-zinc-100"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
      {error !== null && (
        <p
          role="alert"
          data-testid="task-quick-add-error"
          className="text-xs text-red-700 dark:text-red-300"
        >
          Couldn&apos;t add the task: {error}
        </p>
      )}
    </form>
  );
}
