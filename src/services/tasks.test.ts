/**
 * Service tests for follow-up tasks (#34). `firebase/firestore` is
 * mocked; the emulator round trip and the rules live in
 * `tests/tasks.integration.test.ts` and `tests/firestore-rules.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.ts", () => ({
  getOwnerUidOrThrow: () => "user-alice",
  ownerScope: () => [],
}));

vi.mock("../firebase.ts", () => ({ getDb: () => ({ name: "db" }) }));

const setDoc = vi.fn();
const batchUpdate = vi.fn();
const batchCommit = vi.fn();

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` }),
  getDocs: () => {
    throw new Error("getDocs not mocked in tasks.test.ts");
  },
  query: () => undefined,
  setDoc: (...args: unknown[]) => setDoc(...args),
  writeBatch: () => ({ update: batchUpdate, commit: batchCommit }),
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
  it("completes the task and stamps the Application in one batch", async () => {
    batchCommit.mockResolvedValue(undefined);
    await completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z");
    expect(batchUpdate).toHaveBeenCalledTimes(2);
    expect(batchUpdate).toHaveBeenCalledWith({ path: "tasks/t1" }, { completed: true });
    expect(batchUpdate).toHaveBeenCalledWith(
      { path: "applications/a1" },
      { last_activity_at: "2026-10-20T12:00:00.000Z" },
    );
    expect(batchCommit).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed commit", async () => {
    batchCommit.mockRejectedValue(new Error("permission-denied"));
    await expect(
      completeTask({ id: "t1", application_id: "a1" }, "2026-10-20T12:00:00.000Z"),
    ).rejects.toThrow("permission-denied");
  });
});
