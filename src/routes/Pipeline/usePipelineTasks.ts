/**
 * Task state for the Pipeline (#34): the owner's tasks, adding them
 * (card quick-add and sidebar follow-ups), and completing them.
 *
 * Completion is optimistic like card moves (#511): the task leaves its
 * section at once, the write (task done + Application
 * `last_activity_at`, one batch) runs, and a rejected write puts the
 * task back with an inline error. On success the card's days-in-stage
 * resets through the board reducer's `touched` action.
 *
 * Adding is not optimistic: the quick-add form shows "Adding…" and
 * keeps the typed title on failure, so nothing has to be rolled back
 * out of the sidebar.
 */

import { useCallback, useMemo, useState } from "react";

import { beginAppBusy } from "../../lib/appBusy.ts";
import { MAX_TASK_TITLE, type NewTask } from "../../services/tasks.ts";
import type { Application, Task, UUID } from "../../types/crm.ts";

import type { PipelineMoveAction } from "./pipelineMoves.ts";
import { STAGE_LABELS } from "./PipelineView.tsx";
import type { PipelineTasks } from "./TaskSidebar.tsx";
import { buildTaskSidebar, defaultDueAt } from "./taskSidebar.ts";

export interface PipelineTaskDeps {
  readonly createTask: (input: NewTask, now: Date) => Promise<Task>;
  readonly completeTask: (
    task: Pick<Task, "id" | "application_id">,
    at: string,
  ) => Promise<void>;
  readonly now: () => Date;
}

/** Fit a generated title within the rules' limit. */
function truncateTitle(title: string): string {
  return title.length <= MAX_TASK_TITLE
    ? title
    : `${title.slice(0, MAX_TASK_TITLE - 1)}…`;
}

function reason(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .trim()
    .replace(/\.$/, "");
}

export function usePipelineTasks({
  deps,
  loadedTasks,
  tasksLoaded,
  applications,
  labelFor,
  now,
  dispatch,
  onActivity,
}: {
  readonly deps: PipelineTaskDeps;
  /** Tasks from the latest load; replaces local state when it changes. */
  readonly loadedTasks: readonly Task[] | null;
  /** False when the tasks read failed (see `PipelineData.tasksLoaded`). */
  readonly tasksLoaded: boolean;
  readonly applications: readonly Application[];
  /** "Acme: Staff PM" for an Application, with the board's fallbacks. */
  readonly labelFor: (applicationId: UUID) => string;
  readonly now: Date;
  readonly dispatch: (action: PipelineMoveAction) => void;
  /** Advance the board clock after recorded activity. */
  readonly onActivity: (at: Date) => void;
}): PipelineTasks {
  const [tasks, setTasks] = useState<readonly Task[]>(loadedTasks ?? []);
  const [pending, setPending] = useState<ReadonlySet<UUID>>(new Set());
  const [adding, setAdding] = useState<ReadonlySet<UUID>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Adopt a fresh load in the same render it arrives in. Copying it in
  // an effect instead rendered the sidebar for one frame with no tasks
  // while the board already showed the loaded data.
  const [source, setSource] = useState(loadedTasks);
  if (loadedTasks !== source) {
    setSource(loadedTasks);
    setTasks(loadedTasks ?? []);
  }

  const sidebar = useMemo(
    () => buildTaskSidebar(tasks, applications, now),
    [tasks, applications, now],
  );

  const create = useCallback(
    async (input: NewTask): Promise<void> => {
      const releaseBusy = beginAppBusy("pipeline.addTask");
      try {
        const task = await deps.createTask(input, deps.now());
        setTasks((prev) => [...prev, task]);
      } finally {
        releaseBusy();
      }
    },
    [deps],
  );

  const onAddTask = useCallback(
    (applicationId: UUID, title: string, dueAt: string | undefined) =>
      create({
        application_id: applicationId,
        title,
        ...(dueAt !== undefined && { due_at: dueAt }),
      }),
    [create],
  );

  const onAddFollowUp = useCallback(
    (applicationId: UUID): void => {
      if (adding.has(applicationId)) return;
      setAdding((prev) => new Set(prev).add(applicationId));
      setError(null);
      // Due today: the application has already been quiet too long.
      create({
        application_id: applicationId,
        title: truncateTitle(`Follow up: ${labelFor(applicationId)}`),
        due_at: deps.now().toISOString(),
      })
        .catch((err: unknown) => {
          setError(`Couldn't add the follow-up task: ${reason(err)}.`);
        })
        .finally(() => {
          setAdding((prev) => {
            const next = new Set(prev);
            next.delete(applicationId);
            return next;
          });
        });
    },
    [adding, create, deps, labelFor],
  );

  const onComplete = useCallback(
    (taskId: UUID): void => {
      const task = tasks.find((t) => t.id === taskId);
      if (task === undefined || task.completed || pending.has(taskId)) return;
      const at = deps.now();
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, completed: true } : t)),
      );
      setPending((prev) => new Set(prev).add(taskId));
      setError(null);
      const releaseBusy = beginAppBusy("pipeline.completeTask");
      const settle = (): void =>
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      deps
        .completeTask(task, at.toISOString())
        .then(
          () => {
            settle();
            dispatch({ type: "touched", id: task.application_id, at: at.toISOString() });
            onActivity(at);
          },
          (err: unknown) => {
            settle();
            setTasks((prev) =>
              prev.map((t) => (t.id === taskId ? { ...t, completed: false } : t)),
            );
            setError(`Couldn't complete "${task.title}": ${reason(err)}. It's back on the list.`);
          },
        )
        .finally(releaseBusy);
    },
    [deps, dispatch, onActivity, pending, tasks],
  );

  const stageById = useMemo(
    () => new Map(applications.map((a) => [a.id, a.stage])),
    [applications],
  );

  const toItem = (task: Task) => ({
    task,
    label: labelFor(task.application_id),
    pending: pending.has(task.id),
  });

  return {
    dueToday: sidebar.dueToday.map(toItem),
    upcoming: sidebar.upcoming.map(toItem),
    // Without the task list, "no open task" cannot be known.
    followUps: (tasksLoaded ? sidebar.followUps : []).map((f) => ({
      applicationId: f.application.id,
      label: labelFor(f.application.id),
      stageLabel: STAGE_LABELS[f.application.stage],
      daysSilent: f.daysSilent,
      adding: adding.has(f.application.id),
    })),
    onComplete,
    onAddFollowUp,
    onAddTask,
    defaultDueAtFor: (applicationId: UUID) => {
      const stage = stageById.get(applicationId);
      return stage === undefined ? undefined : defaultDueAt(stage, deps.now());
    },
    error,
    onDismissError: () => setError(null),
    tasksUnavailable: !tasksLoaded,
  };
}
