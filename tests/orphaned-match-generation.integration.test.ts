/**
 * JD re-parse orphan integration test (#442).
 *
 * The hazard, found by `nathanpayne-codex` during the Phase 4b
 * review of #438 and pre-existing on `main`:
 *
 * A JD re-parse replaces a Role's `JobRequirementUnit` documents
 * under **new ids** (`parsing/pipeline.ts` clear-and-replace)
 * before matching runs. `RoleDetail` fires `runMatching`
 * immediately afterwards to close that window — but if that call
 * fails or never happens (a timeout, a transient callable error,
 * the user closing the tab), the old `UnitMatch` rows survive
 * pointing at Requirement ids that no longer exist.
 *
 * Those rows keep `approved_for_use`, and generation's
 * eligibility gate read only `experience_unit_id`. So a stranded
 * match still made its Unit eligible to ground a resume — against
 * a Requirement the employer's job description no longer
 * contains. A zero-fabrication violation reached through stale
 * data rather than a bad model output, which is why it survived
 * every other guard in the pipeline.
 *
 * This test reproduces the sequence the issue's acceptance
 * criteria name — re-parse, no rematch, then generate — with the
 * REAL clear-and-replace persist against the emulator rather than
 * a hand-seeded approximation of its result. Only the LLM and the
 * embedding call are stubbed, because neither is what is under
 * test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getAdminDb,
  initializeAdminAppForTests,
} from "../functions/src/firestore/admin.ts";
import { runGenerationPipeline } from "../functions/src/generation/pipeline.ts";
import {
  runGenerateResume,
  GenerateResumeGroundingStale,
} from "../functions/src/generation/runGenerateResume.ts";
import { GenerationNoApprovedUnitsError } from "../functions/src/generation/errors.ts";
import { runJdParsingPipeline } from "../functions/src/parsing/pipeline.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../functions/src/types/capability.ts";

const PROJECT_ID = "matchline-orphan-generation-test";
const ALICE = "user-alice";
const ROLE = "role-1";
const APP = "app-1";

const COLLECTIONS = [
  "roles",
  "applications",
  "experienceUnits",
  "jobRequirementUnits",
  "unitMatches",
] as const;

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "orphaned-match-generation.integration.test.ts must run under " +
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
    embedding: [1, 0],
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function requirement(
  id: string,
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  return {
    id,
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
    embedding: [1, 0],
    ...overrides,
  };
}

function match(requirementId: string): UnitMatch {
  return {
    id: "match-1",
    owner_uid: ALICE,
    experience_unit_id: "unit-1",
    job_requirement_unit_id: requirementId,
    role_id: ROLE,
    semantic_score: 0.9,
    rule_score: 0.8,
    final_score: 0.85,
    components: {
      semantic_similarity: 0.9,
      skill_overlap: 1,
      domain_overlap: 0.5,
      tool_overlap: 0.5,
      seniority_alignment: 1,
      scope_alignment: 1,
      recency: 1,
    },
    structural_evidence: true,
    rationale: "Matched on skill overlap.",
    surface_evidence: "product strategy",
    // The user approved it, which is what makes the orphan
    // dangerous rather than merely untidy.
    approved_for_use: true,
    user_rejected: false,
    created_at: "2024-01-01T00:00:00.000Z",
  };
}

async function seedRoleWithApprovedMatch(): Promise<void> {
  const batch = db().batch();
  batch.set(db().collection("roles").doc(ROLE), {
    id: ROLE,
    owner_uid: ALICE,
    title: "Staff PM",
  });
  batch.set(db().collection("applications").doc(APP), {
    id: APP,
    owner_uid: ALICE,
    role_id: ROLE,
    approved_unit_ids: ["unit-1"],
  });
  batch.set(db().collection("experienceUnits").doc("unit-1"), unit());
  batch.set(
    db().collection("jobRequirementUnits").doc("req-old"),
    requirement("req-old"),
  );
  batch.set(db().collection("unitMatches").doc("match-1"), match("req-old"));
  await batch.commit();
}

/**
 * Re-parse the JD with the REAL clear-and-replace persist, and no
 * rematch afterwards — the exact failure the issue describes.
 * Only `parse` and `embed` are stubbed.
 */
async function reparseWithoutRematch(): Promise<void> {
  await runJdParsingPipeline("a new job description", {
    ownerUid: ALICE,
    roleId: ROLE,
  }, {
    parse: async () => [requirement("req-new")],
    embed: async () => [[1, 0]],
  });
}

/**
 * A minimal well-formed tool-use response grounding the summary
 * on unit-1 — enough to clear schema validation and
 * cross-validation so the run reaches the persist transaction,
 * which is what these tests are about.
 */
function mockResumeMessage(): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "emit_resume",
        input: {
          summary: { text: "Summary", source_unit_ids: ["unit-1"] },
          bullets: [],
          skills: [],
        },
      },
    ],
  };
}

/** A client that must never be called. */
const explodingClient = {
  messages: {
    create: async () => {
      throw new Error(
        "LLM called: generation should have short-circuited on the " +
          "stranded-match gate before reaching the model.",
      );
    },
  },
} as never;

describe("JD re-parse without a rematch (#442)", () => {
  it("really does strand the approved match", async () => {
    // Establishes the precondition against the real persist
    // rather than assuming it. If the parsing pipeline ever stops
    // replacing ids, this assertion is what will say so.
    await seedRoleWithApprovedMatch();
    await reparseWithoutRematch();

    const reqs = await db().collection("jobRequirementUnits").get();
    expect(reqs.docs.map((d) => d.id)).toEqual(["req-new"]);

    const matches = await db().collection("unitMatches").get();
    expect(matches.docs).toHaveLength(1);
    expect(matches.docs[0].data().job_requirement_unit_id).toBe("req-old");
    // Still approved: the row is live input to generation.
    expect(matches.docs[0].data().approved_for_use).toBe(true);
  });

  it("does not let the stranded match ground a generated resume", async () => {
    await seedRoleWithApprovedMatch();
    await reparseWithoutRematch();

    let thrown: unknown;
    try {
      await runGenerationPipeline(
        { ownerUid: ALICE, applicationId: APP },
        { client: explodingClient, record: async () => 0 },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GenerationNoApprovedUnitsError);
  });

  it("tells the user to re-run matching, not to approve a match", async () => {
    // The user already approved one. "Approve at least one match"
    // sends them looking for something that is not there; the
    // actual remedy is a rematch against the new Requirements.
    await seedRoleWithApprovedMatch();
    await reparseWithoutRematch();

    let message = "";
    try {
      await runGenerationPipeline(
        { ownerUid: ALICE, applicationId: APP },
        { client: explodingClient, record: async () => 0 },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("no longer exists");
    expect(message).toContain("re-run matching");
    expect(message).not.toContain("Approve at least one match");
  });

  it("writes nothing while refusing — the orphan is left for the rematch", async () => {
    // The gate is a read-side refusal, not a cleanup. Deleting
    // the row here would discard the user's approval decision on
    // a Unit that may well match the new Requirement once
    // matching runs.
    await seedRoleWithApprovedMatch();
    await reparseWithoutRematch();

    const before = JSON.stringify(
      (await db().collection("unitMatches").get()).docs.map((d) => d.data()),
    );
    try {
      await runGenerationPipeline(
        { ownerUid: ALICE, applicationId: APP },
        { client: explodingClient, record: async () => 0 },
      );
    } catch {
      // expected
    }
    const after = JSON.stringify(
      (await db().collection("unitMatches").get()).docs.map((d) => d.data()),
    );

    expect(after).toBe(before);
  });
});

describe("the same Role once matching has been re-run (#442)", () => {
  it("generates normally when the match points at a current Requirement", async () => {
    // The control. Without it, a gate that rejected EVERYTHING
    // would pass every test above.
    await seedRoleWithApprovedMatch();
    await reparseWithoutRematch();
    // Stand in for the rematch: repoint the approved match at the
    // Requirement the re-parse created.
    await db()
      .collection("unitMatches")
      .doc("match-1")
      .set(match("req-new"));

    let reachedModel = false;
    const client = {
      messages: {
        create: async () => {
          reachedModel = true;
          throw new Error("stop here — the gate is what is under test");
        },
      },
    } as never;

    try {
      await runGenerationPipeline(
        { ownerUid: ALICE, applicationId: APP },
        { client, record: async () => 0, sleep: async () => {} },
      );
    } catch {
      // The stub throws; we only care that the gate let us past.
    }

    expect(reachedModel).toBe(true);
  });
});

describe("a re-parse that lands DURING generation (#442, Codex P1 on #449)", () => {
  // `defaultLoadInputs` reads Requirements and matches through
  // plain parallel queries, so the eligibility gate can approve
  // grounding that evaporates before the artifact is written —
  // and the window is the entire LLM call, minutes wide. A second
  // tab or a direct callable invocation is enough to hit it.
  //
  // The persist transaction re-reads the same query set, so this
  // is a real serialization against `writeRequirementsAsBatch`
  // rather than a narrowed window.
  it("refuses to persist an artifact whose grounding evaporated mid-flight", async () => {
    await seedRoleWithApprovedMatch();

    let thrown: unknown;
    try {
      await runGenerateResume(
        { ownerUid: ALICE, applicationId: APP },
        {
          record: async () => 0,
          generateId: () => "asset-1",
          sleep: async () => {},
          // Stand in for the LLM. The re-parse happens HERE —
          // after `loadInputs` has read the old Requirements and
          // passed the gate, before the persist transaction runs.
          client: {
            messages: {
              create: async () => {
                await reparseWithoutRematch();
                return mockResumeMessage();
              },
            },
          } as never,
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GenerateResumeGroundingStale);
  });

  it("writes no asset when it refuses", async () => {
    await seedRoleWithApprovedMatch();
    try {
      await runGenerateResume(
        { ownerUid: ALICE, applicationId: APP },
        {
          record: async () => 0,
          generateId: () => "asset-1",
          sleep: async () => {},
          client: {
            messages: {
              create: async () => {
                await reparseWithoutRematch();
                return mockResumeMessage();
              },
            },
          } as never,
        },
      );
    } catch {
      // expected
    }

    const app = await db().collection("applications").doc(APP).get();
    expect(app.data()?.generated_assets ?? []).toEqual([]);
  });

  it("persists normally when no re-parse intervenes", async () => {
    // The control. A revalidation that rejected everything would
    // satisfy both tests above.
    await seedRoleWithApprovedMatch();

    await runGenerateResume(
      { ownerUid: ALICE, applicationId: APP },
      {
        record: async () => 0,
        generateId: () => "asset-1",
        sleep: async () => {},
        client: {
          messages: { create: async () => mockResumeMessage() },
        } as never,
      },
    );

    const app = await db().collection("applications").doc(APP).get();
    const assets = app.data()?.generated_assets ?? [];
    expect(assets).toHaveLength(1);
    expect(assets[0].id).toBe("asset-1");
  });
});

describe("a re-parse followed by a fresh approval mid-generation (#442, Codex P1 round 2)", () => {
  // The hole the cited-grounding check alone could not see.
  //
  // `findStaleGroundingId` reduces both sides to Unit ids, so if
  // a re-parse lands mid-generation AND the user approves a
  // newly-computed match for the same Unit, the citation looks
  // live again — while the artifact in hand was written for
  // requirements that no longer exist. Only an identity check on
  // the Requirement SET catches that.
  it("refuses even when the cited Unit is grounded again by a NEW requirement", async () => {
    await seedRoleWithApprovedMatch();

    let thrown: unknown;
    try {
      await runGenerateResume(
        { ownerUid: ALICE, applicationId: APP },
        {
          record: async () => 0,
          generateId: () => "asset-1",
          sleep: async () => {},
          client: {
            messages: {
              create: async () => {
                // Re-parse, then approve a fresh match for the
                // SAME Unit against the new Requirement.
                await reparseWithoutRematch();
                await db()
                  .collection("unitMatches")
                  .doc("match-2")
                  .set({ ...match("req-new"), id: "match-2" });
                return mockResumeMessage();
              },
            },
          } as never,
        },
      );
    } catch (err) {
      thrown = err;
    }

    // The cited Unit IS grounded — by a requirement the prompt
    // never saw. The set token is what rejects it.
    expect(thrown).toBeInstanceOf(GenerateResumeGroundingStale);
    const app = await db().collection("applications").doc(APP).get();
    expect(app.data()?.generated_assets ?? []).toEqual([]);
  });

  it("still persists when the Requirement set is untouched", async () => {
    // Control: approving an ADDITIONAL match for the same Unit,
    // without any re-parse, must not trip the identity check.
    await seedRoleWithApprovedMatch();

    await runGenerateResume(
      { ownerUid: ALICE, applicationId: APP },
      {
        record: async () => 0,
        generateId: () => "asset-1",
        sleep: async () => {},
        client: {
          messages: {
            create: async () => {
              await db()
                .collection("unitMatches")
                .doc("match-2")
                .set({ ...match("req-old"), id: "match-2" });
              return mockResumeMessage();
            },
          },
        } as never,
      },
    );

    const app = await db().collection("applications").doc(APP).get();
    expect(app.data()?.generated_assets ?? []).toHaveLength(1);
  });
});
