/**
 * Firestore rules test suite (closes #60, final #16 sub-issue;
 * reworked for the owner allowlist and explicit per-collection
 * matches in #439).
 *
 * Runs via `npm run test:rules`, which wraps the suite in
 * `firebase emulators:exec --only firestore` so the emulator boots
 * fresh per run. Do NOT include this file in the default vitest run
 * (`npm test`) — without the emulator it would fail hard and block
 * the tight feedback loop.
 *
 * What the rules enforce, and where it is pinned:
 *
 *   - **Owner allowlist.** Every read and write requires auth.uid to
 *     be listed in the single fixed document `config/access`
 *     (`owner_uids`). A signed-in stranger — any account Firebase
 *     Auth admits — gets nothing, cannot read or write `config/`, and
 *     cannot make a pre-seeded document survive the deploy script's
 *     overwrite. ("rules: owner allowlist")
 *   - **Explicit collections, default deny.** There is no catch-all
 *     match; a collection not named in `firestore.rules` rejects
 *     every client operation. ("rules: default deny")
 *   - **owner_uid scoping** on every collection, via the per-
 *     collection matrix below: owner read/write, cross-owner
 *     rejection, owner_uid takeover rejection, unauth rejection.
 *     Both OWNER_UID and OTHER_UID are allowlisted there, so the
 *     cross-owner cases exercise owner_uid scoping rather than
 *     passing vacuously on the allowlist.
 *   - **Server-only writes** (`jobRequirementUnits` creates/deletes,
 *     `unitMatches` creates/deletes, all of `llm_calls`) reject client
 *     writes; the admin SDK bypasses rules. Owners may edit a parsed
 *     Requirement's content fields only.
 *   - **Field-level limits** on `experienceUnits` (no client
 *     `embedding`), `applications` (shell-only create, fixed field
 *     set on update, no added assets) and `unitMatches` (review
 *     decision only).
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
import {
  collection as collectionRef,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { writeOwnerAllowlist } from "../functions/scripts/set-owner-allowlist.ts";
import {
  getAdminDb,
  initializeAdminAppForTests,
} from "../functions/src/firestore/admin.ts";
import { makeConverter } from "../src/services/firestore.ts";

const OWNER_UID = "user-alice";
const OTHER_UID = "user-bob";
/** Signed in, but NOT on the owner allowlist. */
const STRANGER_UID = "user-mallory";

/**
 * Per-collection client capabilities, mirroring `firestore.rules`.
 * Kept here (not imported) so the test is self-describing and
 * survives refactors of the service-layer collection constants.
 *
 * `create` / `update` carry a payload that is valid for that
 * collection's field-level rules, so the matrix tests owner_uid
 * scoping rather than tripping a field limit. `null` means the
 * client may not perform that operation at all.
 */
interface CollectionSpec {
  readonly name: string;
  /** Extra fields a seeded doc needs for `update` to be meaningful. */
  readonly seed: Record<string, unknown>;
  readonly create: Record<string, unknown> | null;
  readonly update: Record<string, unknown> | null;
  readonly clientDelete: boolean;
}

const OWNER_CRUD = (name: string): CollectionSpec => ({
  name,
  seed: { data: 1 },
  create: { data: 1 },
  update: { data: 2 },
  clientDelete: true,
});

const COLLECTIONS: readonly CollectionSpec[] = [
  OWNER_CRUD("people"),
  OWNER_CRUD("companies"),
  OWNER_CRUD("roles"),
  OWNER_CRUD("interactions"),
  OWNER_CRUD("unitClusters"),
  {
    name: "experienceUnits",
    seed: { normalized_summary: "Led a team.", user_approved: false },
    create: {
      normalized_summary: "Led a team.",
      user_approved: false,
      reembed_pending: true,
    },
    update: {
      normalized_summary: "Led a team of five.",
      reembed_pending: true,
      updated_at: "2026-01-02T00:00:00.000Z",
    },
    clientDelete: true,
  },
  {
    name: "applications",
    seed: { role_id: "role-1", stage: "drafting", generated_assets: [] },
    create: {
      role_id: "role-1",
      stage: "drafting",
      last_activity_at: "2026-01-01T00:00:00.000Z",
      generated_assets: [],
      approved_unit_ids: [],
    },
    update: { stage: "applied", applied_at: "2026-01-02T00:00:00.000Z" },
    clientDelete: true,
  },
  {
    name: "unitMatches",
    seed: { approved_for_use: false, user_rejected: false },
    create: null,
    update: { approved_for_use: true, user_rejected: false },
    clientDelete: false,
  },
  {
    name: "jobRequirementUnits",
    seed: { role_id: "role-1", normalized_requirement: "SQL" },
    create: null,
    update: { normalized_requirement: "Advanced SQL", must_have: true },
    clientDelete: false,
  },
];

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
  // (bypasses rules) to wipe every doc, including the allowlist, so
  // it is re-seeded here. STRANGER_UID is deliberately absent.
  await testEnv.clearFirestore();
  await seedAllowlist([OWNER_UID, OTHER_UID]);
});

/** Write the owner allowlist the way the rules read it. */
async function seedAllowlist(uids: readonly string[]): Promise<void> {
  await seedDoc("config", "access", { owner_uids: [...uids] });
}

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

function db(uid: string | null) {
  return uid === null
    ? testEnv.unauthenticatedContext().firestore()
    : testEnv.authenticatedContext(uid).firestore();
}

for (const spec of COLLECTIONS) {
  const collection = spec.name;
  const seeded = (ownerUid: string) => ({ owner_uid: ownerUid, ...spec.seed });

  describe(`rules: ${collection}`, () => {
    it("owner can read their own doc", async () => {
      await seedDoc(collection, "doc-1", seeded(OWNER_UID));
      await assertSucceeds(getDoc(doc(db(OWNER_UID), collection, "doc-1")));
    });

    it("owner can run an owner-scoped list query", async () => {
      await seedDoc(collection, "doc-1", seeded(OWNER_UID));
      await assertSucceeds(
        getDocs(
          query(
            collectionRef(db(OWNER_UID), collection),
            where("owner_uid", "==", OWNER_UID),
          ),
        ),
      );
    });

    it("an unscoped list query is rejected", async () => {
      await seedDoc(collection, "doc-1", seeded(OWNER_UID));
      await assertFails(getDocs(collectionRef(db(OWNER_UID), collection)));
    });

    it("cross-owner read is rejected", async () => {
      await seedDoc(collection, "doc-1", seeded(OWNER_UID));
      await assertFails(getDoc(doc(db(OTHER_UID), collection, "doc-1")));
    });

    it("unauthenticated read is rejected", async () => {
      await seedDoc(collection, "doc-1", seeded(OWNER_UID));
      await assertFails(getDoc(doc(db(null), collection, "doc-1")));
    });

    it("a signed-in stranger cannot read a doc stamped with their own uid", async () => {
      await seedDoc(collection, "doc-1", seeded(STRANGER_UID));
      await assertFails(getDoc(doc(db(STRANGER_UID), collection, "doc-1")));
    });

    if (spec.create !== null) {
      const create = spec.create;

      it("owner can create a doc stamped with their uid", async () => {
        await assertSucceeds(
          setDoc(doc(db(OWNER_UID), collection, "doc-1"), {
            owner_uid: OWNER_UID,
            ...create,
          }),
        );
      });

      it("cross-owner write (create someone else's doc) is rejected", async () => {
        await assertFails(
          setDoc(doc(db(OTHER_UID), collection, "doc-1"), {
            owner_uid: OWNER_UID, // Bob claims Alice's doc — must fail
            ...create,
          }),
        );
      });

      it("create without owner_uid is rejected", async () => {
        await assertFails(setDoc(doc(db(OWNER_UID), collection, "doc-1"), create));
      });

      it("unauthenticated write is rejected", async () => {
        await assertFails(
          setDoc(doc(db(null), collection, "doc-1"), {
            owner_uid: OWNER_UID,
            ...create,
          }),
        );
      });

      it("a signed-in stranger cannot create even a self-stamped doc", async () => {
        await assertFails(
          setDoc(doc(db(STRANGER_UID), collection, "doc-1"), {
            owner_uid: STRANGER_UID,
            ...create,
          }),
        );
      });
    } else {
      it("client create is rejected even for the owner (server-only)", async () => {
        await assertFails(
          setDoc(doc(db(OWNER_UID), collection, "doc-1"), {
            owner_uid: OWNER_UID,
            ...spec.seed,
          }),
        );
      });
    }

    if (spec.update !== null) {
      const update = spec.update;

      it("owner can update their own doc", async () => {
        await seedDoc(collection, "doc-1", seeded(OWNER_UID));
        await assertSucceeds(
          updateDoc(doc(db(OWNER_UID), collection, "doc-1"), update),
        );
      });

      it("update rejected if owner_uid changes under us", async () => {
        await seedDoc(collection, "doc-1", seeded(OWNER_UID));
        // Attempting to rewrite owner_uid to someone else must fail —
        // this is the "take over by overwriting" attack shape.
        await assertFails(
          updateDoc(doc(db(OWNER_UID), collection, "doc-1"), {
            ...update,
            owner_uid: OTHER_UID,
          }),
        );
      });

      it("cross-owner update is rejected", async () => {
        await seedDoc(collection, "doc-1", seeded(OWNER_UID));
        await assertFails(
          updateDoc(doc(db(OTHER_UID), collection, "doc-1"), update),
        );
      });
    } else {
      it("client update is rejected even for the owner (server-only)", async () => {
        await seedDoc(collection, "doc-1", seeded(OWNER_UID));
        await assertFails(
          updateDoc(doc(db(OWNER_UID), collection, "doc-1"), { edited: true }),
        );
      });
    }

    if (spec.clientDelete) {
      it("owner can delete their own doc", async () => {
        await seedDoc(collection, "doc-1", seeded(OWNER_UID));
        // Exercises the delete rule directly — the setDoc-as-delete
        // shortcut in an earlier draft only exercised the update
        // branch (#60 CodeRabbit review).
        await assertSucceeds(deleteDoc(doc(db(OWNER_UID), collection, "doc-1")));
      });

      it("cross-owner delete is rejected", async () => {
        await seedDoc(collection, "doc-1", seeded(OWNER_UID));
        await assertFails(deleteDoc(doc(db(OTHER_UID), collection, "doc-1")));
      });

      it("delete of nonexistent doc is rejected (regression: #92 null-guard)", async () => {
        // The null-guard in `isOwner()` makes `resource == null`
        // evaluate to false rather than throwing a Null value
        // error mid-evaluation. Pin the explicit-denial behavior
        // for the missing-doc case so a future rule weakening
        // can't quietly allow it.
        await assertFails(
          deleteDoc(doc(db(OWNER_UID), collection, "does-not-exist")),
        );
      });
    } else {
      it("client delete is rejected even for the owner (server-only)", async () => {
        await seedDoc(collection, "doc-1", seeded(OWNER_UID));
        await assertFails(deleteDoc(doc(db(OWNER_UID), collection, "doc-1")));
      });
    }
  });
}

// -- Owner allowlist (#439) -----------------------------------------------

describe("rules: owner allowlist", () => {
  it("no client can read the allowlist, owner included", async () => {
    await assertFails(getDoc(doc(db(OWNER_UID), "config", "access")));
    await assertFails(getDoc(doc(db(STRANGER_UID), "config", "access")));
    await assertFails(getDocs(collectionRef(db(OWNER_UID), "config")));
  });

  it("a signed-in stranger cannot write the allowlist or add another config doc", async () => {
    // The sharpest form of the attack: if this passed, every other
    // allowlist check would be decorative.
    await assertFails(
      setDoc(doc(db(STRANGER_UID), "config", "access"), { owner_uids: [STRANGER_UID] }),
    );
    await assertFails(
      setDoc(doc(db(STRANGER_UID), "config", "other"), { owner_uid: STRANGER_UID }),
    );
  });

  it("an allowlisted owner cannot edit or delete the allowlist either", async () => {
    await assertFails(
      setDoc(doc(db(OWNER_UID), "config", "access"), {
        owner_uids: [OWNER_UID, STRANGER_UID],
      }),
    );
    await assertFails(deleteDoc(doc(db(OWNER_UID), "config", "access")));
  });

  it("a legacy per-uid owners/ doc grants nothing", async () => {
    // The first version of this allowlist trusted the mere existence of
    // `owners/{uid}` — a path the previous catch-all rule let any
    // signed-in user create. It must confer no access now.
    await seedDoc("owners", STRANGER_UID, { owner_uid: STRANGER_UID });
    await seedDoc("roles", "role-s", { owner_uid: STRANGER_UID, data: 1 });
    await assertFails(getDoc(doc(db(STRANGER_UID), "roles", "role-s")));
  });

  it("removing a uid from owner_uids revokes access to their own data", async () => {
    await seedDoc("roles", "role-1", { owner_uid: OWNER_UID, data: 1 });
    await assertSucceeds(getDoc(doc(db(OWNER_UID), "roles", "role-1")));
    await seedAllowlist([OTHER_UID]);
    await assertFails(getDoc(doc(db(OWNER_UID), "roles", "role-1")));
  });

  it("a missing allowlist document admits nobody", async () => {
    await seedDoc("roles", "role-1", { owner_uid: OWNER_UID, data: 1 });
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), "config", "access"));
    });
    await assertFails(getDoc(doc(db(OWNER_UID), "roles", "role-1")));
  });

  it("a malformed owner_uids (not a list) admits nobody", async () => {
    await seedDoc("roles", "role-1", { owner_uid: OWNER_UID, data: 1 });
    await seedDoc("config", "access", { owner_uids: OWNER_UID });
    await assertFails(getDoc(doc(db(OWNER_UID), "roles", "role-1")));
  });

  it("the deploy script's overwrite discards a pre-seeded allowlist", async () => {
    // Simulates the pre-deploy window: under the old catch-all rule a
    // stranger could have created `config/access` naming themselves,
    // with extra fields. `writeOwnerAllowlist` (the deploy step) must
    // replace it wholesale, and the stranger must end up with nothing.
    await seedDoc("config", "access", {
      owner_uids: [STRANGER_UID],
      owner_uid: STRANGER_UID,
      extra: true,
    });
    await seedDoc("roles", "role-s", { owner_uid: STRANGER_UID, data: 1 });
    await assertSucceeds(getDoc(doc(db(STRANGER_UID), "roles", "role-s")));

    initializeAdminAppForTests("matchline-rules-test");
    await writeOwnerAllowlist(getAdminDb(), [OWNER_UID]);

    await assertFails(getDoc(doc(db(STRANGER_UID), "roles", "role-s")));
    await seedDoc("roles", "role-o", { owner_uid: OWNER_UID, data: 1 });
    await assertSucceeds(getDoc(doc(db(OWNER_UID), "roles", "role-o")));
    let stored: Record<string, unknown> | undefined;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      stored = (await getDoc(doc(ctx.firestore(), "config", "access"))).data();
    });
    expect(Object.keys(stored ?? {}).sort()).toEqual(["owner_uids", "updated_at"]);
    expect(stored?.owner_uids).toEqual([OWNER_UID]);
  });
});

// -- Default deny (#439) --------------------------------------------------

describe("rules: default deny", () => {
  it("an allowlisted owner cannot create a doc in an unlisted collection", async () => {
    // The former catch-all `match /{collection}/{docId}` admitted any
    // collection name as long as owner_uid matched.
    await assertFails(
      setDoc(doc(db(OWNER_UID), "arbitraryCollection", "doc-1"), {
        owner_uid: OWNER_UID,
        data: 1,
      }),
    );
  });

  it("an allowlisted owner cannot read a doc in an unlisted collection", async () => {
    await seedDoc("arbitraryCollection", "doc-1", { owner_uid: OWNER_UID });
    await assertFails(getDoc(doc(db(OWNER_UID), "arbitraryCollection", "doc-1")));
  });

  it("llm_calls is closed to clients, even for the owner's own rows", async () => {
    await seedDoc("llm_calls", "call-1", { owner_uid: OWNER_UID, cost_usd: 0.01 });
    await assertFails(getDoc(doc(db(OWNER_UID), "llm_calls", "call-1")));
    await assertFails(
      setDoc(doc(db(OWNER_UID), "llm_calls", "call-2"), {
        owner_uid: OWNER_UID,
        cost_usd: 0,
      }),
    );
  });
});

// -- experienceUnits field limits -----------------------------------------

describe("rules: experienceUnits field limits", () => {
  /** The shape `buildManualUnit` produces (src/services/experienceUnits-state.ts). */
  function manualUnit(ownerUid: string): Record<string, unknown> {
    return {
      owner_uid: ownerUid,
      source_type: "manual",
      source_ref: "manual entry",
      raw_text: "Led a team.",
      normalized_summary: "Led a team.",
      unit_type: "achievement",
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "user_confirmed",
      confidence_score: 1,
      user_approved: true,
      reembed_pending: true,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
  }

  /** A pipeline-written Unit, as extraction persists it. */
  function extractedUnit(ownerUid: string): Record<string, unknown> {
    return {
      ...manualUnit(ownerUid),
      source_type: "resume",
      evidence_type: "verified",
      user_approved: false,
      rejected: false,
      flagged: false,
      reembed_pending: false,
      embedding: [0.1, 0.2, 0.3],
      date_range: { start: "2020-01" },
    };
  }

  it("ALLOWS the manualInsert create shape", async () => {
    await assertSucceeds(
      setDoc(doc(db(OWNER_UID), "experienceUnits", "u-1"), manualUnit(OWNER_UID)),
    );
  });

  it("REJECTS a client create that supplies an embedding", async () => {
    await assertFails(
      setDoc(doc(db(OWNER_UID), "experienceUnits", "u-1"), {
        ...manualUnit(OWNER_UID),
        embedding: [0.1, 0.2, 0.3],
      }),
    );
  });

  it("ALLOWS the updateFields shape, including a date_range deleteField", async () => {
    await seedDoc("experienceUnits", "u-1", extractedUnit(OWNER_UID));
    await assertSucceeds(
      updateDoc(doc(db(OWNER_UID), "experienceUnits", "u-1"), {
        raw_text: "Led a team of five.",
        normalized_summary: "Led a team of five.",
        skills: ["leadership"],
        metrics: [{ value: 5, unit: "people" }],
        date_range: deleteField(),
        reembed_pending: true,
        updated_at: "2026-01-02T00:00:00.000Z",
      }),
    );
  });

  it("ALLOWS the setApproval shape", async () => {
    await seedDoc("experienceUnits", "u-1", extractedUnit(OWNER_UID));
    await assertSucceeds(
      updateDoc(doc(db(OWNER_UID), "experienceUnits", "u-1"), {
        user_approved: true,
        rejected: false,
        flagged: false,
        updated_at: "2026-01-02T00:00:00.000Z",
      }),
    );
  });

  it("REJECTS a client update that replaces the embedding", async () => {
    await seedDoc("experienceUnits", "u-1", extractedUnit(OWNER_UID));
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "experienceUnits", "u-1"), {
        embedding: [0.9, 0.9, 0.9],
      }),
    );
  });

  it("REJECTS a client update that removes the embedding", async () => {
    await seedDoc("experienceUnits", "u-1", extractedUnit(OWNER_UID));
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "experienceUnits", "u-1"), {
        embedding: deleteField(),
      }),
    );
  });

  it("REJECTS a client update to created_at or an unknown field", async () => {
    await seedDoc("experienceUnits", "u-1", extractedUnit(OWNER_UID));
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "experienceUnits", "u-1"), {
        created_at: "1999-01-01T00:00:00.000Z",
      }),
    );
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "experienceUnits", "u-1"), {
        something_else: true,
      }),
    );
  });
});

// -- jobRequirementUnits field limits ---------------------------------------

describe("rules: jobRequirementUnits field limits", () => {
  /** A Requirement as the JD parsing pipeline persists it. */
  function parsedRequirement(ownerUid: string): Record<string, unknown> {
    return {
      owner_uid: ownerUid,
      role_id: "role-1",
      raw_text: "5+ years of SQL",
      normalized_requirement: "SQL experience",
      category: "skill",
      keywords: ["sql"],
      tools: [],
      domains: [],
      priority: "medium",
      must_have: false,
      extracted_from: "qualifications",
      embedding: [0.1, 0.2, 0.3],
    };
  }

  it("ALLOWS the upsertRequirement inline-edit shape (merge setDoc of the full doc, content changed)", async () => {
    await seedDoc("jobRequirementUnits", "r-1", parsedRequirement(OWNER_UID));
    const { embedding: _e, ...withoutEmbedding } = parsedRequirement(OWNER_UID);
    await assertSucceeds(
      setDoc(
        doc(db(OWNER_UID), "jobRequirementUnits", "r-1"),
        {
          ...withoutEmbedding,
          normalized_requirement: "Advanced SQL",
          keywords: ["sql", "postgres"],
          priority: "high",
          must_have: true,
          seniority_level: "senior",
        },
        { merge: true },
      ),
    );
  });

  it("REJECTS a client update to the embedding", async () => {
    await seedDoc("jobRequirementUnits", "r-1", parsedRequirement(OWNER_UID));
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "jobRequirementUnits", "r-1"), {
        embedding: [0.9, 0.9, 0.9],
      }),
    );
  });

  it("REJECTS moving a Requirement to another Role or changing its provenance", async () => {
    await seedDoc("jobRequirementUnits", "r-1", parsedRequirement(OWNER_UID));
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "jobRequirementUnits", "r-1"), { role_id: "role-2" }),
    );
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "jobRequirementUnits", "r-1"), {
        extracted_from: "responsibilities",
      }),
    );
  });

  it("REJECTS an edit by a signed-in stranger or another owner", async () => {
    await seedDoc("jobRequirementUnits", "r-1", parsedRequirement(OWNER_UID));
    await assertFails(
      updateDoc(doc(db(STRANGER_UID), "jobRequirementUnits", "r-1"), {
        normalized_requirement: "x",
      }),
    );
    await assertFails(
      updateDoc(doc(db(OTHER_UID), "jobRequirementUnits", "r-1"), {
        normalized_requirement: "x",
      }),
    );
  });

  it("REJECTS creating a Requirement through upsertRequirement's merge setDoc on a new id", async () => {
    await assertFails(
      setDoc(
        doc(db(OWNER_UID), "jobRequirementUnits", "r-new"),
        parsedRequirement(OWNER_UID),
        { merge: true },
      ),
    );
  });
});

// -- applications field limits ----------------------------------------------

describe("rules: applications field limits", () => {
  const asset = (status: string) => ({
    id: "asset-1",
    kind: "resume",
    validation_status: status,
    generated_content: {
      summary: { id: "s", text: "Summary.", source_unit_ids: ["u-1"] },
      bullets: [{ id: "b1", text: "Led a team.", source_unit_ids: ["u-1"] }],
      skills: [],
    },
  });

  /** The Application shell `upsertApplication` writes from RoleDetail. */
  const shell = {
    owner_uid: OWNER_UID,
    role_id: "role-1",
    stage: "drafting",
    last_activity_at: "2026-01-01T00:00:00.000Z",
    generated_assets: [],
    approved_unit_ids: ["u-1"],
  };

  it("ALLOWS the upsertApplication create shape (merge setDoc on a new id)", async () => {
    await assertSucceeds(
      setDoc(doc(db(OWNER_UID), "applications", "app-1"), shell, { merge: true }),
    );
  });

  it("ALLOWS create through the real service converter, which strips `id`", async () => {
    // upsertApplication writes through `typedDoc`, whose converter
    // (makeConverter) drops `id` from the payload. Exercise that exact
    // converter rather than asserting its behavior by hand.
    const ref = doc(db(OWNER_UID), "applications", "app-1").withConverter(
      makeConverter<{ id: string } & typeof shell>(),
    );
    await assertSucceeds(setDoc(ref, { id: "app-1", ...shell }, { merge: true }));
  });

  it("ALLOWS an `id` field that matches the document id", async () => {
    await assertSucceeds(
      setDoc(doc(db(OWNER_UID), "applications", "app-1"), { id: "app-1", ...shell }),
    );
  });

  it("REJECTS an `id` field that disagrees with the document id", async () => {
    await assertFails(
      setDoc(doc(db(OWNER_UID), "applications", "app-1"), { id: "app-2", ...shell }),
    );
  });

  it("REJECTS a create that carries a pre-built asset", async () => {
    await assertFails(
      setDoc(doc(db(OWNER_UID), "applications", "app-1"), {
        ...shell,
        generated_assets: [asset("passed")],
      }),
    );
  });

  it("REJECTS a create with a field outside the shell", async () => {
    await assertFails(
      setDoc(doc(db(OWNER_UID), "applications", "app-1"), {
        ...shell,
        validated: true,
      }),
    );
  });

  it("ALLOWS the editor's generated_assets rewrite (edit / remove / reorder / undo)", async () => {
    await seedDoc("applications", "app-1", {
      ...shell,
      generated_assets: [asset("passed")],
    });
    const edited = asset("stale");
    edited.generated_content.bullets = [
      { id: "b1", text: "Led a team of five.", source_unit_ids: [] },
    ];
    await assertSucceeds(
      updateDoc(doc(db(OWNER_UID), "applications", "app-1"), {
        generated_assets: [edited],
      }),
    );
  });

  it("REJECTS adding an asset from the client", async () => {
    await seedDoc("applications", "app-1", {
      ...shell,
      generated_assets: [asset("stale")],
    });
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "applications", "app-1"), {
        generated_assets: [asset("stale"), { ...asset("passed"), id: "asset-2" }],
      }),
    );
  });

  it("REJECTS rewriting approved_unit_ids after create", async () => {
    await seedDoc("applications", "app-1", shell);
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "applications", "app-1"), {
        approved_unit_ids: ["u-1", "u-forged"],
      }),
    );
  });

  it("REJECTS an update to a field outside the editable set", async () => {
    await seedDoc("applications", "app-1", shell);
    await assertFails(
      updateDoc(doc(db(OWNER_UID), "applications", "app-1"), {
        role_id: "role-2",
      }),
    );
  });
});

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

  it("ALLOWS approving a match the pipeline already stamped (#444 regression)", async () => {
    // The break the first version of this rule shipped, and the
    // most important test in this file for a while.
    //
    // `request.resource.data` on an UPDATE is the complete
    // post-write document, so `setMatchApprovalState`'s
    // `updateDoc` carries the existing `schema_version` forward
    // even though the client never touched it. A blanket "the
    // field must be absent" predicate therefore rejected approve
    // and reject on every match the pipeline has ever written —
    // which is all of them.
    //
    // The original allow-path test seeded an UNVERSIONED legacy
    // row, so it passed while the real post-commit path was
    // broken. Seeding a versioned row is the entire point.
    // Codex P1 on PR #450, found after merge.
    await seedDoc("unitMatches", "match-versioned", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
      schema_version: 1,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertSucceeds(
      updateDoc(doc(ctx.firestore(), "unitMatches", "match-versioned"), {
        approved_for_use: true,
        user_rejected: false,
      }),
    );
  });

  it("ALLOWS a merge write that carries the server's schema_version forward", async () => {
    // `setDoc(..., { merge: true })` reaches the same rule with
    // the same post-write shape.
    await seedDoc("unitMatches", "match-merge", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
      schema_version: 1,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertSucceeds(
      setDoc(
        doc(ctx.firestore(), "unitMatches", "match-merge"),
        { owner_uid: OWNER_UID, approved_for_use: true },
        { merge: true },
      ),
    );
  });

  it("REJECTS rewriting the rationale while preserving schema_version", async () => {
    // The gap an equality check on the marker alone left open,
    // and the sharpest form of the whole problem: keeping the
    // version while replacing the prose forges the claim just as
    // effectively as forging the version. The attestation is that
    // the PIPELINE produced this row and gated the rationale —
    // guarding the label without guarding the fact protects
    // nothing. Codex P1 on PR #451.
    await seedDoc("unitMatches", "match-attested", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
      schema_version: 1,
      rationale: "Matched on skill overlap.",
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      updateDoc(doc(ctx.firestore(), "unitMatches", "match-attested"), {
        rationale: "Matched on product strategy, roadmap ownership and P&L.",
      }),
    );
  });

  it("REJECTS rewriting scores or applicability on an attested match", async () => {
    await seedDoc("unitMatches", "match-scored", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
      schema_version: 1,
      final_score: 0.2,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      updateDoc(doc(ctx.firestore(), "unitMatches", "match-scored"), {
        final_score: 0.99,
      }),
    );
  });

  it("REJECTS forging the #435-era bridge on a legacy match", async () => {
    // Pre-existing hole, closed by the same rule: before
    // `schema_version` existed, `component_applicability`
    // presence WAS the trust signal, so a client could add it
    // alongside invented prose and have MatchCard render the
    // result as a grounded claim.
    await seedDoc("unitMatches", "match-legacy-forge", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
      rationale: "Matched on skill overlap.",
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      updateDoc(doc(ctx.firestore(), "unitMatches", "match-legacy-forge"), {
        rationale: "Matched on product strategy.",
        component_applicability: { skill_overlap: true },
      }),
    );
  });

  it("REJECTS a client CHANGING an existing schema_version", async () => {
    await seedDoc("unitMatches", "match-v1", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
      schema_version: 1,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      updateDoc(doc(ctx.firestore(), "unitMatches", "match-v1"), {
        schema_version: 99,
      }),
    );
  });

  it("REJECTS a client ADDING schema_version to an unversioned match", async () => {
    // The forge path the rule exists for: a legacy row plus a
    // fabricated version would make ungated prose render as a
    // grounded claim.
    await seedDoc("unitMatches", "match-legacy", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      updateDoc(doc(ctx.firestore(), "unitMatches", "match-legacy"), {
        schema_version: 1,
      }),
    );
  });

  it("REJECTS a client REMOVING schema_version", async () => {
    // Stripping the attestation is as much a forgery as adding
    // one — it would silently downgrade a sound row to the
    // legacy tier.
    await seedDoc("unitMatches", "match-strip", {
      owner_uid: OWNER_UID,
      approved_for_use: false,
      user_rejected: false,
      schema_version: 1,
    });
    const ctx = testEnv.authenticatedContext(OWNER_UID);
    await assertFails(
      setDoc(doc(ctx.firestore(), "unitMatches", "match-strip"), {
        owner_uid: OWNER_UID,
        approved_for_use: false,
        user_rejected: false,
      }),
    );
  });

  it("REJECTS client create with every flag pair — matches are pipeline-created (#439)", async () => {
    // Previously the three valid pairs were client-creatable. No
    // production client path creates a match (`upsertMatch` has no
    // caller; the matching pipeline writes via the admin SDK), so
    // creation is now server-only. The contradictory-pair and
    // schema_version guards remain meaningful on UPDATE, below.
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
      await assertFails(
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
