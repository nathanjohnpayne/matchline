/**
 * Generation persistence integration test (sub-issue #121 of
 * #22). Pins the load-bearing invariants the orchestrator
 * relies on:
 *
 *   1. **Persist shape**: a successful generation lands as an
 *      AssetRef with `validation_status: "pending"`,
 *      server-stamped ids on every fact-bearing item, and
 *      cost/latency telemetry populated. The editor surface
 *      (#24) calls `validateAsset` (#109) next to flip the
 *      status.
 *
 *   2. **Cross-tenant safety**: Bob's call against Alice's
 *      `applicationId` collapses to the same anti-enumeration
 *      shape as a missing-application error AND Alice's
 *      persisted state is unchanged (no spurious AssetRef).
 *
 *   3. **Empty-Units edge**: an Application with no approved
 *      Units short-circuits before any LLM call AND no
 *      AssetRef is persisted. Mirror of the
 *      `GenerationNoApprovedUnitsError` gate at the pipeline
 *      level (#120).
 *
 *   4. **Approved-but-unmatched edge**: an Application with
 *      approved Units but no approved matches for the Role
 *      throws the same error class with a distinguishing
 *      message — the editor surface uses this to differentiate
 *      "approve some Units" from "approve a match in the
 *      Matches tab."
 *
 * Runs against the Firestore emulator (`npm run test:rules`
 * harness). Uses the firebase-admin SDK directly — same shape
 * as the matching-replace + validation-fabrication integration
 * tests (#99 / #109).
 *
 * The Anthropic LLM call is mocked via the pipeline's `client`
 * dep (see runGenerateResume's `RunGenerateResumeDeps`). The
 * integration boundary under test is FIRESTORE — the LLM
 * boundary is unit-tested in `functions/src/generation/
 * pipeline.test.ts` (#120).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getAdminDb,
  initializeAdminAppForTests,
} from "../functions/src/firestore/admin.ts";
import {
  GenerationApplicationNotFound,
  GenerationNoApprovedUnitsError,
} from "../functions/src/generation/pipeline.ts";
import type { AnthropicClient as Anthropic } from "../functions/src/llm/anthropic.ts";
import { runGenerateResume } from "../functions/src/generation/runGenerateResume.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../functions/src/types/capability.ts";
import type {
  AssetRef,
  Role,
} from "../functions/src/types/crm.ts";

const PROJECT_ID = "matchline-generation-persistence-test";
const ALICE = "user-alice";
const BOB = "user-bob";

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "generation-persistence.integration.test.ts must run under " +
        "`firebase emulators:exec` — FIRESTORE_EMULATOR_HOST not set.",
    );
  }
  initializeAdminAppForTests(PROJECT_ID);
});

afterAll(async () => {
  // No deleteApp — same rationale as
  // matching-replace.integration.test.ts (functions-package
  // singleton, process-scoped).
});

const db = (): ReturnType<typeof getAdminDb> => getAdminDb();

beforeEach(async () => {
  for (const col of [
    "applications",
    "experienceUnits",
    "roles",
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

async function seedUnit(
  id: string,
  ownerUid: string,
  rawText: string,
): Promise<ExperienceUnit> {
  const unit: ExperienceUnit = {
    id,
    owner_uid: ownerUid,
    source_type: "resume",
    source_ref: "ref",
    raw_text: rawText,
    normalized_summary: rawText,
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  await db().collection("experienceUnits").doc(id).set(unit);
  return unit;
}

async function seedRole(roleId: string, ownerUid: string): Promise<Role> {
  const role: Role = {
    id: roleId,
    owner_uid: ownerUid,
    company_id: "company-1",
    title: "Senior Product Manager",
    jd_raw: "Build great things.",
    discovered_at: "2026-01-01T00:00:00.000Z",
  };
  await db().collection("roles").doc(roleId).set(role);
  return role;
}

async function seedRequirement(
  reqId: string,
  ownerUid: string,
  roleId: string,
): Promise<JobRequirementUnit> {
  // Canonical JobRequirementUnit shape (matches
  // `functions/src/types/capability.ts` exactly). Codex P2
  // round 1 on PR #124 caught a prior version that used
  // non-canonical fields (`text`, `priority: "must_have"`,
  // free-form `extracted_from`) — the test passed because the
  // pipeline's prompt formatter reads `normalized_requirement`
  // and the LLM was mocked, so the request shape didn't affect
  // assertions. Pinning the real schema here makes the test
  // catch a future regression in requirement-loading.
  const req: JobRequirementUnit = {
    id: reqId,
    owner_uid: ownerUid,
    role_id: roleId,
    raw_text: "Ship a 0→1 product",
    normalized_requirement: "Ship a new product end-to-end",
    category: "domain",
    keywords: [],
    tools: [],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
  };
  await db().collection("jobRequirementUnits").doc(reqId).set(req);
  return req;
}

async function seedMatch(
  matchId: string,
  ownerUid: string,
  roleId: string,
  experienceUnitId: string,
  requirementId: string,
): Promise<UnitMatch> {
  const match: UnitMatch = {
    id: matchId,
    owner_uid: ownerUid,
    role_id: roleId,
    experience_unit_id: experienceUnitId,
    job_requirement_unit_id: requirementId,
    semantic_score: 0.8,
    rule_score: 0.7,
    final_score: 0.75,
    rationale: "supports",
    surface_evidence: "evidence",
    approved_for_use: true,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  await db().collection("unitMatches").doc(matchId).set(match);
  return match;
}

async function seedApplication(
  applicationId: string,
  ownerUid: string,
  roleId: string,
  approvedUnitIds: readonly string[],
  generatedAssets: readonly AssetRef[] = [],
): Promise<void> {
  await db()
    .collection("applications")
    .doc(applicationId)
    .set({
      id: applicationId,
      owner_uid: ownerUid,
      role_id: roleId,
      stage: "drafting",
      last_activity_at: "2026-01-01T00:00:00.000Z",
      generated_assets: generatedAssets,
      approved_unit_ids: approvedUnitIds,
    });
}

// -- LLM mock ---------------------------------------------------------------

/**
 * Build a mocked Anthropic client whose `messages.create`
 * always returns the supplied tool_use input. Mirrors the
 * shape of the unit-test mock (`functions/src/generation/
 * pipeline.test.ts`) but with smaller usage numbers (we
 * don't care about token-accumulation precision here, just
 * that the field is populated > 0).
 */
function makeMockClient(toolInput: unknown): Anthropic {
  return {
    messages: {
      create: async () => ({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [
          {
            type: "tool_use",
            id: "toolu_test",
            name: "record_resume",
            input: toolInput,
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 500, output_tokens: 200 },
      }),
    },
  } as unknown as Anthropic;
}

const VALID_LLM_RESPONSE = {
  summary: { text: "Senior PM with 0→1 grounding.", source_unit_ids: ["u1"] },
  bullets: [
    {
      text: "Shipped a new product end-to-end.",
      source_unit_ids: ["u1"],
    },
  ],
  skills: [
    {
      text: "Product Strategy",
      source_unit_ids: ["u1"],
    },
  ],
};

// -- Tests ------------------------------------------------------------------

describe("generateResume — Firestore integration", () => {
  it("PERSIST: successful generation lands as AssetRef with validation_status=pending + cost/latency populated", async () => {
    await seedRole("role-1", ALICE);
    await seedRequirement("req-1", ALICE, "role-1");
    await seedUnit("u1", ALICE, "Shipped a new product.");
    await seedMatch("m1", ALICE, "role-1", "u1", "req-1");
    await seedApplication("app-1", ALICE, "role-1", ["u1"]);

    const result = await runGenerateResume(
      { ownerUid: ALICE, applicationId: "app-1" },
      {
        client: makeMockClient(VALID_LLM_RESPONSE),
        record: async () => 0,
        generateId: () => "deterministic-asset-id",
        now: () => "2026-04-26T04:30:00.000Z",
      },
    );

    expect(result.assetId).toBe("deterministic-asset-id");
    expect(result.applicationId).toBe("app-1");
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(result.input_tokens).toBe(500);
    expect(result.output_tokens).toBe(200);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);

    // Read back the persisted state and pin every field the
    // editor surface (#24) reads.
    const snap = await db().collection("applications").doc("app-1").get();
    const app = snap.data() as {
      generated_assets: AssetRef[];
      last_activity_at: string;
    };
    expect(app.generated_assets).toHaveLength(1);
    const persisted = app.generated_assets[0]!;
    expect(persisted.id).toBe("deterministic-asset-id");
    expect(persisted.owner_uid).toBe(ALICE);
    expect(persisted.application_id).toBe("app-1");
    expect(persisted.kind).toBe("resume");
    expect(persisted.format).toBe("json");
    expect(persisted.storage_path).toBe("");
    expect(persisted.validation_status).toBe("pending");
    expect(persisted.validation_flags).toBeUndefined();
    expect(persisted.validated_at).toBeUndefined();
    // Cost / latency persisted for per-app budget telemetry.
    expect(persisted.cost_usd).toBeGreaterThan(0);
    expect(persisted.input_tokens).toBe(500);
    expect(persisted.output_tokens).toBe(200);
    expect(persisted.latency_ms).toBeGreaterThanOrEqual(0);
    expect(persisted.created_at).toBe("2026-04-26T04:30:00.000Z");
    // Server-stamped ids on every fact-bearing item.
    expect(persisted.generated_content!.summary.id).toBeTruthy();
    expect(persisted.generated_content!.bullets[0]!.id).toBeTruthy();
    expect(persisted.generated_content!.skills[0]!.id).toBeTruthy();
    // last_activity_at bumped to the generation timestamp.
    expect(app.last_activity_at).toBe("2026-04-26T04:30:00.000Z");
  });

  it("APPEND: a second generation appends to generated_assets[] without clobbering the first", async () => {
    await seedRole("role-1", ALICE);
    await seedRequirement("req-1", ALICE, "role-1");
    await seedUnit("u1", ALICE, "Shipped a new product.");
    await seedMatch("m1", ALICE, "role-1", "u1", "req-1");
    await seedApplication("app-1", ALICE, "role-1", ["u1"]);

    let counter = 0;
    const deps = {
      client: makeMockClient(VALID_LLM_RESPONSE),
      record: async () => 0,
      generateId: () => `asset-${++counter}`,
      now: () => `2026-04-26T04:3${counter}:00.000Z`,
    };

    await runGenerateResume({ ownerUid: ALICE, applicationId: "app-1" }, deps);
    await runGenerateResume({ ownerUid: ALICE, applicationId: "app-1" }, deps);

    const snap = await db().collection("applications").doc("app-1").get();
    const app = snap.data() as { generated_assets: AssetRef[] };
    // counter increments inside `generateId` AND `now`, so each
    // call produces 4 unique ids (asset, summary, bullet,
    // skill) — but the OUTER assets[] should be 2 entries.
    const assetIds = app.generated_assets.map((a) => a.id);
    expect(assetIds.filter((id) => id.startsWith("asset-")).length).toBe(2);
  });

  it("CROSS-TENANT: Bob's call against Alice's applicationId throws GenerationApplicationNotFound; Alice's state unchanged (anti-enumeration)", async () => {
    await seedRole("role-1", ALICE);
    await seedRequirement("req-1", ALICE, "role-1");
    await seedUnit("u1", ALICE, "Alice's work.");
    await seedMatch("m1", ALICE, "role-1", "u1", "req-1");
    await seedApplication("app-1", ALICE, "role-1", ["u1"]);

    await expect(
      runGenerateResume(
        // Bob calls runGenerateResume on Alice's applicationId.
        { ownerUid: BOB, applicationId: "app-1" },
        {
          client: makeMockClient(VALID_LLM_RESPONSE),
          record: async () => 0,
          generateId: () => "should-not-be-used",
          now: () => "2026-04-26T04:30:00.000Z",
        },
      ),
    ).rejects.toBeInstanceOf(GenerationApplicationNotFound);

    // Critical: Alice's persisted state is unchanged. No
    // AssetRef stamped under Bob's call should land on Alice's
    // application.
    const snap = await db().collection("applications").doc("app-1").get();
    const app = snap.data() as { generated_assets: AssetRef[] };
    expect(app.generated_assets).toHaveLength(0);
  });

  it("EMPTY-UNITS: Application with no approved Units throws GenerationNoApprovedUnitsError; no AssetRef persisted", async () => {
    await seedRole("role-1", ALICE);
    await seedRequirement("req-1", ALICE, "role-1");
    // Note: no Units, no matches, empty approved_unit_ids.
    await seedApplication("app-1", ALICE, "role-1", []);

    let llmCalled = false;
    const client = {
      messages: {
        create: async () => {
          llmCalled = true;
          throw new Error("LLM should not have been called");
        },
      },
    } as unknown as Anthropic;

    await expect(
      runGenerateResume(
        { ownerUid: ALICE, applicationId: "app-1" },
        {
          client,
          record: async () => 0,
          generateId: () => "should-not-be-used",
          now: () => "2026-04-26T04:30:00.000Z",
        },
      ),
    ).rejects.toBeInstanceOf(GenerationNoApprovedUnitsError);

    expect(llmCalled).toBe(false);

    const snap = await db().collection("applications").doc("app-1").get();
    const app = snap.data() as { generated_assets: AssetRef[] };
    expect(app.generated_assets).toHaveLength(0);
  });

  it("APPROVED-BUT-UNMATCHED: Units approved but no approved matches → throws with distinguishing message; no LLM call; no AssetRef persisted", async () => {
    await seedRole("role-1", ALICE);
    await seedRequirement("req-1", ALICE, "role-1");
    await seedUnit("u1", ALICE, "Some work.");
    // Note: NO match seeded for u1, even though the
    // application approved it.
    await seedApplication("app-1", ALICE, "role-1", ["u1"]);

    let llmCalled = false;
    const client = {
      messages: {
        create: async () => {
          llmCalled = true;
          throw new Error("LLM should not have been called");
        },
      },
    } as unknown as Anthropic;

    let thrown: unknown;
    try {
      await runGenerateResume(
        { ownerUid: ALICE, applicationId: "app-1" },
        {
          client,
          record: async () => 0,
          generateId: () => "should-not-be-used",
          now: () => "2026-04-26T04:30:00.000Z",
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GenerationNoApprovedUnitsError);
    if (thrown instanceof Error) {
      // The pipeline's distinguishing message — used by the
      // editor surface (#24) to differentiate "approve some
      // Units" from "approve a match in the Matches tab."
      expect(thrown.message).toContain("Approved Units present");
      expect(thrown.message).toContain("no approved UnitMatches");
    }
    expect(llmCalled).toBe(false);

    const snap = await db().collection("applications").doc("app-1").get();
    const app = snap.data() as { generated_assets: AssetRef[] };
    expect(app.generated_assets).toHaveLength(0);
  });
});
