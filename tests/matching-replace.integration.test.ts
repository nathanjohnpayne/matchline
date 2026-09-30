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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getAdminDb,
  initializeAdminAppForTests,
} from "../functions/src/firestore/admin.ts";
import {
  MATCH_WRITES_PER_COMMIT,
  matchDocId,
  runMatchingPipeline,
} from "../functions/src/matching/pipeline.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../functions/src/types/capability.ts";
import type { ScoreResult } from "../functions/src/matching/score.ts";

const PROJECT_ID = "matchline-matching-replace-test";
const ALICE = "user-alice";
const BOB = "user-bob";

// Both the test seed code AND `runMatchingPipeline` (via
// `getAdminDb()`) must use the SAME `firebase-admin` module
// instance — otherwise the default-app registries diverge and
// `getFirestore()` throws "default app does not exist." Codex
// P1 round 2 on PR #104 caught a prior version that imported
// `firebase-admin/app` directly from the test file, which
// resolves to root `node_modules` (a separate copy from
// `functions/node_modules`). Routing init + db access through
// `functions/src/firestore/admin.ts` forces the
// functions-package module instance on both sides.

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "matching-replace.integration.test.ts must run under " +
        "`firebase emulators:exec` — FIRESTORE_EMULATOR_HOST not set.",
    );
  }
  initializeAdminAppForTests(PROJECT_ID);
});

afterAll(async () => {
  // Intentionally no `deleteApp` — the firebase-admin module
  // instance is process-scoped (functions-package singleton) and
  // a sibling test suite running in the same process could
  // legitimately re-use it. The emulator is wiped by
  // `beforeEach` between tests; the in-memory app handle costs
  // nothing.
});

const db = (): ReturnType<typeof getAdminDb> => getAdminDb();

beforeEach(async () => {
  // Wipe all four collections we touch.
  for (const col of [
    "roles",
    "experienceUnits",
    "jobRequirementUnits",
    "unitMatches",
  ]) {
    const snap = await db().collection(col).get();
    const batch = db().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    if (snap.docs.length > 0) await batch.commit();
  }
});

// -- Seed helpers -----------------------------------------------------------

async function seedRole(id: string, ownerUid: string): Promise<void> {
  await db()
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
  const batch = db().batch();
  for (const u of units) {
    batch.set(db().collection("experienceUnits").doc(u.id), u);
  }
  await batch.commit();
}

async function seedRequirements(
  reqs: readonly JobRequirementUnit[],
): Promise<void> {
  const batch = db().batch();
  for (const r of reqs) {
    batch.set(db().collection("jobRequirementUnits").doc(r.id), r);
  }
  await batch.commit();
}

async function seedMatches(matches: readonly UnitMatch[]): Promise<void> {
  const batch = db().batch();
  for (const m of matches) {
    batch.set(db().collection("unitMatches").doc(m.id), m);
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
  // Stub scorers assert on rule/final scores only; the
  // structural-evidence verdict is exercised in
  // functions/src/matching/score.test.ts (#435).
  structural_evidence: true,
  component_applicability: {
    semantic_similarity: true,
    skill_overlap: true,
    domain_overlap: true,
    tool_overlap: true,
    seniority_alignment: true,
    scope_alignment: true,
    recency: true,
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
    const snap = await db()
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

    // The pair's id is deterministic, so the second run
    // overwrites the first run's doc in place rather than
    // deleting it and writing a new one. (Before deterministic
    // ids, every rerun cost a delete per prior match plus a
    // write per new one.)
    expect(firstMatchId).toBe(matchDocId(ALICE, "role-1", "u1", "r1"));
    const second = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(firstMatchId);

    // Firestore contains exactly one match for the pair — not a
    // union of first + second.
    const snap = await db()
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .get();
    expect(snap.docs).toHaveLength(1);
    expect(snap.docs[0]!.id).toBe(firstMatchId);
  });

  it("a rerun deletes matches for a pair that no longer exists (orphans), and only those", async () => {
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE), makeUnit("u2", ALICE)]);
    await seedRequirements([makeRequirement("r1", ALICE, "role-1")]);
    await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );

    // u2 is un-approved, so it drops out of the matching input.
    await db().collection("experienceUnits").doc("u2").update({ user_approved: false });
    const second = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(second.map((m) => m.id)).toEqual([matchDocId(ALICE, "role-1", "u1", "r1")]);

    const snap = await db()
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .get();
    expect(snap.docs.map((d) => d.id)).toEqual([matchDocId(ALICE, "role-1", "u1", "r1")]);
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
    const snap = await db()
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
    const bobSnap = await db()
      .collection("unitMatches")
      .where("owner_uid", "==", BOB)
      .where("role_id", "==", "role-shared")
      .get();
    expect(bobSnap.docs.map((d) => d.id).sort()).toEqual([
      "bob-m1",
      "bob-m2",
    ]);

    // Alice's prior matches are gone (replaced by the fresh run).
    const aliceM1 = await db().collection("unitMatches").doc("alice-m1").get();
    const aliceM2 = await db().collection("unitMatches").doc("alice-m2").get();
    expect(aliceM1.exists).toBe(false);
    expect(aliceM2.exists).toBe(false);

    // Alice has fresh match(es) — the count == 1*1 = 1.
    const aliceSnap = await db()
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
    const bSnap = await db()
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
        // Stub scorers assert on rule/final scores only; the
        // structural-evidence verdict is exercised in
        // functions/src/matching/score.test.ts (#435).
        structural_evidence: true,
        component_applicability: {
          semantic_similarity: true,
          skill_overlap: true,
          domain_overlap: true,
          tool_overlap: true,
          seniority_alignment: true,
          scope_alignment: true,
          recency: true,
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

    const snap = await db()
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .orderBy("final_score", "desc")
      .get();
    const scores = snap.docs.map((d) => (d.data() as UnitMatch).final_score);
    expect(scores).toEqual([0.9, 0.3]);
  });

  // -- cursor #133 r2: user-action flag carry-forward ---------------------

  it("CARRY-FORWARD (cursor #133 r2): a previously rejected (Unit, Requirement) pair stays rejected after rerun", async () => {
    // Load-bearing pin. Without the carry-forward in
    // replaceMatchesForRole, a user could reject a match,
    // rerun matching, and the same Unit+Requirement pair
    // would come back as a fresh non-rejected match —
    // generation would consume it (gates on
    // approved_for_use === false but doesn't filter on
    // user_rejected) and the user's explicit "this doesn't
    // apply" decision would be silently undone.
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE)]);
    await seedRequirements([makeRequirement("r1", ALICE, "role-1")]);

    // First run produces the initial match.
    const first = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(first).toHaveLength(1);
    const firstId = first[0]!.id;
    // User rejects the match (simulates the Matches tab
    // Reject click via the unified setMatchApprovalState
    // setter).
    await db().collection("unitMatches").doc(firstId).update({
      user_rejected: true,
      approved_for_use: false,
    });

    // Rerun matching. The new match for the same (u1, r1)
    // pair should carry forward `user_rejected: true`.
    const second = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.user_rejected).toBe(true);
    expect(second[0]!.approved_for_use).toBe(false);
    // Persist read-back: the persisted state matches.
    const snap = await db()
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .get();
    expect(snap.docs).toHaveLength(1);
    const persisted = snap.docs[0]!.data() as UnitMatch;
    expect(persisted.user_rejected).toBe(true);
    expect(persisted.experience_unit_id).toBe("u1");
    expect(persisted.job_requirement_unit_id).toBe("r1");
  });

  it("CARRY-FORWARD: a previously approved (Unit, Requirement) pair stays approved after rerun", async () => {
    // Symmetric to the rejection carry-forward. Approval is
    // load-bearing for generation (#120/#121 gate on
    // `approved_for_use === true`); losing it on rerun
    // would force the user to re-approve every time.
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE)]);
    await seedRequirements([makeRequirement("r1", ALICE, "role-1")]);

    const first = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    const firstId = first[0]!.id;
    await db().collection("unitMatches").doc(firstId).update({
      approved_for_use: true,
      user_rejected: false,
    });

    const second = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.approved_for_use).toBe(true);
    expect(second[0]!.user_rejected).toBe(false);
  });

  it("CARRY-FORWARD: a (Unit, Requirement) pair the user never touched starts fresh (false/false) after rerun", async () => {
    // Defensive pin: only PRIOR USER ACTIONS carry forward.
    // A pair that the user never approved or rejected lands
    // with the default `(false, false)` flags on each rerun
    // — no stale state from the prior run leaks through.
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE)]);
    await seedRequirements([makeRequirement("r1", ALICE, "role-1")]);

    // First run — user never touches the match.
    await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );

    // Second run.
    const second = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.approved_for_use).toBe(false);
    expect(second[0]!.user_rejected).toBe(false);
  });

  it("CARRY-FORWARD CANONICAL (cursor #133 r3): a stored (approved_for_use:true, user_rejected:true) shape canonicalizes to rejected on rerun — rejection wins, generation can't consume it", async () => {
    // The contradictory shape is unrepresentable via the
    // unified `setMatchApprovalState` setter (#133 r1), but
    // a stale pre-unified-setter record or a manual
    // Firestore write could leave it in storage. Without
    // canonicalization on carry-forward, downstream readers
    // disagree:
    //   - UI's `approvalStateOf` defaults (true, true) to
    //     "rejected" (conservative); computeGaps filters it.
    //   - Generation gates on `approved_for_use === true`
    //     and ignores `user_rejected`, so it WOULD consume
    //     the match — the user's rejection silently lost.
    //
    // The fix: when carry-forward sees user_rejected:true,
    // force approved_for_use:false. Once the user has
    // rejected a pair, that decision wins at the storage
    // layer until they explicitly un-reject. Rerun heals
    // any drift.
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE)]);
    await seedRequirements([makeRequirement("r1", ALICE, "role-1")]);

    const first = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(first).toHaveLength(1);
    const firstId = first[0]!.id;

    // Force the contradictory shape directly into Firestore
    // (bypassing the unified setter — simulating drift from
    // a stale record / manual edit / migration).
    await db().collection("unitMatches").doc(firstId).update({
      approved_for_use: true,
      user_rejected: true,
    });

    // Rerun. The carry-forward must canonicalize.
    const second = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.user_rejected).toBe(true);
    // CRITICAL: approved_for_use canonicalized to false.
    // Without this, generation (which gates on
    // approved_for_use === true) would consume the match
    // despite the user's rejection.
    expect(second[0]!.approved_for_use).toBe(false);

    // Persist read-back: the persisted state matches.
    const snap = await db()
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", "role-1")
      .get();
    expect(snap.docs).toHaveLength(1);
    const persisted = snap.docs[0]!.data() as UnitMatch;
    expect(persisted.user_rejected).toBe(true);
    expect(persisted.approved_for_use).toBe(false);
  });

  it("CARRY-FORWARD: granular per-pair tracking — rejecting one (u1, r1) pair does NOT affect (u1, r2) or (u2, r1)", async () => {
    // Granularity pin. The carry-forward keys on the FULL
    // (experience_unit_id, job_requirement_unit_id) pair,
    // not on either component alone.
    await seedRole("role-1", ALICE);
    await seedUnits([makeUnit("u1", ALICE), makeUnit("u2", ALICE)]);
    await seedRequirements([
      makeRequirement("r1", ALICE, "role-1"),
      makeRequirement("r2", ALICE, "role-1"),
    ]);

    const first = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(first).toHaveLength(4); // 2 units × 2 reqs

    // User rejects ONLY the (u1, r1) pair.
    const target = first.find(
      (m) =>
        m.experience_unit_id === "u1" && m.job_requirement_unit_id === "r1",
    );
    expect(target).toBeDefined();
    await db().collection("unitMatches").doc(target!.id).update({
      user_rejected: true,
      approved_for_use: false,
    });

    // Rerun.
    const second = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(second).toHaveLength(4);

    // The (u1, r1) pair carries the rejection forward.
    const u1r1 = second.find(
      (m) =>
        m.experience_unit_id === "u1" && m.job_requirement_unit_id === "r1",
    );
    expect(u1r1?.user_rejected).toBe(true);

    // Other pairs are untouched.
    const others = second.filter(
      (m) =>
        !(m.experience_unit_id === "u1" && m.job_requirement_unit_id === "r1"),
    );
    expect(others).toHaveLength(3);
    for (const m of others) {
      expect(m.user_rejected).toBe(false);
      expect(m.approved_for_use).toBe(false);
    }
  });
});

// -- Realistic Role sizes -------------------------------------------------
//
// The previous implementation deleted every prior match and wrote
// every new one in ONE transaction, and threw above 450 ops. A
// realistic Role — ~22 approved Units × ~15 Requirements ≈ 330
// matches — fit on its first run (330 ops) and failed on every rerun
// (330 deletes + 330 writes = 660), which is exactly when users rerun:
// after editing a Unit or re-parsing the JD. These pin the fix
// (deterministic ids + chunked commits) at and beyond that size.

describe("runMatchingPipeline at realistic Role sizes", () => {
  async function seedRoleOfSize(
    roleId: string,
    unitCount: number,
    reqCount: number,
  ): Promise<void> {
    await seedRole(roleId, ALICE);
    await seedUnits(
      Array.from({ length: unitCount }, (_, i) => makeUnit(`u${i}`, ALICE)),
    );
    await seedRequirements(
      Array.from({ length: reqCount }, (_, i) =>
        makeRequirement(`r${i}`, ALICE, roleId),
      ),
    );
  }

  async function storedMatches(roleId: string): Promise<UnitMatch[]> {
    const snap = await db()
      .collection("unitMatches")
      .where("owner_uid", "==", ALICE)
      .where("role_id", "==", roleId)
      .get();
    return snap.docs.map((d) => ({ ...(d.data() as UnitMatch), id: d.id }));
  }

  it("22 Units × 15 Requirements: a rerun succeeds, keeps 330 docs at the same ids, and carries decisions forward", async () => {
    await seedRoleOfSize("role-1", 22, 15);
    const ctx = { ownerUid: ALICE, roleId: "role-1" };

    const first = await runMatchingPipeline(ctx, { score: FAKE_SCORE });
    expect(first).toHaveLength(330);

    // The user reviews a few matches between runs.
    const approvedId = matchDocId(ALICE, "role-1", "u0", "r0");
    const rejectedId = matchDocId(ALICE, "role-1", "u21", "r14");
    await db().collection("unitMatches").doc(approvedId).update({ approved_for_use: true });
    await db().collection("unitMatches").doc(rejectedId).update({ user_rejected: true });

    // Pre-fix this threw: 330 existing + 330 new = 660 > 450.
    const second = await runMatchingPipeline(ctx, { score: FAKE_SCORE });
    expect(second).toHaveLength(330);

    const stored = await storedMatches("role-1");
    expect(stored).toHaveLength(330);
    expect(new Set(stored.map((m) => m.id))).toEqual(new Set(first.map((m) => m.id)));

    const byId = new Map(stored.map((m) => [m.id, m]));
    expect(byId.get(approvedId)).toMatchObject({ approved_for_use: true, user_rejected: false });
    expect(byId.get(rejectedId)).toMatchObject({ approved_for_use: false, user_rejected: true });
    const untouched = stored.filter((m) => m.id !== approvedId && m.id !== rejectedId);
    expect(untouched.every((m) => !m.approved_for_use && !m.user_rejected)).toBe(true);
  });

  it("migrates a Role whose 330 matches have legacy random ids: rewrites all, deletes the legacy docs, keeps decisions", async () => {
    // Matches written before deterministic ids have random UUIDs. The
    // first rerun after this change must overwrite nothing it can't
    // see, delete all 330 legacy docs, and still carry the user's
    // decisions forward by (Unit, Requirement) pair: 330 writes + 330
    // deletes, well past the old single-transaction ceiling.
    await seedRoleOfSize("role-1", 22, 15);
    const legacy: UnitMatch[] = [];
    for (let u = 0; u < 22; u += 1) {
      for (let r = 0; r < 15; r += 1) {
        legacy.push(
          makeMatch({
            id: `legacy-u${u}-r${r}`,
            owner_uid: ALICE,
            role_id: "role-1",
            experience_unit_id: `u${u}`,
            job_requirement_unit_id: `r${r}`,
            approved_for_use: u === 3 && r === 4,
            user_rejected: u === 5 && r === 6,
          }),
        );
      }
    }
    await seedMatches(legacy);

    const result = await runMatchingPipeline(
      { ownerUid: ALICE, roleId: "role-1" },
      { score: FAKE_SCORE },
    );
    expect(result).toHaveLength(330);

    const stored = await storedMatches("role-1");
    expect(stored).toHaveLength(330);
    expect(stored.some((m) => m.id.startsWith("legacy-"))).toBe(false);
    const byId = new Map(stored.map((m) => [m.id, m]));
    expect(byId.get(matchDocId(ALICE, "role-1", "u3", "r4"))).toMatchObject({
      approved_for_use: true,
      user_rejected: false,
    });
    expect(byId.get(matchDocId(ALICE, "role-1", "u5", "r6"))).toMatchObject({
      approved_for_use: false,
      user_rejected: true,
    });
  });

  it(`30 Units × 20 Requirements (600 matches, more than one ${MATCH_WRITES_PER_COMMIT}-write commit): first run and rerun both land every match`, async () => {
    await seedRoleOfSize("role-1", 30, 20);
    const ctx = { ownerUid: ALICE, roleId: "role-1" };

    const first = await runMatchingPipeline(ctx, { score: FAKE_SCORE });
    expect(first).toHaveLength(600);
    expect(await storedMatches("role-1")).toHaveLength(600);

    const second = await runMatchingPipeline(ctx, { score: FAKE_SCORE });
    expect(second).toHaveLength(600);
    expect(await storedMatches("role-1")).toHaveLength(600);
  });

  it("a re-parse that replaces every Requirement deletes all 330 stranded matches and writes the new set", async () => {
    await seedRoleOfSize("role-1", 22, 15);
    const ctx = { ownerUid: ALICE, roleId: "role-1" };
    await runMatchingPipeline(ctx, { score: FAKE_SCORE });

    // Re-parse: the JD pipeline replaces the Requirement set with new
    // ids, so every prior match is now an orphan.
    const oldReqs = await db()
      .collection("jobRequirementUnits")
      .where("role_id", "==", "role-1")
      .get();
    const batch = db().batch();
    oldReqs.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    await seedRequirements(
      Array.from({ length: 15 }, (_, i) => makeRequirement(`r2-${i}`, ALICE, "role-1")),
    );

    const second = await runMatchingPipeline(ctx, { score: FAKE_SCORE });
    expect(second).toHaveLength(330);
    const stored = await storedMatches("role-1");
    expect(stored).toHaveLength(330);
    expect(stored.every((m) => m.job_requirement_unit_id.startsWith("r2-"))).toBe(true);
  });
});
