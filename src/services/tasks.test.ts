/**
 * Service tests for follow-up tasks (#34). `firebase/firestore` is
 * mocked; the emulator round trip and the rules live in
 * `tests/tasks.integration.test.ts` and `tests/firestore-rules.test.ts`.
 */

import { FirebaseError } from "firebase/app";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.ts", () => ({
  getOwnerUidOrThrow: () => "user-alice",
  ownerScope: () => [],
}));

vi.mock("../firebase.ts", () => ({ getDb: () => ({ name: "db" }) }));

const setDoc = vi.fn();
const updateDoc = vi.fn();
const txGet = vi.fn();
const txUpdate = vi.fn();
const runTransaction = vi.fn(
  async (_db: unknown, fn: (tx: unknown) => Promise<void>) =>
    fn({ get: txGet, update: txUpdate }),
);

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` }),
  getDocs: () => {
    throw new Error("getDocs not mocked in tasks.test.ts");
  },
  query: () => undefined,
  setDoc: (...args: unknown[]) => setDoc(...args),
  updateDoc: (...args: unknown[]) => updateDoc(...args),
  runTransaction: (db: unknown, fn: (tx: unknown) => Promise<void>) =>
    runTransaction(db, fn),
}));

vi.mock("./firestore.ts", () => ({
  typedCollection: () => undefined,
  typedDoc: (col: string, id: string) => ({ path: `${col}/${id}` }),
}));

const { buildTask, completeTask, createTask } = await import("./tasks.ts");

const NOW = new Date("2026-10-20T12:00:00.000Z");

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildTask", () => {
  it("builds an open task with a trimmed title and the due date", () => {
    expect(
      buildTask(
        { application_id: "a1", title: "  Email Dana ", due_at: "2026-10-23T12:00:00.000Z" },
        { id: "t1", ownerUid: "u1" },
        NOW,
      ),
    ).toEqual({
      id: "t1",
      owner_uid: "u1",
      application_id: "a1",
      title: "Email Dana",
      completed: false,
      created_at: "2026-10-20T12:00:00.000Z",
      due_at: "2026-10-23T12:00:00.000Z",
    });
  });

  it("omits due_at for an undated task (never writes undefined)", () => {
    const task = buildTask(
      { application_id: "a1", title: "Prep" },
      { id: "t1", ownerUid: "u1" },
      NOW,
    );
    expect("due_at" in task).toBe(false);
  });

  it("accepts a 200-character title and rejects 201", () => {
    const ids = { id: "t1", ownerUid: "u1" };
    expect(buildTask({ application_id: "a1", title: "x".repeat(200) }, ids, NOW).title).toHaveLength(200);
    expect(() =>
      buildTask({ application_id: "a1", title: "x".repeat(201) }, ids, NOW),
    ).toThrow("at most 200 characters");
  });

  it("rejects an empty or whitespace-only title", () => {
    expect(() =>
      buildTask({ application_id: "a1", title: "   " }, { id: "t1", ownerUid: "u1" }, NOW),
    ).toThrow("A task needs a title.");
  });
});

describe("createTask", () => {
  it("writes the built task, owner-stamped, at tasks/<id>", async () => {
    setDoc.mockResolvedValue(undefined);
    const task = await createTask({ application_id: "a1", title: "Follow up" }, NOW);
    expect(task.owner_uid).toBe("user-alice");
    expect(setDoc).toHaveBeenCalledTimes(1);
    expect(setDoc.mock.calls[0]?.[0]).toEqual({ path: `tasks/${task.id}` });
    expect(setDoc.mock.calls[0]?.[1]).toEqual(task);
  });
});

describe("completeTask", () => {
  const appSnap = (lastActivityAt?: string) => ({
    exists: () => lastActivityAt !== undefined,
    data: () => ({ last_activity_at: lastActivityAt }),
  });

  it("completes the task and stamps the Application in one transaction", async () => {
    txGet.mockResolvedValue(appSnap("2026-10-19T00:00:00.000Z"));
    await completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z");
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(txGet).toHaveBeenCalledWith({ path: "applications/a1" });
    expect(txUpdate).toHaveBeenCalledWith({ path: "tasks/t1" }, { completed: true });
    expect(txUpdate).toHaveBeenCalledWith(
      { path: "applications/a1" },
      { last_activity_at: "2026-10-20T12:00:00.000Z" },
    );
  });

  it("keeps a newer last_activity_at instead of moving it backwards (#588)", async () => {
    txGet.mockResolvedValue(appSnap("2026-10-21T09:00:00.000Z"));
    await completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z");
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledWith({ path: "tasks/t1" }, { completed: true });
  });

  it("stamps when the stored timestamp is missing or unparseable", async () => {
    txGet.mockResolvedValue(appSnap("not a date"));
    await completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z");
    expect(txUpdate).toHaveBeenCalledWith(
      { path: "applications/a1" },
      { last_activity_at: "2026-10-20T12:00:00.000Z" },
    );
  });

  it("completes the task without stamping when the Application is gone", async () => {
    txGet.mockResolvedValue(appSnap(undefined));
    await completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z");
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledWith({ path: "tasks/t1" }, { completed: true });
  });

  it("completes the task alone when the transaction is denied (Application deleted)", async () => {
    runTransaction.mockRejectedValueOnce(
      new FirebaseError("permission-denied", "Missing or insufficient permissions."),
    );
    updateDoc.mockResolvedValueOnce(undefined);
    await completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z");
    expect(updateDoc).toHaveBeenCalledWith({ path: "tasks/t1" }, { completed: true });
  });

  it("propagates when the fallback is denied too", async () => {
    runTransaction.mockRejectedValueOnce(new FirebaseError("permission-denied", "no"));
    updateDoc.mockRejectedValueOnce(new FirebaseError("permission-denied", "still no"));
    await expect(
      completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z"),
    ).rejects.toThrow("still no");
  });

  it("propagates any other transaction failure without falling back", async () => {
    runTransaction.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z"),
    ).rejects.toThrow("unavailable");
    expect(updateDoc).not.toHaveBeenCalled();
  });
});
