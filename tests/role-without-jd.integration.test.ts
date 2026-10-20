/**
 * Title-only Role write path against the Firestore emulator (#431).
 *
 * `/roles/new` submits through `submitRoleNewForm(form, { upsertRole,
 * … })`. The unit tests pin the payload shape; this test drives that
 * same call through the real client SDK and `firestore.rules`, so a
 * wiring or rules regression that stops a JD-less Role from being
 * created fails here rather than in the browser. It then covers the
 * "paste the JD later" half: Role Detail saves a JD onto the existing
 * Role through `upsertRole` (a merge write), and that must succeed and
 * leave the rest of the Role intact.
 *
 * `src/firebase.ts` is mocked so the service layer's `getDb()` returns
 * the rules-test context's Firestore (authenticated as the owner) and
 * `getAuthClient().currentUser` reports that owner. Everything below
 * the mock — the converter, `upsertRole`'s owner stamping and merge
 * write, `getRole`'s read — is the production code.
 *
 * Runs via `npm run test:rules` (Firestore emulator). Not part of the
 * default `npm test` run.
 */

import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
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
    throw new Error("getApp is not used by the Role service");
  },
  getFunctionsClient: () => {
    throw new Error("getFunctionsClient is not used by the Role service");
  },
}));

// Imported after the mock is registered (vi.mock is hoisted).
import {
  EMPTY_ROLE_NEW_FORM,
  buildRoleFromForm,
  submitRoleNewForm,
} from "../src/routes/roleNewForm.ts";
import { getRole, upsertRole } from "../src/services/roles.ts";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "matchline-role-without-jd-test",
    firestore: {
      rules: readFileSync(join(process.cwd(), "firestore.rules"), "utf8"),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // firestore.rules admits only allowlisted owners (#439).
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "config", "access"), {
      owner_uids: [OWNER_UID],
    });
  });
  // rules-unit-testing types its handle as the compat Firestore; at
  // runtime it is the modular instance the service layer expects.
  firebaseMock.db = testEnv
    .authenticatedContext(OWNER_UID)
    .firestore() as unknown as Firestore;
});

describe("Role without a JD (#431)", () => {
  it("creates a title-only Role through the form's submit step and reads it back", async () => {
    // The same call RoleNew's onSubmit makes, with the real upsertRole.
    const ids = ["role-lead", "company-placeholder"];
    const id = await submitRoleNewForm(
      { ...EMPTY_ROLE_NEW_FORM, title: "Staff Product Manager" },
      {
        upsertRole,
        newId: () => ids.shift() ?? "unexpected-id",
        now: () => new Date("2026-10-19T12:00:00.000Z"),
      },
    );
    expect(id).toBe("role-lead");

    const stored = await getRole("role-lead");
    expect(stored).toEqual({
      id: "role-lead",
      owner_uid: OWNER_UID,
      company_id: "company-placeholder",
      title: "Staff Product Manager",
      jd_raw: "",
      discovered_at: "2026-10-19T12:00:00.000Z",
    });

    // Absent optional fields are omitted, never written as undefined
    // or null (Firestore rejects undefined; see roleNewForm.ts).
    let raw: Record<string, unknown> | undefined;
    // withSecurityRulesDisabled resolves to void, so capture the read.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      raw = (await getDoc(doc(ctx.firestore(), "roles", "role-lead"))).data();
    });
    expect(raw).toBeDefined();
    for (const key of ["jd_url", "location", "remote_policy", "comp_range"]) {
      expect(raw).not.toHaveProperty(key);
    }
  });

  it("saves a JD onto the existing JD-less Role without losing its fields", async () => {
    const role = buildRoleFromForm(
      {
        ...EMPTY_ROLE_NEW_FORM,
        title: "Staff Product Manager",
        jdUrl: "https://jobs.example.test/123",
      },
      { id: "role-lead", companyId: "company-placeholder" },
      new Date("2026-10-19T12:00:00.000Z"),
    );
    await upsertRole(role);

    // Role Detail's Save JD / Parse JD path: the loaded Role with
    // jd_raw replaced, written back through upsertRole.
    const loaded = await getRole("role-lead");
    expect(loaded).toBeDefined();
    const { owner_uid: _owner, ...rest } = loaded!;
    await upsertRole({ ...rest, jd_raw: "We are hiring a Staff PM." });

    const stored = await getRole("role-lead");
    expect(stored?.jd_raw).toBe("We are hiring a Staff PM.");
    expect(stored?.title).toBe("Staff Product Manager");
    expect(stored?.jd_url).toBe("https://jobs.example.test/123");
    expect(stored?.owner_uid).toBe(OWNER_UID);
  });
});
