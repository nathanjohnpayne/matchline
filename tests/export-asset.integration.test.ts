/**
 * `exportAsset` integration test (#521), against the real Firestore
 * and Storage emulators (`npm run test:rules`).
 *
 * The unit tests (`functions/src/callables/exportAsset.test.ts`) stub
 * Firestore and Storage. This suite runs the handler with its DEFAULT
 * loaders and the admin SDK's Storage client, so it pins what stubs
 * cannot: the real attestation doc id and query shapes, the real
 * object path in a real bucket, overwrite on re-export, and the
 * emulator URL branch serving the exact rendered bytes.
 *
 * Validation itself is not run (it needs model calls); the passing
 * attestation is seeded the way `validateAsset` writes it, from
 * `assetContentVersion` and `unitEvidenceVersion`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exportAssetHandler,
  type ExportAssetData,
  type ExportAssetDeps,
} from "../functions/src/callables/exportAsset.ts";
import { renderPlainText } from "../functions/src/export/text.ts";
import { defaultExportBucket } from "../functions/src/export/storage.ts";
import { getAdminDb, initializeAdminAppForTests } from "../functions/src/firestore/admin.ts";
import type { ExperienceUnit } from "../functions/src/types/capability.ts";
import type { AssetRef, GeneratedAssetContent } from "../functions/src/types/crm.ts";
import {
  assetContentVersion,
  validationAttestationId,
  VALIDATIONS_SUBCOLLECTION,
  type ValidationAttestation,
} from "../functions/src/validation/attestation.ts";
import { unitEvidenceVersion } from "../functions/src/validation/unitEvidenceVersion.ts";

const PROJECT_ID = "matchline-export-asset-test";
const BUCKET = `${PROJECT_ID}.appspot.com`;
const ALICE = "user-alice";
const APP_ID = "app-1";
const EM = "—";

const deps: ExportAssetDeps = { bucket: () => defaultExportBucket(BUCKET) };
const db = (): ReturnType<typeof getAdminDb> => getAdminDb();

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error(
      "export-asset.integration.test.ts must run under `firebase emulators:exec --only firestore,storage` " +
        "(FIRESTORE_EMULATOR_HOST or FIREBASE_STORAGE_EMULATOR_HOST not set). Use `npm run test:rules`.",
    );
  }
  initializeAdminAppForTests(PROJECT_ID);
});

beforeEach(async () => {
  vi.stubEnv("MATCHLINE_OWNER_UIDS", ALICE);
  for (const col of ["applications", "experienceUnits", "roles", "companies"]) {
    await db().recursiveDelete(db().collection(col));
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// The root package has no firebase-functions install, so the request
// type comes from the handler itself.
type ExportRequest = Parameters<typeof exportAssetHandler>[0];

function request(data: ExportAssetData): ExportRequest {
  return {
    data,
    auth: { uid: ALICE, token: {} },
    rawRequest: {} as never,
    acceptsStreaming: false,
  } as unknown as ExportRequest;
}

function content(summary: string): GeneratedAssetContent {
  return {
    summary: { id: "s", text: summary, source_unit_ids: ["u1"] },
    bullets: [{ id: "b1", text: "Shipped `search` to 4M users → +12% retention.", source_unit_ids: ["u1"] }],
    skills: [{ id: "k1", text: "Roadmapping", source_unit_ids: [] }],
  };
}

function makeUnit(id: string): ExperienceUnit {
  return {
    id,
    owner_uid: ALICE,
    source_type: "resume",
    source_ref: "ref",
    raw_text: "Led search for 4M users.",
    normalized_summary: "Led search.",
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
}

function asset(id: string, c: GeneratedAssetContent): AssetRef {
  return {
    id,
    owner_uid: ALICE,
    application_id: APP_ID,
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: c,
    validation_status: "passed",
    created_at: "2026-10-29T00:00:00.000Z",
  };
}

/** Seed Role, Company, Unit, the Application and a passing attestation per asset. */
async function seed(assets: readonly AssetRef[]): Promise<void> {
  const unit = makeUnit("u1");
  await db().collection("experienceUnits").doc(unit.id).set(unit);
  await db().collection("companies").doc("co-1").set({ id: "co-1", owner_uid: ALICE, name: "Zürich Café" });
  await db().collection("roles").doc("role-1").set({ id: "role-1", owner_uid: ALICE, company_id: "co-1", title: "Senior PM" });
  await db().collection("applications").doc(APP_ID).set({
    id: APP_ID,
    owner_uid: ALICE,
    role_id: "role-1",
    stage: "drafting",
    last_activity_at: "2026-10-29T00:00:00.000Z",
    generated_assets: assets,
    approved_unit_ids: [],
  });
  for (const a of assets) {
    const version = assetContentVersion(a.generated_content);
    const attestation: ValidationAttestation = {
      owner_uid: ALICE,
      application_id: APP_ID,
      asset_id: a.id,
      content_version: version,
      status: "passed",
      validated_at: "2026-10-29T00:00:00.000Z",
      validated_unit_versions: { u1: unitEvidenceVersion(unit) },
    };
    await db()
      .collection("applications")
      .doc(APP_ID)
      .collection(VALIDATIONS_SUBCOLLECTION)
      .doc(validationAttestationId(a.id, version))
      .set(attestation);
  }
}

const emulatorBase = (): string => `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;

/** Object names under a prefix, via the emulator's JSON API. */
async function listObjects(prefix: string): Promise<string[]> {
  const res = await fetch(`${emulatorBase()}/storage/v1/b/${BUCKET}/o?prefix=${encodeURIComponent(prefix)}`);
  // A failed list must fail the test: an empty result has to mean "no object", not "the list broke".
  if (!res.ok) throw new Error(`Storage emulator list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items?: { name: string }[] };
  return (body.items ?? []).map((i) => i.name).sort();
}

async function objectMetadata(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${emulatorBase()}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(path)}`);
  return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
}

describe("exportAsset against the emulators", () => {
  it("writes the rendered bytes to applications/{applicationId}/{assetId}.txt and returns the emulator URL", async () => {
    const c = content("Product leader — platforms.");
    await seed([asset("asset-1", c)]);

    const out = await exportAssetHandler(request({ applicationId: APP_ID, assetId: "asset-1", format: "txt" }), deps);

    expect(out.filename).toBe(`Zürich Café ${EM} Senior PM ${EM} Resume.txt`);
    expect(out.format).toBe("txt");
    expect(out.contentType).toBe("text/plain; charset=utf-8");
    expect(out.url).toBe(`${emulatorBase()}/${BUCKET}/applications/${APP_ID}/asset-1.txt`);

    const res = await fetch(out.url);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(bytes, Buffer.from(renderPlainText(c), "utf8"))).toBe(0);
    expect(bytes.toString("utf8")).toContain("Product leader — platforms.");

    const meta = await objectMetadata(`applications/${APP_ID}/asset-1.txt`);
    expect(meta?.contentType).toBe("text/plain; charset=utf-8");
    expect(meta?.contentDisposition).toBe(
      "attachment; filename=\"Zurich Cafe - Senior PM - Resume.txt\"; filename*=UTF-8''Z%C3%BCrich%20Caf%C3%A9%20%E2%80%94%20Senior%20PM%20%E2%80%94%20Resume.txt",
    );
    expect(JSON.stringify(meta)).not.toContain("firebaseStorageDownloadTokens");
  });

  it("overwrites the same object on re-export", async () => {
    await seed([asset("asset-1", content("First."))]);
    await exportAssetHandler(request({ applicationId: APP_ID, assetId: "asset-1", format: "txt" }), deps);

    const next = content("Second.");
    await seed([asset("asset-1", next)]);
    const out = await exportAssetHandler(request({ applicationId: APP_ID, assetId: "asset-1", format: "txt" }), deps);

    expect(await listObjects(`applications/${APP_ID}/`)).toEqual([`applications/${APP_ID}/asset-1.txt`]);
    expect(await (await fetch(out.url)).text()).toBe(renderPlainText(next));
  });

  it("refuses content edited after its pass and writes nothing", async () => {
    await seed([asset("asset-2", content("Validated text."))]);
    // Edit the stored content without re-validating; the asset still says "passed".
    await db()
      .collection("applications")
      .doc(APP_ID)
      .update({ generated_assets: [asset("asset-2", content("Edited, never validated."))] });

    await expect(
      exportAssetHandler(request({ applicationId: APP_ID, assetId: "asset-2", format: "txt" }), deps),
    ).rejects.toMatchObject({ code: "failed-precondition", details: { reason: "no-attestation" } });
    expect(await listObjects(`applications/${APP_ID}/asset-2`)).toEqual([]);
    expect(await objectMetadata(`applications/${APP_ID}/asset-2.txt`)).toBeNull();
  });
});
