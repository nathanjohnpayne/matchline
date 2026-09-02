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
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
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

    it("owner can update their own doc", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.authenticatedContext(OWNER_UID);
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), collection, "doc-1"), {
          owner_uid: OWNER_UID,
          data: 2,
        }),
      );
    });

    it("owner can delete their own doc", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.authenticatedContext(OWNER_UID);
      // Exercises `allow delete: if isOwner();` directly — the
      // setDoc-as-delete shortcut in an earlier draft only
      // exercised the update rule branch (#60 CodeRabbit review).
      await assertSucceeds(
        deleteDoc(doc(ctx.firestore(), collection, "doc-1")),
      );
    });

    it("cross-owner delete is rejected", async () => {
      await seedDoc(collection, "doc-1", { owner_uid: OWNER_UID, data: 1 });
      const ctx = testEnv.authenticatedContext(OTHER_UID);
      await assertFails(
        deleteDoc(doc(ctx.firestore(), collection, "doc-1")),
      );
    });

    it("delete of nonexistent doc is rejected (regression: #92 null-guard)", async () => {
      // The null-guard in `isOwner()` makes `resource == null`
      // evaluate to false rather than throwing a Null value
      // error mid-evaluation. The observable result is the
      // same — the delete is rejected — but the failure path
      // is now explicit denial rather than a runtime evaluation
      // error masked as PERMISSION_DENIED. Without the guard,
      // some emulator runs surfaced this as a failed
      // assertSucceeds on existing-doc deletes (cross-project
      // contention scenario). Pin the explicit-denial behavior
      // for the missing-doc case so a future rule weakening
      // can't quietly allow it.
      const ctx = testEnv.authenticatedContext(OWNER_UID);
      await assertFails(
        deleteDoc(doc(ctx.firestore(), collection, "does-not-exist")),
      );
    });
  });
}

// -- unitMatches contradictory-shape guard (cursor #133 r4) --------------

describe("rules: unitMatches contradictory-flag guard", () => {
  // The unified `setMatchApprovalState` setter (cursor #133
  // r1) and the matching pipeline's carry-forward
  // canonicalization (cursor #133 r3) prevent the
  // `(approved_for_use: true, user_rejected: true)` shape
  // through the V1 write paths. Rules are the SECURITY
  // boundary that catches everything else (admin SDK
  // bypass-by-mistake, future code, generic upserts).
  // Generation gates on `approved_for_use === true` and
  // ignores `user_rejected` — a contradictory persisted
  // pair would be silently consumed, violating the user's
  // rejection intent.
  //
  // The other 3 valid flag pairs (false/false, true/false,
  // false/true) must still be writable.

  it("REJECTS create with (approved_for_use: true, user_rejected: true)", async () => {
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      setDoc(doc(ctx.firestore(), "unitMatches", "match-1"), {
        owner_uid: OWNER_UID,
        approved_for_use: true,
        user_rejected: true,
      }),
    );
  });

  it("REJECTS update that produces (approved_for_use: true, user_rejected: true)", async () => {
    // Seed a clean match, then try to update both flags to
    // true atomically. Must fail.
    await seedDoc("unitMatches", "match-1", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      setDoc(
        doc(ctx.firestore(), "unitMatches", "match-1"),
        {
          owner_uid: OWNER_UID,
          approved_for_use: true,
          user_rejected: true,
        },
        { merge: true },
      ),
    );
  });

  it("REJECTS a client write carrying schema_version (#444)", async () => {
    // `schema_version` is the matching pipeline's attestation
    // that it produced the row under the axis-gated rationale
    // rule — which is what lets MatchCard present the prose to
    // the user as a claim. A provenance marker a client can
    // write attests nothing: an owner could pair
    // `schema_version: 1` with arbitrary prose and have it
    // rendered as grounded. The admin SDK bypasses rules, so the
    // pipeline is unaffected. CodeRabbit on PR #450.
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      setDoc(doc(ctx.firestore(), "unitMatches", "match-forged"), {
        owner_uid: OWNER_UID,
        approved_for_use: false,
        user_rejected: false,
        schema_version: 1,
        rationale: "Matched on product strategy.",
      }),
    );
  });

  it("REJECTS adding schema_version to an existing match", async () => {
    await seedDoc("unitMatches", "match-1", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      setDoc(
        doc(ctx.firestore(), "unitMatches", "match-1"),
        { schema_version: 1 },
        { merge: true },
      ),
    );
  });

  it("ALLOWS an ordinary client match write with no schema_version", async () => {
    // The control: the guard must reject the forged field, not
    // client writes in general — `setMatchApprovalState` is the
    // approve/reject path and must keep working.
    await seedDoc("unitMatches", "match-ok", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertSucceeds(
      setDoc(
        doc(ctx.firestore(), "unitMatches", "match-ok"),
        { approved_for_use: true, user_rejected: false },
        { merge: true },
      ),
    );
  });

  it("ALLOWS create with each valid flag pair (false/false, true/false, false/true)", async () => {
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    const validPairs: ReadonlyArray<{
      id: string;
      approved_for_use: boolean;
      user_rejected: boolean;
    }> = [
      { id: "m-none", approved_for_use: false, user_rejected: false },
      { id: "m-approved", approved_for_use: true, user_rejected: false },
      { id: "m-rejected", approved_for_use: false, user_rejected: true },
    ];
    for (const p of validPairs) {
      await assertSucceeds(
        setDoc(doc(ctx.firestore(), "unitMatches", p.id), {
          owner_uid: OWNER_UID,
          approved_for_use: p.approved_for_use,
          user_rejected: p.user_rejected,
        }),
      );
    }
  });

  it("REGRESSION: the rule does NOT reject other collections' writes that happen to have both fields true", async () => {
    // Defensive pin: the guard's `collection != 'unitMatches'`
    // short-circuit means any other collection's writes are
    // unaffected. A doc in `experienceUnits` (or any
    // non-unitMatches collection) with the same field
    // names happening to both be true should still be
    // allowed — rules can't false-positive on field-name
    // collision across collections.
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertSucceeds(
      setDoc(doc(ctx.firestore(), "experienceUnits", "u-mh"), {
        owner_uid: OWNER_UID,
        // These field names happen to overlap but this is a
        // different collection — must be allowed.
        approved_for_use: true,
        user_rejected: true,
      }),
    );
  });
});
