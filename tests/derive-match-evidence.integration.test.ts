/**
 * Read-only evidence derivation integration test (#441).
 *
 * The worst standards finding against #438 was that it
 * introduced a distributed persistence lifecycle with **no
 * emulator coverage at all**. This is the answer to that, and
 * the assertions are chosen to pin the properties that #438
 * violated rather than merely to exercise the happy path:
 *
 *   1. **Nothing is written.** Every document in every touched
 *      collection is byte-compared before and after the call.
 *      #438 lost the user's approval decisions; a read-only
 *      module has to prove it cannot.
 *   2. **Ownership scoping.** Another user's Units and matches
 *      under the same role_id are invisible to the derivation.
 *      The admin SDK bypasses `firestore.rules`, so the query
 *      scoping is the only boundary.
 *   3. **The orphaned Requirement.** Named in the acceptance
 *      criteria: a match pointing at a Requirement id that no
 *      longer exists must resolve to `unverifiable`, never to a
 *      silent pass or a silent fail. This is #442's failure mode
 *      seen from the read side.
 *   4. **The pipeline-refuses-to-score cases** —
 *      `reembed_pending` and unapproved Units — resolve to
 *      `unverifiable` too, which requires the read to be
 *      UNFILTERED where the matching pipeline's is filtered.
 *      A copy-paste of `defaultListUnits` would report these as
 *      `unit_missing`, and the test distinguishes the reasons
 *      precisely so that mistake cannot pass.
 *
 * Runs against the Firestore emulator (`npm run test:rules`
 * harness), using the firebase-admin SDK for the same reason as
 * `matching-replace.integration.test.ts`: that is what the code
 * under test uses.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getAdminDb,
  initializeAdminAppForTests,
} from "../functions/src/firestore/admin.ts";
import { readAndDeriveEvidence } from "../functions/src/matching/evidence-read.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../functions/src/types/capability.ts";

const PROJECT_ID = "matchline-derive-evidence-test";
const ALICE = "user-alice";
const BOB = "user-bob";
const ROLE = "role-1";

const COLLECTIONS = [
  "roles",
  "experienceUnits",
  "jobRequirementUnits",
  "unitMatches",
] as const;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "derive-match-evidence.integration.test.ts must run under " +
        "`firebase emulators:exec` — FIRESTORE_EMULATOR_HOST not set.",
    );
  }
  initializeAdminAppForTests(PROJECT_ID);
});

afterAll(async () => {
  // See matching-replace.integration.test.ts: the admin app
  // handle is process-scoped and deliberately not torn down.
});

const db = (): ReturnType<typeof getAdminDb> => getAdminDb();

beforeEach(async () => {
  for (const col of COLLECTIONS) {
    const snap = await db().collection(col).get();
    const batch = db().batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  }
});

function unit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: "unit-1",
    owner_uid: ALICE,
    source_type: "resume",
    source_ref: "ref",
    raw_text: "raw",
    normalized_summary: "Led product strategy for the creator platform",
    unit_type: "project",
    skills: ["Product Strategy"],
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
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function requirement(
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  return {
    id: "req-1",
    owner_uid: ALICE,
    role_id: ROLE,
    raw_text: "Product strategy experience",
    normalized_requirement: "Product strategy experience",
    category: "skill",
    keywords: ["product strategy"],
    tools: [],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
    embedding: [1, 0, 0],
    ...overrides,
  };
}

/** A legacy row: scored before `structural_evidence` existed. */
function match(overrides: Partial<UnitMatch> = {}): UnitMatch {
  return {
    id: "match-1",
    owner_uid: ALICE,
    experience_unit_id: "unit-1",
    job_requirement_unit_id: "req-1",
    role_id: ROLE,
    semantic_score: 0.9,
    rule_score: 0.5,
    final_score: 0.7,
    components: {
      semantic_similarity: 0.9,
      skill_overlap: 0.5,
      domain_overlap: 0.5,
      tool_overlap: 0.5,
      seniority_alignment: 1,
      scope_alignment: 1,
      recency: 1,
    },
    rationale: "Matched on skill overlap.",
    surface_evidence: "product strategy",
    approved_for_use: true,
    user_rejected: false,
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seed(input: {
  readonly units?: readonly ExperienceUnit[];
  readonly requirements?: readonly JobRequirementUnit[];
  readonly matches?: readonly UnitMatch[];
}): Promise<void> {
  const batch = db().batch();
  batch.set(db().collection("roles").doc(ROLE), {
    id: ROLE,
    owner_uid: ALICE,
    title: "Staff PM",
  });
  for (const u of input.units ?? []) {
    batch.set(db().collection("experienceUnits").doc(u.id), u);
  }
  for (const r of input.requirements ?? []) {
    batch.set(db().collection("jobRequirementUnits").doc(r.id), r);
  }
  for (const m of input.matches ?? []) {
    batch.set(db().collection("unitMatches").doc(m.id), m);
  }
  await batch.commit();
}

/**
 * A stable, order-independent snapshot of everything the
 * derivation can see. Compared before and after the call to
 * prove the read path is a read path.
 */
async function snapshotAll(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const col of COLLECTIONS) {
    const snap = await db().collection(col).get();
    out[col] = snap.docs
      .map((d) => [d.id, d.data()] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }
  return JSON.stringify(out);
}

describe("readAndDeriveEvidence: writes nothing", () => {
  it("leaves every document byte-identical, approval flags included", async () => {
    await seed({
      units: [unit(), unit({ id: "unit-2", skills: ["Woodworking"] })],
      requirements: [requirement()],
      matches: [
        match(),
        match({
          id: "match-2",
          experience_unit_id: "unit-2",
          approved_for_use: false,
          user_rejected: true,
        }),
      ],
    });

    const before = await snapshotAll();
    await readAndDeriveEvidence({ ownerUid: ALICE, roleId: ROLE });
    const after = await snapshotAll();

    expect(after).toBe(before);
  });

  it("preserves match ids rather than re-creating rows", async () => {
    // #438 clear-and-replaced under fresh document ids, which is
    // what discarded the user's approval decisions. Pinning the
    // ids is the cheapest possible guard against that shape
    // returning.
    await seed({
      units: [unit()],
      requirements: [requirement()],
      matches: [match()],
    });
    await readAndDeriveEvidence({ ownerUid: ALICE, roleId: ROLE });
    const snap = await db().collection("unitMatches").get();
    expect(snap.docs.map((d) => d.id)).toEqual(["match-1"]);
    expect(snap.docs[0].data().approved_for_use).toBe(true);
  });
});

describe("readAndDeriveEvidence: verdicts", () => {
  it("derives evidence for a legacy row whose pair really overlaps", async () => {
    await seed({
      units: [unit()],
      requirements: [requirement()],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")).toEqual({
      verdict: "evidenced",
      stored: false,
    });
  });

  it("derives NO evidence when the Requirement constrains nothing evaluable", async () => {
    await seed({
      units: [unit()],
      requirements: [
        requirement({
          keywords: [],
          raw_text: "BS in Computer Science required",
        }),
      ],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.verdict).toBe("unevidenced");
  });

  it("reports an orphaned Requirement id as unverifiable", async () => {
    // The acceptance criterion, and #442's failure mode from the
    // read side: a JD re-parse replaces Requirement ids and
    // strands every match that pointed at the old ones.
    await seed({
      units: [unit()],
      requirements: [requirement({ id: "req-new" })],
      matches: [match({ job_requirement_unit_id: "req-old" })],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")).toEqual({
      verdict: "unverifiable",
      reason: "requirement_missing",
      stored: false,
    });
  });

  it("reports a deleted Unit as unverifiable", async () => {
    await seed({
      requirements: [requirement()],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.reason).toBe("unit_missing");
  });

  it("distinguishes a reembed_pending Unit from a missing one", async () => {
    // Requires the Units read to be UNFILTERED. The matching
    // pipeline's `defaultListUnits` drops these rows; copying it
    // here would report `unit_missing` and lose the distinction
    // between "gone" and "present but unscoreable".
    await seed({
      units: [unit({ reembed_pending: true })],
      requirements: [requirement()],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.reason).toBe("unit_reembed_pending");
  });

  it("distinguishes an unapproved Unit from a missing one", async () => {
    await seed({
      units: [unit({ user_approved: false })],
      requirements: [requirement()],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.reason).toBe("unit_unapproved");
  });

  it("reports a Unit with no usable embedding as unverifiable", async () => {
    // `runMatchingPipeline` skips a pair when either side has no
    // vector, so claiming `evidenced` here would let a must-have
    // read as covered by a match an explicit rematch removes.
    await seed({
      units: [unit({ embedding: [] })],
      requirements: [requirement()],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.reason).toBe("unit_embedding_missing");
  });

  it("reports a Requirement with no usable embedding as unverifiable", async () => {
    await seed({
      units: [unit()],
      requirements: [requirement({ embedding: [] })],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.reason).toBe("requirement_embedding_missing");
  });

  it("reports mismatched embedding dimensions as unverifiable", async () => {
    await seed({
      units: [unit({ embedding: [1, 0, 0] })],
      requirements: [requirement({ embedding: [1, 0] })],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.reason).toBe("embedding_dimension_mismatch");
  });

  it("returns a stored verdict without re-deriving it", async () => {
    await seed({
      units: [unit({ skills: ["Woodworking"] })],
      requirements: [requirement()],
      matches: [match({ structural_evidence: true })],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    // Derivation would say `unevidenced` for this pair; the
    // persisted judgement wins.
    expect(out.get("match-1")).toEqual({
      verdict: "evidenced",
      stored: true,
    });
  });
});

describe("readAndDeriveEvidence: ownership scoping", () => {
  it("never reads another owner's matches under the same role_id", async () => {
    await seed({
      units: [unit()],
      requirements: [requirement()],
      matches: [match()],
    });
    await db()
      .collection("unitMatches")
      .doc("bob-match")
      .set(match({ id: "bob-match", owner_uid: BOB }));

    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect([...out.keys()]).toEqual(["match-1"]);
  });

  it("does not resolve Alice's match against Bob's Unit of the same id", async () => {
    // Both cross-tenant halves in one assertion: if the Units
    // query were unscoped, Bob's document would satisfy Alice's
    // match and report `evidenced` instead of `unit_missing`.
    await seed({
      requirements: [requirement()],
      matches: [match()],
    });
    await db()
      .collection("experienceUnits")
      .doc("unit-1")
      .set(unit({ owner_uid: BOB }));

    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.reason).toBe("unit_missing");
  });

  it("ignores Requirements belonging to a different Role", async () => {
    await seed({
      units: [unit()],
      requirements: [requirement({ role_id: "role-other" })],
      matches: [match()],
    });
    const out = await readAndDeriveEvidence({
      ownerUid: ALICE,
      roleId: ROLE,
    });
    expect(out.get("match-1")?.reason).toBe("requirement_missing");
  });
});
