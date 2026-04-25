/**
 * Matching replace-by-(role, owner) integration test (sub-issue
 * #99 of #20). Pins the load-bearing transactional invariant
 * the pipeline relies on:
 *
 *   1. Re-running matching on the same Role atomically replaces
 *      the prior match set.
 *   2. Empty-result re-run still clears prior matches (so the
 *      Matches tab doesn't show stale entries when a user
 *      rejects every Unit).
 *   3. Cross-tenant safety: a match-replace operation must never
 *      delete a different owner's matches under the same role_id
 *      — even though Roles are owner-scoped, Firestore's admin
 *      SDK bypasses rules and a misuse could otherwise allow
 *      cross-tenant deletion.
 *
 * Runs against the Firestore emulator (`npm run test:rules`
 * harness). Uses the firebase-admin SDK directly because that's
 * what the pipeline uses; the modular client SDK is wrong for
 * this test (it goes through rules and would fail-closed on
 * cross-owner queries even where the bug is in the admin code).
 *
 * Why an emulator test and not a unit test:
 *   - The unit-test surface (`functions/src/matching/pipeline.test.ts`)
 *     pins the composition logic + DI shape via mocked persist.
 *   - This is the READ-AND-WRITE side: given seeded Firestore
 *     state, does `replaceMatchesForRole` (the real persist)
 *     correctly clear-and-replace + scope by owner?
 */

import { initializeApp, deleteApp, type App } from "firebase-admin/app";
import {
  Firestore,
  getFirestore,
} from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMatchingPipeline } from "../functions/src/matching/pipeline.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../functions/src/types/capability.ts";
import type { ScoreResult } from "../functions/src/matching/score.ts";

const PROJECT_ID = "matchline-matching-replace-test";
const ALICE = "user-alice";
const BOB = "user-bob";

let app: App;
let db: Firestore;

beforeAll(async () => {
  // Point firebase-admin at the emulator. `firebase emulators:exec`
  // sets FIRESTORE_EMULATOR_HOST automatically; if a developer runs
  // this file directly without the harness, the test fails fast at
  // the first read.
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "matching-replace.integration.test.ts must run under " +
        "`firebase emulators:exec` — FIRESTORE_EMULATOR_HOST not set.",
    );
  }
  app = initializeApp({ projectId: PROJECT_ID }, "matching-replace-test");
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  // Wipe all four collections we touch.
  for (const col of [
    "roles",
    "experienceUnits",
    "jobRequirementUnits",
    "unitMatches",
  ]) {
    const snap = await db.collection(col).get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    if (snap.docs.length > 0) await batch.commit();
  }
});

// -- Seed helpers -----------------------------------------------------------

async function seedRole(id: string, ownerUid: string): Promise<void> {
  await db
    .collection("roles")
    .doc(id)
    .set({ id, owner_uid: ownerUid });
}

function makeUnit(
  id: string,
  ownerUid: string,
  overrides: Partial<ExperienceUnit> = {},
): ExperienceUnit {
  return {
    id,
    owner_uid: ownerUid,
    source_type: "resume",
    source_ref: "ref",
    raw_text: "raw",
    normalized_summary: `Unit ${id}`,
    unit_type: "project",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: true,
    embedding: [1, 0, 0],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRequirement(
  id: string,
  ownerUid: string,
  roleId: string,
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  return {
    id,
    owner_uid: ownerUid,
    role_id: roleId,
    raw_text: "raw",
    normalized_requirement: `Req ${id}`,
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "medium",
    must_have: false,
    extracted_from: "qualifications",
    embedding: [1, 0, 0],
    ...overrides,
  };
}

async function seedUnits(units: readonly ExperienceUnit[]): Promise<void> {
  const batch = db.batch();
  for (const u of units) {
    batch.set(db.collection("experienceUnits").doc(u.id), u);
  }
  await batch.commit();
}

async function seedRequirements(
  reqs: readonly JobRequirementUnit[],
): Promise<void> {
  const batch = db.batch();
  for (const r of reqs) {
    batch.set(db.collection("jobRequirementUnits").doc(r.id), r);
  }
  await batch.commit();
}

async function seedMatches(matches: readonly UnitMatch[]): Promise<void> {
  const batch = db.batch();
  for (const m of matches) {
    batch.set(db.collection("unitMatches").doc(m.id), m);
  }
  await batch.commit();
}

function makeMatch(overrides: Partial<UnitMatch> & { id: string; role_id: string; owner_uid: string }): UnitMatch {
  return {
    experience_unit_id: "u-default",
    job_requirement_unit_id: "r-default",
    semantic_score: 0,
    rule_score: 0,
    final_score: 0,
    rationale: "",
    surface_evidence: "",
    approved_for_use: false,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const FAKE_SCORE: () => ScoreResult = () => ({
  components: {
    semantic_similarity: 1,
    skill_overlap: 0,
    domain_overlap: 0,
    tool_overlap: 0,
    seniority_alignment: 0,
    scope_alignment: 0,
    recency: 0,
  },
  rule_score: 0.5,
  semantic_score: 1,
  final_score: 0.5,
});

// -- Tests ------------------------------------------------------------------

describe("runMatchingPipeline replace-by-(role, owner)", () => {
  it("happy path: persists fresh matches and they're queryable by (owner, role)", async () => {
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE), makeUnit("u2", ALICE)]);
    await seedRequirements([makeRequirement("r1", ALICE, "role-1")]);

    const result = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );

    expect(result).toHaveLength(2);

    // Read back via the canonical (owner, role) query.
    const snap = await db
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .get();
    expect(snap.docs).toHaveLength(2);
    for (const doc of snap.docs) {
      const m = doc.data() as UnitMatch;
      expect(m.role_id).toBe("role-1");
      expect(m.owner_uid).toBe(ALICE);
    }
  });

  it("re-running matching atomically replaces the prior set (no union, no leftovers)", async () => {
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE)]);
    await seedRequirements([makeRequirement("r1", ALICE, "role-1")]);

    // First run.
    const first = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(first).toHaveLength(1);
    const firstMatchId = first[0]!.id;

    // Second run should produce a different id (UUIDv4) but
    // replace the prior match doc.
    const second = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(firstMatchId);

    // Firestore now contains exactly the second-run match —
    // not a union of first + second.
    const snap = await db
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .get();
    expect(snap.docs).toHaveLength(1);
    expect(snap.docs[0]!.id).toBe(second[0]!.id);
    // The first run's match doc is gone.
    const firstDocSnap = await db
      .collection("unitMatches")
      .doc(firstMatchId)
      .get();
    expect(firstDocSnap.exists).toBe(false);
  });

  it("empty-result re-run still wipes prior matches (Matches tab can't show stale)", async () => {
    // Seed prior matches under (Alice, role-1).
    await seedRole("role-1", ALICE);
    await seedMatches([
      makeMatch({ id: "stale-1", owner_uid: ALICE, role_id: "role-1" }),
      makeMatch({ id: "stale-2", owner_uid: ALICE, role_id: "role-1" }),
    ]);

    // Run matching with no Units (Alice rejected every Unit).
    // No Requirements either.
    const result = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(result).toEqual([]);

    // Stale matches are gone.
    const snap = await db
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .get();
    expect(snap.docs).toHaveLength(0);
  });

  it("cross-tenant safety: re-running for Alice does NOT delete Bob's matches under the same role_id", async () => {
    // The load-bearing test for #99's cross-tenant invariant.
    // Seed matches for both Alice and Bob under the same role_id
    // (legitimate — `roles` is owner-scoped, but defensive
    // against id-collision races).
    await seedRole("role-shared", ALICE);
    await seedMatches([
      makeMatch({ id: "alice-m1", owner_uid: ALICE, role_id: "role-shared" }),
      makeMatch({ id: "alice-m2", owner_uid: ALICE, role_id: "role-shared" }),
      makeMatch({ id: "bob-m1", owner_uid: BOB, role_id: "role-shared" }),
      makeMatch({ id: "bob-m2", owner_uid: BOB, role_id: "role-shared" }),
    ]);
    // Seed Alice's Units + Reqs so a fresh match writes.
    await seedUnits([makeUnit("alice-u1", ALICE)]);
    await seedRequirements([
      makeRequirement("alice-r1", ALICE, "role-shared"),
    ]);

    // Run matching for Alice.
    await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-shared" },
      { score: FAKE_SCORE },
    );

    // Bob's matches must be untouched.
    const bobSnap = await db
      .collection("unitMatches")
      .where("owner_uid", "==", BOB)
      .where("role_id", "==", "role-shared")
      .get();
    expect(bobSnap.docs.map((d) => d.id).sort()).toEqual([
      "bob-m1",
      "bob-m2",
    ]);

    // Alice's prior matches are gone (replaced by the fresh run).
    const aliceM1 = await db.collection("unitMatches").doc("alice-m1").get();
    const aliceM2 = await db.collection("unitMatches").doc("alice-m2").get();
    expect(aliceM1.exists).toBe(false);
    expect(aliceM2.exists).toBe(false);

    // Alice has fresh match(es) — the count == 1*1 = 1.
    const aliceSnap = await db
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-shared")
      .get();
    expect(aliceSnap.docs).toHaveLength(1);
  });

  it("cross-role safety: re-running for role-A does NOT delete matches under role-B (same owner)", async () => {
    // A user can have multiple Roles. Re-running matching on
    // role-A must not affect role-B's persisted matches.
    await seedRole("role-A", ALICE);
    await seedRole("role-B", ALICE);
    await seedMatches([
      makeMatch({ id: "a1", owner_uid: ALICE, role_id: "role-A" }),
      makeMatch({ id: "b1", owner_uid: ALICE, role_id: "role-B" }),
      makeMatch({ id: "b2", owner_uid: ALICE, role_id: "role-B" }),
    ]);
    await seedUnits([makeUnit("u1", ALICE)]);
    await seedRequirements([makeRequirement("rA1", ALICE, "role-A")]);

    await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-A" },
      { score: FAKE_SCORE },
    );

    // role-B matches untouched.
    const bSnap = await db
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-B")
      .get();
    expect(bSnap.docs.map((d) => d.id).sort()).toEqual(["b1", "b2"]);
  });

  it("happy path: matches sorted high-to-low by final_score in the persisted set", async () => {
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE), makeUnit("u2", ALICE)]);
    await seedRequirements([makeRequirement("r1", ALICE, "role-1")]);

    let callIdx = 0;
    const score = (): ScoreResult => {
      const v = callIdx++ === 0 ? 0.3 : 0.9;
      return {
        components: {
          semantic_similarity: 1,
          skill_overlap: 0,
          domain_overlap: 0,
          tool_overlap: 0,
          seniority_alignment: 0,
          scope_alignment: 0,
          recency: 0,
        },
        rule_score: v,
        semantic_score: 1,
        final_score: v,
      };
    };

    await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score },
    );

    const snap = await db
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .orderBy("final_score", "desc")
      .get();
    const scores = snap.docs.map((d) => (d.data() as UnitMatch).final_score);
    expect(scores).toEqual([0.9, 0.3]);
  });
});
