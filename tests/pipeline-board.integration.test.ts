/**
 * Pipeline board read path against the Firestore emulator (#510).
 *
 * The Pipeline container loads the board with `loadPipelineData` over
 * the production owner-scoped readers (`listApplications`, `listRoles`,
 * `listCompanies`, `listInteractions`, `listPeople`) and joins the
 * result with `buildPipelineBoard`. The unit tests drive both with
 * in-memory fakes; this test drives them through the real client SDK
 * and `firestore.rules`, so a reader whose query the rules reject, or
 * a join key that does not survive the converter round trip, fails
 * here rather than on the deployed board.
 *
 * `src/firebase.ts` is mocked so the service layer's `getDb()` returns
 * the rules-test context's Firestore (authenticated as the owner) and
 * `getAuthClient().currentUser` reports that owner. Everything below
 * the mock is production code.
 *
 * Runs via `npm run test:rules` (Firestore emulator). Not part of the
 * default `npm test` run.
 */

import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const OWNER_UID = "user-alice";
const OTHER_UID = "user-bob";

const firebaseMock = vi.hoisted(() => ({
  db: undefined as Firestore | undefined,
}));

vi.mock("../src/firebase.ts", () => ({
  getDb: () => {
    if (firebaseMock.db === undefined) {
      throw new Error("test Firestore not initialised");
    }
    return firebaseMock.db;
  },
  getAuthClient: () => ({ currentUser: { uid: OWNER_UID } }),
  getApp: () => {
    throw new Error("getApp is not used by the Pipeline readers");
  },
  getFunctionsClient: () => {
    throw new Error("getFunctionsClient is not used by the Pipeline readers");
  },
}));

// Imported after the mock is registered (vi.mock is hoisted).
import { buildPipelineBoard } from "../src/routes/Pipeline/buildPipelineBoard.ts";
import { loadPipelineData } from "../src/routes/Pipeline/loadPipelineData.ts";
import {
  listApplications,
  moveApplicationToStage,
} from "../src/services/applications.ts";
import {
  listCompanies,
  listInteractions,
  listPeople,
} from "../src/services/people.ts";
import { listRoles } from "../src/services/roles.ts";
import {
  completeTask,
  createTask,
  listTasks,
} from "../src/services/tasks.ts";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "matchline-pipeline-board-test",
    firestore: {
      rules: readFileSync(join(process.cwd(), "firestore.rules"), "utf8"),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

/** Seed a document with rules disabled. The id is the document id only. */
async function seed(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), collection, id), data);
  });
}

function application(
  ownerUid: string,
  roleId: string,
  stage: string,
  lastActivityAt: string,
): Record<string, unknown> {
  return {
    owner_uid: ownerUid,
    role_id: roleId,
    stage,
    last_activity_at: lastActivityAt,
    generated_assets: [],
    approved_unit_ids: [],
  };
}

beforeEach(async () => {
  await testEnv.clearFirestore();
  // firestore.rules admits only allowlisted owners (#439). Both users
  // are owners, so the assertions below exercise owner_uid scoping.
  await seed("config", "access", { owner_uids: [OWNER_UID, OTHER_UID] });
  firebaseMock.db = testEnv
    .authenticatedContext(OWNER_UID)
    .firestore() as unknown as Firestore;

  await seed("companies", "c-acme", {
    owner_uid: OWNER_UID,
    name: "Acme",
    priority: "high",
  });
  await seed("roles", "r-pm", {
    owner_uid: OWNER_UID,
    company_id: "c-acme",
    title: "Staff PM",
    jd_raw: "",
    discovered_at: "2026-10-01T00:00:00.000Z",
  });
  await seed("people", "p-dana", {
    owner_uid: OWNER_UID,
    name: "Dana Reyes",
    role: "Recruiter",
    company_id: "c-acme",
    relationship_type: "recruiter",
  });
  await seed(
    "applications",
    "a-applied",
    application(OWNER_UID, "r-pm", "applied", "2026-10-14T12:00:00.000Z"),
  );
  // Role deleted / never loaded: the card must still render.
  await seed(
    "applications",
    "a-orphan",
    application(OWNER_UID, "r-missing", "offer", "2026-10-19T00:00:00.000Z"),
  );
  await seed("interactions", "i-1", {
    owner_uid: OWNER_UID,
    person_id: "p-dana",
    application_id: "a-applied",
    type: "call",
    direction: "inbound",
    summary: "Recruiter screen",
    occurred_at: "2026-10-15T00:00:00.000Z",
  });
  // Another owner's Application must never reach this owner's board.
  await seed(
    "applications",
    "a-bob",
    application(OTHER_UID, "r-bob", "interviewing", "2026-10-18T00:00:00.000Z"),
  );
});

describe("Pipeline board read path (#510)", () => {
  it("loads the owner's data through the real readers and joins it into cards", async () => {
    const data = await loadPipelineData({
      listApplications: () => listApplications(),
      listRoles: () => listRoles(),
      listCompanies,
      listInteractions,
      listPeople,
      listTasks,
    });
    expect(data.partial).toBe(false);
    expect(data.applications.map((a) => a.id).sort()).toEqual([
      "a-applied",
      "a-orphan",
    ]);

    const board = buildPipelineBoard({
      ...data,
      now: new Date("2026-10-19T12:00:00.000Z"),
    });
    const counts = Object.fromEntries(
      board.map((c) => [c.stage, c.cards.length]),
    );
    expect(counts).toEqual({
      saved: 0,
      drafting: 0,
      applied: 1,
      interviewing: 0,
      offer: 1,
      rejected: 0,
      withdrawn: 0,
    });

    const applied = board.find((c) => c.stage === "applied")?.cards[0];
    expect(applied).toEqual({
      applicationId: "a-applied",
      roleId: "r-pm",
      companyName: "Acme",
      roleTitle: "Staff PM",
      daysInStage: 5,
      keyContact: { personId: "p-dana", name: "Dana Reyes" },
      nextAction: null,
    });

    const orphan = board.find((c) => c.stage === "offer")?.cards[0];
    expect(orphan).toMatchObject({
      applicationId: "a-orphan",
      roleId: "r-missing",
      companyName: null,
      roleTitle: null,
    });
  });
});

describe("Pipeline card move write path (#511)", () => {
  async function readRaw(id: string): Promise<Record<string, unknown> | undefined> {
    let raw: Record<string, unknown> | undefined;
    // withSecurityRulesDisabled resolves to void, so capture the read.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      raw = (await getDoc(doc(ctx.firestore(), "applications", id))).data();
    });
    return raw;
  }

  it("persists the new stage, resets last_activity_at, and changes nothing else", async () => {
    const before = await readRaw("a-applied");
    const at = "2026-10-20T02:00:00.000Z";

    await moveApplicationToStage("a-applied", "interviewing", at);

    const after = await readRaw("a-applied");
    expect(after).toEqual({ ...before, stage: "interviewing", last_activity_at: at });

    // "After a reload it is still there": a fresh board load sees it.
    const data = await loadPipelineData({
      listApplications: () => listApplications(),
      listRoles: () => listRoles(),
      listCompanies,
      listInteractions,
      listPeople,
      listTasks,
    });
    const board = buildPipelineBoard({ ...data, now: new Date(at) });
    const interviewing = board.find((c) => c.stage === "interviewing")?.cards;
    expect(interviewing?.map((c) => c.applicationId)).toEqual(["a-applied"]);
    expect(interviewing?.[0]?.daysInStage).toBe(0);
  });

  it("is rejected by the rules for another owner's Application", async () => {
    await expect(
      moveApplicationToStage("a-bob", "offer", "2026-10-20T02:00:00.000Z"),
    ).rejects.toThrow();
    expect((await readRaw("a-bob"))?.stage).toBe("interviewing");
  });
});

describe("Pipeline tasks write path (#34)", () => {
  async function readRaw(
    collection: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    let raw: Record<string, unknown> | undefined;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      raw = (await getDoc(doc(ctx.firestore(), collection, id))).data();
    });
    return raw;
  }

  it("creates a task through the service and lists it back, owner-scoped", async () => {
    const task = await createTask(
      { application_id: "a-applied", title: "Email Dana", due_at: "2026-10-23T12:00:00.000Z" },
      new Date("2026-10-20T12:00:00.000Z"),
    );
    expect(await listTasks()).toEqual([task]);
    expect(await readRaw("tasks", task.id)).toEqual({
      owner_uid: OWNER_UID,
      application_id: "a-applied",
      title: "Email Dana",
      due_at: "2026-10-23T12:00:00.000Z",
      completed: false,
      created_at: "2026-10-20T12:00:00.000Z",
    });
  });

  it("completes a task and stamps only the Application's last_activity_at", async () => {
    const task = await createTask({ application_id: "a-applied", title: "Email Dana" });
    const appBefore = await readRaw("applications", "a-applied");
    const at = "2026-10-20T15:00:00.000Z";

    await completeTask(task, at);

    expect((await readRaw("tasks", task.id))?.completed).toBe(true);
    expect(await readRaw("applications", "a-applied")).toEqual({
      ...appBefore,
      last_activity_at: at,
    });
  });

  it("never moves last_activity_at backwards (#588)", async () => {
    const task = await createTask({ application_id: "a-applied", title: "Email Dana" });
    // Newer activity recorded elsewhere after this completion's time.
    await moveApplicationToStage("a-applied", "interviewing", "2026-10-21T09:00:00.000Z");

    await completeTask(task, "2026-10-20T12:00:00.000Z");

    expect((await readRaw("tasks", task.id))?.completed).toBe(true);
    expect((await readRaw("applications", "a-applied"))?.last_activity_at).toBe(
      "2026-10-21T09:00:00.000Z",
    );
  });

  it("still completes a task whose Application was deleted", async () => {
    const task = await createTask({ application_id: "a-applied", title: "Email Dana" });
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), "applications", "a-applied"));
    });

    await completeTask(task, "2026-10-20T12:00:00.000Z");

    expect((await readRaw("tasks", task.id))?.completed).toBe(true);
    expect(await readRaw("applications", "a-applied")).toBeUndefined();
  });

  it("refuses a task on another owner's Application", async () => {
    await expect(
      createTask({ application_id: "a-bob", title: "Not mine" }),
    ).rejects.toThrow();
    expect(await listTasks()).toEqual([]);
  });
});

