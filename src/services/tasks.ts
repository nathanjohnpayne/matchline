/**
 * Follow-up tasks on Applications (#34). Owner-scoped like the rest of
 * the CRM service layer; `firestore.rules` adds field limits (a task
 * must point at an Application the caller owns, and only `title`,
 * `due_at` and `completed` change after creation).
 */

import { FirebaseError } from "firebase/app";
import {
  doc,
  getDocs,
  query,
  runTransaction,
  setDoc,
  updateDoc,
} from "firebase/firestore";

import { getDb } from "../firebase.ts";
import type { Task, UUID } from "../types/crm.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

const TASKS = "tasks";

/** Same limit `firestore.rules` enforces on `title`. */
export const MAX_TASK_TITLE = 200;
const APPLICATIONS = "applications";

export interface NewTask {
  readonly application_id: UUID;
  readonly title: string;
  /** Omitted for an undated task. */
  readonly due_at?: string;
}

export async function listTasks(): Promise<Task[]> {
  const snap = await getDocs(
    query(typedCollection<Task>(TASKS), ...ownerScope()),
  );
  return snap.docs.map((d) => d.data());
}

/**
 * Build the stored Task for `input`. Pure, so the shape the rules see
 * is unit-testable: the title is trimmed, `completed` starts false, and
 * an absent `due_at` is omitted rather than written as `undefined`
 * (Firestore rejects undefined; same conditional-spread rule as
 * `buildRoleFromForm`).
 */
export function buildTask(
  input: NewTask,
  ids: { readonly id: UUID; readonly ownerUid: UUID },
  now: Date,
): Task {
  const title = input.title.trim();
  if (title === "") throw new Error("A task needs a title.");
  // Checked here so every creation path (quick-add, follow-ups) fails
  // locally with the cause instead of as a rules permission-denied.
  if (title.length > MAX_TASK_TITLE) {
    throw new Error(`A task title can be at most ${MAX_TASK_TITLE} characters.`);
  }
  return {
    id: ids.id,
    owner_uid: ids.ownerUid,
    application_id: input.application_id,
    title,
    completed: false,
    created_at: now.toISOString(),
    ...(input.due_at !== undefined && { due_at: input.due_at }),
  };
}

/** Create a task and return it as stored. */
export async function createTask(
  input: NewTask,
  now: Date = new Date(),
): Promise<Task> {
  const task = buildTask(
    input,
    { id: globalThis.crypto.randomUUID(), ownerUid: getOwnerUidOrThrow() },
    now,
  );
  await setDoc(typedDoc<Task>(TASKS, task.id), task);
  return task;
}

/**
 * Mark a task done and stamp its Application's `last_activity_at`
 * (#34: completing a follow-up is activity on the Application). One
 * transaction, so the two writes land together or not at all, and the
 * timestamp only moves forward: if newer activity was recorded since
 * `at` was captured (another tab, a slow write), it is kept rather
 * than overwritten with the older value (#588).
 *
 * A task can outlive its Application. The rules deny reading a
 * missing Application (`isOwner()` is false without a resource, the
 * anti-enumeration contract), so the transaction is rejected with
 * `permission-denied`. That case falls back to completing the task
 * alone, which the task rules allow; there is no Application left to
 * stamp. Any other failure propagates.
 */
export async function completeTask(
  task: Pick<Task, "id" | "application_id">,
  at: string,
): Promise<void> {
  const db = getDb();
  const taskRef = doc(db, TASKS, task.id);
  const appRef = doc(db, APPLICATIONS, task.application_id);
  try {
    await runTransaction(db, async (tx) => {
      const app = await tx.get(appRef);
      tx.update(taskRef, { completed: true });
      if (app.exists() && !isNewer(app.data()["last_activity_at"], at)) {
        tx.update(appRef, { last_activity_at: at });
      }
    });
  } catch (err) {
    if (!(err instanceof FirebaseError && err.code === "permission-denied")) {
      throw err;
    }
    // Most likely the Application is gone. If the task itself is not
    // ours either, this update is denied too and that error surfaces.
    await updateDoc(taskRef, { completed: true });
  }
}

/** True when `current` is a valid timestamp strictly later than `at`. */
function isNewer(current: unknown, at: string): boolean {
  if (typeof current !== "string") return false;
  const c = Date.parse(current);
  const a = Date.parse(at);
  return !Number.isNaN(c) && !Number.isNaN(a) && c > a;
}
