/**
 * Pure selection for the Pipeline's tasks + follow-ups sidebar (#34).
 * No clock and no Firestore: the caller passes `now`, and "today" is
 * the viewer's local calendar day, so a task due at 23:00 local is
 * due today even when that instant is tomorrow in UTC.
 *
 * Sections (#34):
 *   - Due today: open tasks due by the end of today, overdue included.
 *   - Upcoming: open tasks due within the next 7 days, then open
 *     tasks with no due date (they belong to no day, and hiding them
 *     would lose them).
 *   - Follow-ups: Applications in an active stage (Applied,
 *     Interviewing) with no activity for more than 7 days and no open
 *     task. Adding a task for one removes it from this list.
 */

import type {
  Application,
  ApplicationStage,
  Task,
  UUID,
} from "../../types/crm.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Stages where silence means a follow-up is due (#34). */
export const ACTIVE_STAGES: ReadonlySet<ApplicationStage> = new Set([
  "applied",
  "interviewing",
]);

/** Days of no activity before an active Application needs a follow-up. */
export const FOLLOW_UP_AFTER_DAYS = 7;
/** How far ahead Upcoming looks. */
export const UPCOMING_DAYS = 7;
/** Default due date offset for a new task on an active Application. */
export const DEFAULT_DUE_DAYS = 3;

function toMs(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The last millisecond of `now`'s local calendar day. */
export function endOfLocalDay(now: Date): number {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  ).getTime() - 1;
}

/**
 * Default `due_at` for a new task (#34): now + 3 days for an
 * Application in an active stage, otherwise none.
 */
export function defaultDueAt(
  stage: ApplicationStage,
  now: Date,
): string | undefined {
  if (!ACTIVE_STAGES.has(stage)) return undefined;
  return new Date(now.getTime() + DEFAULT_DUE_DAYS * MS_PER_DAY).toISOString();
}

export interface FollowUp {
  readonly application: Application;
  /** Whole days since `last_activity_at`. */
  readonly daysSilent: number;
}

export interface TaskSidebar {
  readonly dueToday: readonly Task[];
  readonly upcoming: readonly Task[];
  readonly followUps: readonly FollowUp[];
}

function byDueThenCreated(a: Task, b: Task): number {
  const da = toMs(a.due_at) ?? Infinity;
  const db = toMs(b.due_at) ?? Infinity;
  if (da !== db) return da < db ? -1 : 1;
  return a.created_at.localeCompare(b.created_at);
}

export function buildTaskSidebar(
  tasks: readonly Task[],
  applications: readonly Application[],
  now: Date,
): TaskSidebar {
  const endOfToday = endOfLocalDay(now);
  const upcomingEnd = now.getTime() + UPCOMING_DAYS * MS_PER_DAY;
  const open = tasks.filter((t) => !t.completed);

  const dueToday: Task[] = [];
  const upcomingDated: Task[] = [];
  const undated: Task[] = [];
  for (const task of open) {
    const due = toMs(task.due_at);
    if (due === null) {
      // An unparseable due date is shown with the undated tasks rather
      // than dropped.
      undated.push(task);
    } else if (due <= endOfToday) {
      dueToday.push(task);
    } else if (due <= upcomingEnd) {
      upcomingDated.push(task);
    }
  }

  const withOpenTask = new Set<UUID>(open.map((t) => t.application_id));
  const followUps: FollowUp[] = [];
  for (const app of applications) {
    if (!ACTIVE_STAGES.has(app.stage)) continue;
    if (withOpenTask.has(app.id)) continue;
    const last = toMs(app.last_activity_at);
    if (last === null) continue;
    const daysSilent = Math.floor((now.getTime() - last) / MS_PER_DAY);
    if (daysSilent > FOLLOW_UP_AFTER_DAYS) {
      followUps.push({ application: app, daysSilent });
    }
  }
  followUps.sort(
    (a, b) =>
      b.daysSilent - a.daysSilent ||
      a.application.id.localeCompare(b.application.id),
  );

  return {
    dueToday: dueToday.sort(byDueThenCreated),
    upcoming: [
      ...upcomingDated.sort(byDueThenCreated),
      ...undated.sort(byDueThenCreated),
    ],
    followUps,
  };
}
