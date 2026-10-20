/**
 * Pure selection for the Pipeline's tasks + follow-ups sidebar (#34).
 * No clock and no Firestore: the caller passes `now`, and "today" is
 * the viewer's local calendar day, so a task due at 23:00 local is
 * due today even when that instant is tomorrow in UTC.
 *
 * Sections (#34):
 *   - Due today: open tasks due by the end of today, overdue included.
 *   - Upcoming: open tasks due within the next 7 calendar days, then open
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

/**
 * The last millisecond of the local calendar day `daysAhead` days after
 * `now`'s (0 = today). Calendar arithmetic, not multiples of 24h, so a
 * daylight-saving change inside the span cannot shift the boundary.
 */
export function endOfLocalDay(now: Date, daysAhead = 0): number {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysAhead + 1,
    0,
    0,
    0,
    0,
  ).getTime() - 1;
}

/**
 * Default `due_at` for a new task (#34): three calendar days out for
 * an Application in an active stage, otherwise none. Local noon of that
 * day, the same instant a picked date is stored as
 * (`src/lib/taskDates.ts`), and calendar arithmetic so a DST change
 * cannot land it on the neighboring day.
 */
export function defaultDueAt(
  stage: ApplicationStage,
  now: Date,
): string | undefined {
  if (!ACTIVE_STAGES.has(stage)) return undefined;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + DEFAULT_DUE_DAYS,
    12,
    0,
    0,
    0,
  ).toISOString();
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

/**
 * Task order shared by the sidebar sections and the card's Next action
 * (#512): due date ascending, undated tasks after dated ones, ties by
 * creation time.
 */
export function compareTasksByDue(a: Task, b: Task): number {
  const da = toMs(a.due_at) ?? Infinity;
  const db = toMs(b.due_at) ?? Infinity;
  if (da !== db) return da < db ? -1 : 1;
  // The rules require `created_at` on create, but a document written
  // before that rule (or by the admin SDK) may lack it; never let one
  // bad record break the board's render.
  return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
}

export function buildTaskSidebar(
  tasks: readonly Task[],
  applications: readonly Application[],
  now: Date,
  /**
   * Applications to keep out of Follow-ups regardless, e.g. one whose
   * task completion is still being written: the optimistic
   * `completed: true` would otherwise make it look task-free (and
   * still quiet) until the write lands, inviting a duplicate.
   */
  suppressFollowUpFor: ReadonlySet<UUID> = new Set(),
): TaskSidebar {
  const endOfToday = endOfLocalDay(now);
  // Whole calendar days: a task due on the 7th day ahead is Upcoming
  // whatever the time of day the board is opened.
  const upcomingEnd = endOfLocalDay(now, UPCOMING_DAYS);
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
    if (withOpenTask.has(app.id) || suppressFollowUpFor.has(app.id)) continue;
    const last = toMs(app.last_activity_at);
    if (last === null) continue;
    const silentMs = now.getTime() - last;
    // Compare the raw span: "more than 7 days" starts at 7 days and
    // 1 ms, not at the next whole day (Codex P2 on #585). The floored
    // count is for display only.
    if (silentMs > FOLLOW_UP_AFTER_DAYS * MS_PER_DAY) {
      followUps.push({
        application: app,
        daysSilent: Math.floor(silentMs / MS_PER_DAY),
      });
    }
  }
  followUps.sort(
    (a, b) =>
      b.daysSilent - a.daysSilent ||
      a.application.id.localeCompare(b.application.id),
  );

  return {
    dueToday: dueToday.sort(compareTasksByDue),
    upcoming: [
      ...upcomingDated.sort(compareTasksByDue),
      ...undated.sort(compareTasksByDue),
    ],
    followUps,
  };
}

/**
 * Milliseconds from `now` until the start of the next local calendar
 * day. The Pipeline re-reads its clock then, so tasks roll from
 * Upcoming into Due today (and follow-ups appear) at midnight while
 * the page stays open.
 */
export function msUntilNextLocalDay(now: Date): number {
  return endOfLocalDay(now) + 1 - now.getTime();
}

/** True when both instants fall on the same local calendar day. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Each Application's next action (#512): its first open task in
 * `compareTasksByDue` order. Applications with no open task are absent.
 */
export function nextActionByApplication(
  tasks: readonly Task[],
): ReadonlyMap<UUID, Task> {
  const next = new Map<UUID, Task>();
  for (const task of tasks) {
    if (task.completed) continue;
    const current = next.get(task.application_id);
    if (current === undefined || compareTasksByDue(task, current) < 0) {
      next.set(task.application_id, task);
    }
  }
  return next;
}

/**
 * The next instant (epoch ms) at which an Application not yet in
 * Follow-ups will cross the 7-day threshold, or `null` when none will
 * (#589). Same eligibility as `buildTaskSidebar`: active stage, no
 * open task, not suppressed. The Pipeline re-reads its clock then, so
 * a follow-up appears when it becomes due, not at the next midnight.
 */
export function nextFollowUpAt(
  tasks: readonly Task[],
  applications: readonly Application[],
  now: Date,
  suppressFollowUpFor: ReadonlySet<UUID> = new Set(),
): number | null {
  const withOpenTask = new Set<UUID>(
    tasks.filter((t) => !t.completed).map((t) => t.application_id),
  );
  let next: number | null = null;
  for (const app of applications) {
    if (!ACTIVE_STAGES.has(app.stage)) continue;
    if (withOpenTask.has(app.id) || suppressFollowUpFor.has(app.id)) continue;
    const last = toMs(app.last_activity_at);
    if (last === null) continue;
    // First instant at which `now - last > 7 days` holds.
    const due = last + FOLLOW_UP_AFTER_DAYS * MS_PER_DAY + 1;
    if (due <= now.getTime()) continue; // already a follow-up
    if (next === null || due < next) next = due;
  }
  return next;
}

