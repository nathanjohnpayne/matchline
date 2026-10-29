/**
 * Cloud Storage rules test suite (#521).
 *
 * Runs via `npm run test:rules`, which wraps the suite in
 * `firebase emulators:exec --only firestore,storage`. Excluded from
 * `npm test`: without the Storage emulator it would fail hard.
 *
 * What `storage.rules` enforce: résumé exports live at
 * `applications/{applicationId}/{assetId}.{ext}`, written only by the
 * `exportAsset` callable through the admin SDK (which bypasses rules)
 * and read only through the short-lived signed URL it returns. So for
 * EVERY client — the owner, another signed-in user and an
 * unauthenticated caller — every read (download URL, metadata, list)
 * and every write (create, overwrite, metadata update, delete) is
 * denied. Everything outside `applications/` is denied too (default
 * deny).
 *
 * Each denial is a rules decision, not a missing object: the object is
 * seeded with rules disabled first, and a sanity case reads it back
 * under the same bypass.
 *
 * Prove the suite bites by changing `if false` to `if true` on the
 * `applications/` match in `storage.rules` and re-running.
 */

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const PROJECT_ID = "matchline-storage-rules-test";
const OWNER_UID = "user-alice";
const OTHER_UID = "user-bob";
const APP_ID = "app-1";
const EXPORT_PATH = `applications/${APP_ID}/asset-1.txt`;
const TEXT = new TextEncoder().encode("SUMMARY\nProduct leader — platforms.\n");
const METADATA = { contentType: "text/plain; charset=utf-8" };

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error(
      "storage-rules.test.ts must run under `firebase emulators:exec --only firestore,storage` " +
        "(FIREBASE_STORAGE_EMULATOR_HOST not set). Use `npm run test:rules`.",
    );
  }
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: { rules: readFileSync(join(process.cwd(), "storage.rules"), "utf8") },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

/** An object outside `applications/`, so default deny is tested against a real object. */
const OTHER_PATH = "other/x.txt";

beforeEach(async () => {
  // Seed the export the callable would have written, and an object outside
  // applications/, bypassing rules.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.storage().ref(EXPORT_PATH).put(TEXT, METADATA);
    await ctx.storage().ref(OTHER_PATH).put(TEXT, METADATA);
  });
});

const CALLERS: ReadonlyArray<readonly [string, () => RulesTestContext]> = [
  ["the owner", () => testEnv.authenticatedContext(OWNER_UID)],
  ["another user", () => testEnv.authenticatedContext(OTHER_UID)],
  ["an unauthenticated caller", () => testEnv.unauthenticatedContext()],
];

describe("storage rules: seeded export exists", () => {
  it("is readable with rules disabled, so the denials below are rules decisions", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await assertSucceeds(ctx.storage().ref(EXPORT_PATH).getMetadata());
      await assertSucceeds(ctx.storage().ref(OTHER_PATH).getMetadata());
    });
  });
});

describe.each(CALLERS)("storage rules: applications/ is closed to %s", (_label, context) => {
  const ref = (path: string = EXPORT_PATH) => context().storage().ref(path);

  it("cannot get a download URL", async () => {
    await assertFails(ref().getDownloadURL());
  });

  it("cannot read metadata", async () => {
    await assertFails(ref().getMetadata());
  });

  it("cannot list an Application's exports", async () => {
    await assertFails(context().storage().ref(`applications/${APP_ID}`).listAll());
  });

  it("cannot create a new export object", async () => {
    await assertFails(Promise.resolve(ref(`applications/${APP_ID}/asset-2.txt`).put(TEXT, METADATA)));
  });

  it("cannot overwrite the existing export", async () => {
    await assertFails(Promise.resolve(ref().put(new TextEncoder().encode("forged"), METADATA)));
  });

  it("cannot update the export's metadata", async () => {
    await assertFails(ref().updateMetadata({ contentDisposition: "inline" }));
  });

  it("cannot delete the export", async () => {
    await assertFails(ref().delete());
  });
});

describe("storage rules: default deny outside applications/", () => {
  it("rejects the owner writing anywhere else", async () => {
    const storage = testEnv.authenticatedContext(OWNER_UID).storage();
    await assertFails(Promise.resolve(storage.ref("other/x.txt").put(TEXT, METADATA)));
    await assertFails(Promise.resolve(storage.ref("x.txt").put(TEXT, METADATA)));
  });

  describe.each([
    ["the owner", () => testEnv.authenticatedContext(OWNER_UID)],
    ["an unauthenticated caller", () => testEnv.unauthenticatedContext()],
  ] as const)("for %s", (_label, context) => {
    it("cannot read an object elsewhere: no download URL, no metadata", async () => {
      const ref = context().storage().ref(OTHER_PATH);
      await assertFails(ref.getDownloadURL());
      await assertFails(ref.getMetadata());
    });

    it("cannot list another path or the bucket root", async () => {
      await assertFails(context().storage().ref("other").listAll());
      await assertFails(context().storage().ref().listAll());
    });
  });
});
