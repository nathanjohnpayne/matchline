/**
 * Validation orchestrator integration test (sub-issue #109 of
 * #23). Pins three load-bearing invariants against the real
 * Firestore emulator:
 *
 *   1. **Adversarial fixture (zero-fab pin)**: an asset whose
 *      bullet asserts content not present in any source Unit
 *      produces an `untraceable` flag and `validation_status:
 *      "failed"`. Export blocked.
 *
 *   2. **Clean fixture**: an asset where every claim traces
 *      cleanly produces 0 failure flags and
 *      `validation_status: "passed"`.
 *
 *   3. **Cross-tenant safety**: validateAsset called with
 *      another user's applicationId returns the same shape
 *      as a missing-application error (anti-enumeration).
 *
 * Runs against the Firestore emulator (`npm run test:rules`
 * harness). Uses the firebase-admin SDK directly — same shape
 * as the matching-replace integration test from #99.
 *
 * The traceability + specificity + claim-extraction LLM calls
 * are mocked via deps (the integration boundary is Firestore,
 * not the LLM API).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getAdminDb,
  initializeAdminAppForTests,
} from "../functions/src/firestore/admin.ts";
import {
  validateAsset,
  ValidateAssetNotFound,
} from "../functions/src/validation/validate.ts";
import type { ExperienceUnit } from "../functions/src/types/capability.ts";
import type {
  AssetRef,
  GeneratedAssetContent,
} from "../functions/src/types/crm.ts";

const PROJECT_ID = "matchline-validation-fabrication-test";
const ALICE = "user-alice";
const BOB = "user-bob";

// Mocks for the LLM-driven sub-checks. Same instance reused
// across tests; tests configure behavior via the `vi.fn`
// .mockImplementation() escape hatch when needed.

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "validation-fabrication.integration.test.ts must run under " +
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
  for (const col of ["applications", "experienceUnits"]) {
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

async function seedApplication(
  applicationId: string,
  ownerUid: string,
  asset: AssetRef,
): Promise<void> {
  await db()
    .collection("applications")
    .doc(applicationId)
    .set({
      id: applicationId,
      owner_uid: ownerUid,
      role_id: "role-1",
      stage: "drafting",
      last_activity_at: "2026-01-01T00:00:00.000Z",
      generated_assets: [asset],
      approved_unit_ids: asset.generated_content
        ? Array.from(
            new Set(
              asset.generated_content.experience.flatMap((s) =>
                s.bullets.flatMap((b) => b.source_unit_ids),
              ),
            ),
          )
        : [],
    });
}

function makeAsset(
  id: string,
  applicationId: string,
  ownerUid: string,
  content: GeneratedAssetContent,
): AssetRef {
  return {
    id,
    owner_uid: ownerUid,
    application_id: applicationId,
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: content,
    validation_status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

// -- Tests ------------------------------------------------------------------

describe("validateAsset — Firestore integration", () => {
  it("ADVERSARIAL: bullet asserts content NOT in any source Unit → untraceable flag + status=failed (zero-fab pin)", async () => {
    // Seed: a Unit about Disney+. The asset's bullet claims
    // Netflix work (fabricated) but cites the Disney+ Unit as
    // its source. The orchestrator must flag this.
    await seedUnit("u1", ALICE, "Worked on Disney+ playback memory.");
    const asset = makeAsset("asset-1", "app-1", ALICE, {
      summary: {
        id: "summary-1",
        text: "",
        source_unit_ids: [],
      },
      experience: [
        {
          title: "PM",
          company: "Disney",
          bullets: [
            {
              id: "b1",
              text: "Managed a team of 40 at Netflix.",
              source_unit_ids: ["u1"],
            },
          ],
        },
      ],
      skills: [],
    });
    await seedApplication("app-1", ALICE, asset);

    const result = await validateAsset(
      { ownerUid: ALICE, applicationId: "app-1", assetId: "asset-1" },
      {
        // Mock the LLM checks: claim extraction returns one
        // claim per bullet; traceability says NO support;
        // specificity isn't checked (short-circuit).
        extractClaims: async (bullet, ctx) => [
          {
            id: `${ctx.bulletId}-c1`,
            bullet_id: ctx.bulletId,
            text: bullet.text,
          },
        ],
        checkTraceability: async () => ({
          supports: false,
          rationale: "No Unit references Netflix.",
        }),
        checkSpecificity: async () => ({
          specific: true,
          rationale: "irrelevant",
        }),
      },
    );

    expect(result.status).toBe("failed");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]!.status).toBe("untraceable");

    // Read back from Firestore and verify the persisted state
    // matches the returned result. This pins the persist path.
    const snap = await db().collection("applications").doc("app-1").get();
    const persistedAsset = (
      snap.data() as { generated_assets: AssetRef[] }
    ).generated_assets.find((a) => a.id === "asset-1");
    expect(persistedAsset).toBeDefined();
    expect(persistedAsset!.validation_status).toBe("failed");
    expect(persistedAsset!.validation_flags).toHaveLength(1);
    expect(persistedAsset!.validation_flags![0]!.status).toBe("untraceable");
    expect(persistedAsset!.validated_at).toBeDefined();
  });

  it("CLEAN: every claim traces + is specific → status=passed, all flags traced", async () => {
    await seedUnit("u1", ALICE, "Reduced Disney+ playback memory 30%.");
    const asset = makeAsset("asset-1", "app-1", ALICE, {
      summary: { id: "summary-1", text: "", source_unit_ids: [] },
      experience: [
        {
          title: "PM",
          company: "Disney",
          bullets: [
            {
              id: "b1",
              text: "Reduced playback memory 30% on Disney+.",
              source_unit_ids: ["u1"],
            },
          ],
        },
      ],
      skills: [],
    });
    await seedApplication("app-1", ALICE, asset);

    const result = await validateAsset(
      { ownerUid: ALICE, applicationId: "app-1", assetId: "asset-1" },
      {
        extractClaims: async (bullet, ctx) => [
          {
            id: `${ctx.bulletId}-c1`,
            bullet_id: ctx.bulletId,
            text: bullet.text,
          },
        ],
        checkTraceability: async () => ({
          supports: true,
          supporting_unit_id: "u1",
          rationale: "Unit u1 supports the claim.",
        }),
        checkSpecificity: async () => ({
          specific: true,
          rationale: "Verifiable claim.",
        }),
      },
    );

    expect(result.status).toBe("passed");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]!.status).toBe("traced");
    expect(result.flags[0]!.supporting_unit_id).toBe("u1");

    // Persisted shape matches.
    const snap = await db().collection("applications").doc("app-1").get();
    const persistedAsset = (
      snap.data() as { generated_assets: AssetRef[] }
    ).generated_assets.find((a) => a.id === "asset-1");
    expect(persistedAsset!.validation_status).toBe("passed");
  });

  it("REPLACE-WHOLESALE: re-running validateAsset replaces the prior flag set + status", async () => {
    // Pin the wholesale-replace contract. First run: bullet
    // fabricates → status=failed. User edits the bullet (we
    // simulate by directly updating the asset's content), then
    // re-validates with new mock that returns supports=true.
    // The persisted state should reflect the SECOND run, not a
    // union.
    await seedUnit("u1", ALICE, "Reduced Disney+ playback memory 30%.");
    const initialAsset = makeAsset("asset-1", "app-1", ALICE, {
      summary: { id: "summary-1", text: "", source_unit_ids: [] },
      experience: [
        {
          title: "PM",
          company: "Disney",
          bullets: [
            {
              id: "b1",
              text: "Managed Netflix infra.",
              source_unit_ids: ["u1"],
            },
          ],
        },
      ],
      skills: [],
    });
    await seedApplication("app-1", ALICE, initialAsset);

    // Run 1: fabricated → failed.
    const run1 = await validateAsset(
      { ownerUid: ALICE, applicationId: "app-1", assetId: "asset-1" },
      {
        extractClaims: async (bullet, ctx) => [
          {
            id: `${ctx.bulletId}-c1`,
            bullet_id: ctx.bulletId,
            text: bullet.text,
          },
        ],
        checkTraceability: async () => ({
          supports: false,
          rationale: "No support.",
        }),
        checkSpecificity: async () => ({
          specific: true,
          rationale: "irrelevant",
        }),
      },
    );
    expect(run1.status).toBe("failed");

    // Run 2: same bullet, but mock returns support → passed.
    // The user edited the bullet to be accurate, but for test
    // simplicity we just change the mock's return.
    const run2 = await validateAsset(
      { ownerUid: ALICE, applicationId: "app-1", assetId: "asset-1" },
      {
        extractClaims: async (bullet, ctx) => [
          {
            id: `${ctx.bulletId}-c1`,
            bullet_id: ctx.bulletId,
            text: bullet.text,
          },
        ],
        checkTraceability: async () => ({
          supports: true,
          supporting_unit_id: "u1",
          rationale: "Now supports.",
        }),
        checkSpecificity: async () => ({
          specific: true,
          rationale: "Verifiable.",
        }),
      },
    );
    expect(run2.status).toBe("passed");

    // Persisted state reflects run 2 only — no leftover
    // run-1 untraceable flag.
    const snap = await db().collection("applications").doc("app-1").get();
    const persistedAsset = (
      snap.data() as { generated_assets: AssetRef[] }
    ).generated_assets.find((a) => a.id === "asset-1");
    expect(persistedAsset!.validation_status).toBe("passed");
    expect(persistedAsset!.validation_flags).toHaveLength(1);
    expect(persistedAsset!.validation_flags![0]!.status).toBe("traced");
  });

  it("CROSS-TENANT: Bob's call against Alice's applicationId throws ValidateAssetNotFound (anti-enumeration)", async () => {
    await seedUnit("u1", ALICE, "Alice's work.");
    const asset = makeAsset("asset-1", "app-1", ALICE, {
      summary: { id: "summary-1", text: "", source_unit_ids: [] },
      experience: [],
      skills: [],
    });
    await seedApplication("app-1", ALICE, asset);

    await expect(
      validateAsset(
        // Bob calls validateAsset on Alice's applicationId.
        { ownerUid: BOB, applicationId: "app-1", assetId: "asset-1" },
        {
          extractClaims: async () => [],
          checkTraceability: async () => ({
            supports: true,
            supporting_unit_id: "u1",
            rationale: "irrelevant",
          }),
          checkSpecificity: async () => ({
            specific: true,
            rationale: "irrelevant",
          }),
        },
      ),
    ).rejects.toBeInstanceOf(ValidateAssetNotFound);

    // Critical: Alice's persisted state is unchanged (no
    // accidental write happened).
    const snap = await db().collection("applications").doc("app-1").get();
    const persistedAsset = (
      snap.data() as { generated_assets: AssetRef[] }
    ).generated_assets.find((a) => a.id === "asset-1");
    expect(persistedAsset!.validation_status).toBe("pending");
    expect(persistedAsset!.validation_flags).toBeUndefined();
  });
});
