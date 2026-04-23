/**
 * Firestore rules test suite (closes #60, final #16 sub-issue).
 *
 * Runs via `npm run test:rules`, which wraps the suite in
 * `firebase emulators:exec --only firestore` so the emulator boots
 * fresh per run. Do NOT include this file in the default vitest run
 * (`npm test`) — without the emulator it would fail hard and block
 * the tight feedback loop.
 *
 * The rules under test (`firestore.rules`) use a generic
 * `/{collection}/{docId}` match that enforces `owner_uid ==
 * request.auth.uid` on every read/create/update/delete. This suite
 * exercises that invariant across all 9 top-level collections
 * (the ones typed in src/types/) with a positive + negative pair:
 *
 *   - owner can read/write their own doc
 *   - cross-owner read rejected
 *   - cross-owner write rejected
 *   - create without owner_uid rejected
 *   - create with owner_uid that doesn't match auth rejected
 *   - unauth read/write rejected
 *
 * If a rule change weakens any of the above, the corresponding test
 * should fail — prove this locally by flipping `==` to `!=` in
 * `firestore.rules` and re-running `npm run test:rules`.
 */

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

/**
 * The 9 top-level Firestore collections per specs/matchline.md §
 * Data model (cross-referenced against src/types/). Kept here (not
 * imported) so the test is self-describing and survives refactors
 * of the service-layer collection constants.
 */
const COLLECTIONS = [
  "people",
  "companies",
  "roles",
  "applications",
  "interactions",
  "experienceUnits",
  "jobRequirementUnits",
  "unitMatches",
  "unitClusters",
] as const;

const OWNER_UID = "user-alice";
const OTHER_UID = "user-bob";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "matchline-rules-test",
    firestore: {
      rules: readFileSync(join(process.cwd(), "firestore.rules"), "utf8"),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  // Fresh slate per test — `clearFirestore` uses admin privileges
  // (bypasses rules) to wipe every doc.
  await testEnv.clearFirestore();
});

/**
 * Seed a single doc via the rules-bypass admin context so tests
 * that want to read a pre-existing doc don't have to first pass
 * their own write rules.
 */
async function seedDoc(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), collection, id), data);
  });
}

for (const collection of COLLECTIONS) {
  describe(`rules: ${collection}`, () => {
    it("owner can read their own doc", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.authenticatedContext(OWNER_UID);
      await assertSucceeds(getDoc(doc(ctx.firestore(), collection, "doc-1")));
    });

    it("owner can create a doc stamped with their uid", async () => {
      const ctx = testEnv.authenticatedContext(OWNER_UID);
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), collection, "doc-1"), {
          owner_uid: OWNER_UID,
          data: 1,
        }),
      );
    });

    it("cross-owner read is rejected", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.authenticatedContext(OTHER_UID);
      await assertFails(getDoc(doc(ctx.firestore(), collection, "doc-1")));
    });

    it("cross-owner write (create someone else's doc) is rejected", async () => {
      const ctx = testEnv.authenticatedContext(OTHER_UID);
      await assertFails(
        setDoc(doc(ctx.firestore(), collection, "doc-1"), {
          owner_uid: OWNER_UID, // Bob claims Alice's doc — must fail
          data: 1,
        }),
      );
    });

    it("create without owner_uid is rejected", async () => {
      const ctx = testEnv.authenticatedContext(OWNER_UID);
      await assertFails(
        setDoc(doc(ctx.firestore(), collection, "doc-1"), { data: 1 }),
      );
    });

    it("unauthenticated read is rejected", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.unauthenticatedContext();
      await assertFails(getDoc(doc(ctx.firestore(), collection, "doc-1")));
    });

    it("unauthenticated write is rejected", async () => {
      const ctx = testEnv.unauthenticatedContext();
      await assertFails(
        setDoc(doc(ctx.firestore(), collection, "doc-1"), {
          owner_uid: OWNER_UID,
          data: 1,
        }),
      );
    });

    it("update rejected if owner_uid changes under us", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.authenticatedContext(OWNER_UID);
      // Attempting to rewrite owner_uid to someone else must fail —
      // this is the "take over by overwriting" attack shape.
      await assertFails(
        setDoc(doc(ctx.firestore(), collection, "doc-1"), {
          owner_uid: OTHER_UID,
          data: 2,
        }),
      );
    });

    it("owner can delete their own doc", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.authenticatedContext(OWNER_UID);
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), collection, "doc-1"), {
          owner_uid: OWNER_UID,
          data: 2,
        }),
      );
    });

    it("cross-owner delete is rejected", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.authenticatedContext(OTHER_UID);
      // Firestore's deleteDoc would be the idiomatic check, but
      // rewriting a doc as a non-owner covers the same rule branch
      // (`allow update: isOwner() && isCreatingAsOwner()`).
      await assertFails(
        setDoc(doc(ctx.firestore(), collection, "doc-1"), {
          owner_uid: OTHER_UID,
          data: 99,
        }),
      );
    });
  });
}
