/**
 * Tasks + follow-ups sidebar on the Pipeline (#34). Collapsible, with
 * three sections built by `buildTaskSidebar`: Due today, Upcoming, and
 * Follow-ups (active Applications gone quiet for more than a week).
 *
 * Presentational: the container owns the task list, the optimistic
 * completion and the writes. Same density as the board (UI guidance
 * § Pipeline); failures render inline (rule 10).
 */

import { useState, type ReactElement } from "react";

import { formatDueDate } from "../../lib/taskDates.ts";
import type { Task, UUID } from "../../types/crm.ts";

export interface PipelineTaskItem {
  readonly task: Task;
  /** The Application the task is about, e.g. "Acme: Staff PM". */
  readonly label: string;
  /** Completion is being written. */
  readonly pending: boolean;
}

export interface PipelineFollowUpItem {
  readonly applicationId: UUID;
  readonly label: string;
  readonly stageLabel: string;
  readonly daysSilent: number;
  /** A follow-up task is being created for it. */
  readonly adding: boolean;
}

export interface PipelineTasks {
  readonly dueToday: readonly PipelineTaskItem[];
  readonly upcoming: readonly PipelineTaskItem[];
  readonly followUps: readonly PipelineFollowUpItem[];
  readonly onComplete: (taskId: UUID) => void;
  readonly onAddFollowUp: (applicationId: UUID) => void;
  /** Create a task from a card's quick-add. */
  readonly onAddTask: (
    applicationId: UUID,
    title: string,
    dueAt: string | undefined,
  ) => Promise<void>;
  /** Pre-filled due date for a card's quick-add. */
  readonly defaultDueAtFor: (applicationId: UUID) => string | undefined;
  readonly error: string | null;
  readonly onDismissError: () => void;
  /**
   * The tasks read failed, so which Applications already have a task
   * is unknown. Follow-ups are withheld rather than risk duplicates.
   */
  readonly tasksUnavailable: boolean;
}

const SIDEBAR_ID = "pipeline-task-sidebar-body";

function TaskRow({
  item,
  onComplete,
}: {
  readonly item: PipelineTaskItem;
  readonly onComplete: (taskId: UUID) => void;
}): ReactElement {
  const due = formatDueDate(item.task.due_at);
  const checkboxId = `task-done-${item.task.id}`;
  return (
    <li
      data-testid="pipeline-task"
      data-task-id={item.task.id}
      aria-busy={item.pending}
      className={"flex items-start gap-2 " + (item.pending ? "opacity-60" : "")}
    >
      <input
        id={checkboxId}
        type="checkbox"
        checked={item.task.completed}
        disabled={item.pending}
        onChange={() => onComplete(item.task.id)}
        data-action="pipeline-task-complete"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:accent-zinc-100 dark:focus-visible:ring-zinc-100"
      />
      <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
        <span className="block truncate text-sm leading-snug text-zinc-900 dark:text-zinc-100">
          {item.task.title}
        </span>
        <span className="block truncate text-xs leading-snug text-zinc-600 dark:text-zinc-400">
          {item.label}
          {due !== null && (
            <>
              {" · "}
              <time dateTime={item.task.due_at}>{due}</time>
            </>
          )}
        </span>
      </label>
    </li>
  );
}

function Section({
  title,
  testId,
  count,
  empty,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly count: number;
  readonly empty: string;
  readonly children: ReactElement[];
}): ReactElement {
  const headingId = `${testId}-heading`;
  return (
    <section aria-labelledby={headingId} data-testid={testId} className="space-y-1.5">
      <h3
        id={headingId}
        className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400"
      >
        <span>{title}</span>
        <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{count}</span>
      </h3>
      {count === 0 ? (
        <p className="text-xs leading-snug text-zinc-600 dark:text-zinc-400">{empty}</p>
      ) : (
        <ul className="space-y-1.5">{children}</ul>
      )}
    </section>
  );
}

export default function TaskSidebar({
  tasks,
}: {
  readonly tasks: PipelineTasks;
}): ReactElement {
  const [open, setOpen] = useState(true);
  const openCount = tasks.dueToday.length + tasks.upcoming.length;

  return (
    <aside
      aria-label="Tasks and follow-ups"
      data-testid="pipeline-task-sidebar"
      className="space-y-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={SIDEBAR_ID}
        data-action="pipeline-task-sidebar-toggle"
        className="flex w-full items-center justify-between rounded text-sm font-medium text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:text-zinc-100 dark:focus-visible:ring-zinc-100"
      >
        <span>
          Tasks{" "}
          <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
            {openCount}
          </span>
          {tasks.followUps.length > 0 && (
            <span className="text-zinc-600 dark:text-zinc-400">
              {" · "}
              {tasks.followUps.length} follow-up
              {tasks.followUps.length === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="text-xs text-zinc-600 dark:text-zinc-400">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open && (
        <div id={SIDEBAR_ID} className="space-y-4">
          {tasks.error !== null && (
            <div
              role="alert"
              data-testid="pipeline-task-error"
              className="flex items-start justify-between gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              <p>{tasks.error}</p>
              <button
                type="button"
                onClick={tasks.onDismissError}
                className="shrink-0 rounded px-1 hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 dark:hover:bg-red-900 dark:focus-visible:ring-red-300"
              >
                Dismiss
              </button>
            </div>
          )}

          <Section
            title="Due today"
            testId="pipeline-tasks-due-today"
            count={tasks.dueToday.length}
            empty="Nothing due today."
          >
            {tasks.dueToday.map((item) => (
              <TaskRow key={item.task.id} item={item} onComplete={tasks.onComplete} />
            ))}
          </Section>

          <Section
            title="Upcoming"
            testId="pipeline-tasks-upcoming"
            count={tasks.upcoming.length}
            empty="Nothing due in the next 7 days."
          >
            {tasks.upcoming.map((item) => (
              <TaskRow key={item.task.id} item={item} onComplete={tasks.onComplete} />
            ))}
          </Section>

          <Section
            title="Follow-ups"
            testId="pipeline-follow-ups"
            count={tasks.followUps.length}
            empty={
              tasks.tasksUnavailable
                ? "Tasks couldn't be loaded, so follow-ups are hidden to avoid duplicates. Reload to try again."
                : "No applied or interviewing application has gone quiet for over a week."
            }
          >
            {tasks.followUps.map((f) => (
              <li
                key={f.applicationId}
                data-testid="pipeline-follow-up"
                data-application-id={f.applicationId}
                className="space-y-1"
              >
                <p className="truncate text-sm leading-snug text-zinc-900 dark:text-zinc-100">
                  {f.label}
                </p>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                    {f.daysSilent} days quiet in {f.stageLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => tasks.onAddFollowUp(f.applicationId)}
                    disabled={f.adding}
                    data-action="pipeline-add-follow-up"
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 disabled:opacity-60 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus-visible:ring-zinc-100"
                  >
                    {f.adding ? "Adding…" : "Add task"}
                  </button>
                </div>
              </li>
            ))}
          </Section>
        </div>
      )}
    </aside>
  );
}
