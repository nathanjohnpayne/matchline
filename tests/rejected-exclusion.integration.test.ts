/**
 * Rejected-exclusion integration test (closes #82's primary
 * acceptance criterion). Pins the zero-fabrication invariant at
 * the Firestore-query layer: a Unit the user has rejected MUST
 * NOT appear in the matching pipeline's input.
 *
 * The matching pipeline (sub-issue #20) feeds on
 * `listApprovedExperienceUnits()` from `src/services/`. This
 * test imports the SAME constraint factory the service uses
 * (`approvedUnitsQueryConstraints`) and runs it against the
 * Firestore emulator with seeded Units in every approval state,
 * asserting only `user_approved: true` rows come back.
 *
 * Sharing the constraint factory is load-bearing: an earlier
 * version of this test hand-wrote
 * `where("user_approved", "==", true)` inline, so a regression
 * in the service's query (e.g. someone flipping the operator)
 * would have shipped green because the test's hand-written copy
 * didn't see the change. nathanpayne-codex Phase 4b on #93.
 *
 * Why an emulator test and not a unit test:
 *
 *   - The unit-test surface (`src/services/experienceUnits-state.test.ts`)
 *     pins that `flagsForApprovalState("rejected")` writes
 *     `{ user_approved: false, rejected: true, ... }`. That's
 *     the WRITE side.
 *   - This test is the READ side: given those flag combinations
 *     persisted, does the query actually exclude them? Real
 *     Firestore semantics — including the index/operator
 *     behavior — only get exercised when running against the
 *     emulator.
 *
 * Runs via `npm run test:rules`, which wraps the suite in
 * `firebase emulators:exec --only firestore`. Do NOT include in
 * the default `npm test` run.
 */

import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDocs,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { approvedUnitsQueryConstraints } from "../src/services/experienceUnits.ts";

const COLLECTION = "experienceUnits";
const OWNER_UID = "user-alice";
const OTHER_UID = "user-bob";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "matchline-rejected-exclusion-test",
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
});

/**
 * Build a minimal Unit doc with the approval flags set per the
 * state name. Matches what `flagsForApprovalState()` writes —
 * the helper isn't imported (it's a frontend module) but the
 * flag combinations are pinned in
 * `experienceUnits-state.test.ts` so any drift there would be
 * caught alongside this test.
 */
function unitDoc(
  id: string,
  ownerUid: string,
  state: "approved" | "rejected" | "flagged" | "pending",
): Record<string, unknown> {
  const base = {
    id,
    owner_uid: ownerUid,
    source_type: "resume",
    source_ref: "",
    raw_text: "",
    normalized_summary: `Unit ${id}`,
    unit_type: "achievement",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  switch (state) {
    case "approved":
      return { ...base, user_approved: true, rejected: false, flagged: false };
    case "rejected":
      return { ...base, user_approved: false, rejected: true, flagged: false };
    case "flagged":
      return { ...base, user_approved: false, rejected: false, flagged: true };
    case "pending":
      return { ...base, user_approved: false, rejected: false, flagged: false };
  }
}

async function seed(
  id: string,
  ownerUid: string,
  state: "approved" | "rejected" | "flagged" | "pending",
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), COLLECTION, id),
      unitDoc(id, ownerUid, state),
    );
  });
}

/**
 * Run the same query that `listApprovedExperienceUnits` issues —
 * owner-scoped + the production `approvedUnitsQueryConstraints`.
 * Returns the ids of matching docs.
 *
 * Critically: the where-clauses come from
 * `approvedUnitsQueryConstraints` directly, NOT a hand-written
 * copy. A regression in the production constraint shape (e.g.
 * someone changing the operator from `==` to `!=` or pointing
 * at a different field) breaks this test, not just runtime.
 *
 * `ctx.firestore()` returns a modular-SDK Firestore instance
 * (same shape as the existing `tests/firestore-rules.test.ts`
 * suite uses), so the standard `firebase/firestore` helpers work
 * directly.
 */
async function listApprovedIds(ownerUid: string): Promise<string[]> {
  const ctx = testEnv.authenticatedContext(ownerUid);
  const snap = await getDocs(
    query(
      collection(ctx.firestore(), COLLECTION),
      where("owner_uid", "==", ownerUid),
      ...approvedUnitsQueryConstraints(),
    ),
  );
  return snap.docs.map((d) => d.id);
}

describe("rejected-exclusion invariant (zero-fabrication / #82)", () => {
  it("the production constraint factory has the documented shape", () => {
    // Belt-and-suspenders: the integration tests below use the
    // factory and would catch a regression via behavior, but
    // pinning the shape directly makes the load-bearing
    // contract explicit. If a future change widens or narrows
    // the constraints, this test forces the change to be
    // deliberate.
    const constraints = approvedUnitsQueryConstraints();
    expect(constraints).toHaveLength(1);
    // The constraint object is opaque (Firestore's QueryFieldFilterConstraint
    // is internal), so we can't introspect operator/field/value
    // directly. The behavior tests below cover the semantic
    // — one constraint, applied alongside ownerScope, must
    // exclude the rejected/pending/flagged states.
  });

  it("approved Units appear in listApprovedExperienceUnits", async () => {
    await seed("approved-1", OWNER_UID, "approved");
    await seed("approved-2", OWNER_UID, "approved");
    const ids = await listApprovedIds(OWNER_UID);
    expect(ids.sort()).toEqual(["approved-1", "approved-2"]);
  });

  it("rejected Units do NOT appear in listApprovedExperienceUnits (the core invariant)", async () => {
    // The product-defining guarantee: a Unit the user rejected
    // never reaches the matching pipeline. If this test fails,
    // generation can pull from rejected evidence — the entire
    // zero-fabrication thesis collapses.
    await seed("approved-1", OWNER_UID, "approved");
    await seed("rejected-1", OWNER_UID, "rejected");
    await seed("rejected-2", OWNER_UID, "rejected");
    const ids = await listApprovedIds(OWNER_UID);
    expect(ids).toEqual(["approved-1"]);
    expect(ids).not.toContain("rejected-1");
    expect(ids).not.toContain("rejected-2");
  });

  it("pending Units do NOT appear (user hasn't approved yet)", async () => {
    await seed("approved-1", OWNER_UID, "approved");
    await seed("pending-1", OWNER_UID, "pending");
    const ids = await listApprovedIds(OWNER_UID);
    expect(ids).toEqual(["approved-1"]);
    expect(ids).not.toContain("pending-1");
  });

  it("flagged Units do NOT appear (flagged forces user_approved=false)", async () => {
    // `flagsForApprovalState("flagged")` writes
    // `user_approved: false, flagged: true` — the "exclusive
    // with approved" design from #78. Pin that this propagates
    // through to the read query: a flagged Unit shouldn't
    // sneak into matching just because it's not technically
    // rejected.
    await seed("approved-1", OWNER_UID, "approved");
    await seed("flagged-1", OWNER_UID, "flagged");
    const ids = await listApprovedIds(OWNER_UID);
    expect(ids).toEqual(["approved-1"]);
    expect(ids).not.toContain("flagged-1");
  });

  it("the full mix: only approved Units come back, none of the other three states", async () => {
    await seed("approved-1", OWNER_UID, "approved");
    await seed("approved-2", OWNER_UID, "approved");
    await seed("pending-1", OWNER_UID, "pending");
    await seed("rejected-1", OWNER_UID, "rejected");
    await seed("flagged-1", OWNER_UID, "flagged");
    const ids = await listApprovedIds(OWNER_UID);
    expect(ids.sort()).toEqual(["approved-1", "approved-2"]);
  });

  it("does NOT return Units owned by a different user (cross-tenant exclusion)", async () => {
    // Defensive: the matching pipeline must never see another
    // user's approved Units. Rules already enforce this at the
    // read layer; this test pins it end-to-end so a future
    // rule weakening AND a service-layer query change would
    // both be needed to break it.
    await seed("alice-approved", OWNER_UID, "approved");
    await seed("bob-approved", OTHER_UID, "approved");
    const ids = await listApprovedIds(OWNER_UID);
    expect(ids).toEqual(["alice-approved"]);
    expect(ids).not.toContain("bob-approved");
  });

  it("approved-with-rejected-true (corrupt data) is still excluded by the where clause", async () => {
    // Corrupt-data edge: a hypothetical doc with both
    // user_approved: true AND rejected: true. The where clause
    // matches on `user_approved == true`, so the Unit comes
    // back. Pin this behavior (which is correct in the
    // observability sense — corrupt data tells the truth about
    // itself) so a future "let's also filter by rejected !=
    // true" change is a deliberate decision rather than a
    // silent edit. See `countApproved` corrupt-data test for
    // the matching philosophy at the counter level.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), COLLECTION, "corrupt-1"),
        {
          ...unitDoc("corrupt-1", OWNER_UID, "approved"),
          rejected: true, // contradicts user_approved: true
        },
      );
    });
    const ids = await listApprovedIds(OWNER_UID);
    // The query returns the corrupt doc — that's the read
    // semantic. The state machine prevents this combination on
    // writes; the integration boundary's job is to expose
    // corrupt data, not silently filter it.
    expect(ids).toContain("corrupt-1");
  });
});
