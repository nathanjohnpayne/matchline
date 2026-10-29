/**
 * Callable-level tests for `exportAssetHandler` (#521).
 *
 * Firestore and Storage are stubbed through the handler's `deps`; no
 * emulator. The end-to-end path against real emulators is
 * `tests/export-asset.integration.test.ts`.
 *
 * What is pinned here: the owner allowlist and ownership checks, the
 * server-side re-check of the export gate against the attestation for
 * the asset's CURRENT content version (a stale or missing pass never
 * exports and nothing is written), format rejection before any read,
 * and the success path's object path, bytes, content type, filename
 * and URL, including overwrite on re-export.
 */

import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPlainText } from "../export/text.ts";
import type { AssetRef, GeneratedAssetContent } from "../types/crm.ts";
import { assetContentVersion, validationAttestationId, type ValidationAttestation } from "../validation/attestation.ts";
import type { GateUnit } from "../validation/exportGate.ts";
import { unitEvidenceVersion } from "../validation/unitEvidenceVersion.ts";
import {
  exportAssetHandler,
  type ExportApplicationDoc,
  type ExportAssetData,
  type ExportAssetDeps,
  type ExportCompanyDoc,
  type ExportRoleDoc,
} from "./exportAsset.ts";

const ALICE = "user-alice";
const BOB = "user-bob";
const APP_ID = "app-1";
const ASSET_ID = "asset-1";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const EM = "—";

function makeRequest(data: ExportAssetData | undefined, authUid: string | null = ALICE): CallableRequest<ExportAssetData> {
  return {
    data: data as ExportAssetData,
    auth: authUid !== null ? { uid: authUid, token: {} } : undefined,
    rawRequest: {} as never,
    acceptsStreaming: false,
  } as unknown as CallableRequest<ExportAssetData>;
}

const VALID: ExportAssetData = { applicationId: APP_ID, assetId: ASSET_ID, format: "txt" };

const CONTENT: GeneratedAssetContent = {
  summary: { id: "s", text: "Product leader — platforms.", source_unit_ids: ["u1"] },
  bullets: [
    { id: "b1", text: "Shipped **search** to 4M users.", source_unit_ids: ["u1", "u2"] },
    { id: "b2", text: "Cut churn 12%.", source_unit_ids: ["u2"] },
  ],
  skills: [{ id: "k1", text: "Roadmapping", source_unit_ids: [] }],
};

function makeAsset(overrides: Partial<AssetRef> = {}): AssetRef {
  return {
    id: ASSET_ID,
    owner_uid: ALICE,
    application_id: APP_ID,
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: CONTENT,
    validation_status: "passed",
    created_at: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

function unit(id: string, overrides: Partial<GateUnit> = {}): GateUnit {
  return { id, raw_text: `raw ${id}`, normalized_summary: `summary ${id}`, user_approved: true, ...overrides };
}

const UNITS: readonly GateUnit[] = [unit("u1"), unit("u2")];

function attestationFor(content: unknown, overrides: Partial<ValidationAttestation> = {}): ValidationAttestation {
  return {
    owner_uid: ALICE,
    application_id: APP_ID,
    asset_id: ASSET_ID,
    content_version: assetContentVersion(content),
    status: "passed",
    validated_at: "2026-10-29T00:00:00.000Z",
    validated_unit_versions: Object.fromEntries(UNITS.map((u) => [u.id, unitEvidenceVersion(u)])),
    ...overrides,
  };
}

interface Harness {
  readonly deps: ExportAssetDeps;
  readonly loadApplication: ReturnType<typeof vi.fn>;
  readonly loadAttestation: ReturnType<typeof vi.fn>;
  readonly loadUnits: ReturnType<typeof vi.fn>;
  readonly save: ReturnType<typeof vi.fn>;
  readonly getSignedUrl: ReturnType<typeof vi.fn>;
  readonly makePublic: ReturnType<typeof vi.fn>;
  readonly filePaths: string[];
  /** Fake bucket contents: path → bytes. */
  readonly objects: Map<string, Buffer>;
}

/**
 * Stub deps over in-memory "documents". `attestations` is keyed by
 * attestation doc id, so a pass recorded for other content is simply
 * not found under the current content's id, exactly as in Firestore.
 */
function harness(opts: {
  app?: ExportApplicationDoc | null;
  attestations?: readonly ValidationAttestation[];
  units?: readonly GateUnit[];
  role?: ExportRoleDoc | null;
  company?: ExportCompanyDoc | null;
  env?: Record<string, string | undefined>;
  saveError?: Error;
} = {}): Harness {
  const app = opts.app === undefined ? { owner_uid: ALICE, role_id: "role-1", generated_assets: [makeAsset()] } : opts.app;
  const attestations = new Map(
    (opts.attestations ?? [attestationFor(CONTENT)]).map((a) => [validationAttestationId(a.asset_id, a.content_version), a]),
  );
  const units = opts.units ?? UNITS;
  const objects = new Map<string, Buffer>();
  const filePaths: string[] = [];
  const save = vi.fn(async function (this: { path: string }, data: Buffer) {
    if (opts.saveError) throw opts.saveError;
    objects.set(this.path, data);
  });
  const getSignedUrl = vi.fn(async function (this: { path: string }) {
    return [`https://storage.googleapis.com/test-bucket/${this.path}?X-Goog-Signature=sig`] as [string];
  });
  const makePublic = vi.fn();
  const loadApplication = vi.fn(async () => app);
  const loadAttestation = vi.fn(async (_appId: string, id: string) => attestations.get(id) ?? null);
  const loadUnits = vi.fn(async (ids: readonly string[], owner: string) =>
    owner === ALICE ? units.filter((u) => ids.includes(u.id)) : [],
  );
  const deps: ExportAssetDeps = {
    loadApplication,
    loadAttestation,
    loadUnits,
    loadRole: async () =>
      opts.role === undefined ? { owner_uid: ALICE, title: "Senior PM", company_id: "co-1" } : opts.role,
    loadCompany: async () => (opts.company === undefined ? { owner_uid: ALICE, name: "Acme" } : opts.company),
    bucket: () => ({
      name: "test-bucket",
      file: (path: string) => {
        filePaths.push(path);
        const ctx = { path };
        return {
          save: save.bind(ctx) as never,
          getSignedUrl: getSignedUrl.bind(ctx) as never,
          makePublic,
        } as never;
      },
    }),
    now: () => NOW,
    env: opts.env ?? {},
  };
  return { deps, loadApplication, loadAttestation, loadUnits, save, getSignedUrl, makePublic, filePaths, objects };
}

async function callExpectingError(
  data: ExportAssetData | undefined,
  h: Harness,
  authUid: string | null = ALICE,
): Promise<HttpsError> {
  try {
    await exportAssetHandler(makeRequest(data, authUid), h.deps);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpsError);
    return err as HttpsError;
  }
  throw new Error("expected exportAssetHandler to throw");
}

function expectNothingWritten(h: Harness): void {
  expect(h.save).not.toHaveBeenCalled();
  expect(h.getSignedUrl).not.toHaveBeenCalled();
  expect(h.makePublic).not.toHaveBeenCalled();
  expect(h.objects.size).toBe(0);
}

describe("exportAssetHandler", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHLINE_OWNER_UIDS", ALICE);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("authorization", () => {
    it("rejects an unauthenticated call before any read", async () => {
      const h = harness();
      const err = await callExpectingError(VALID, h, null);
      expect(err.code).toBe("unauthenticated");
      expect(h.loadApplication).not.toHaveBeenCalled();
      expectNothingWritten(h);
    });

    it("rejects a signed-in caller who is not on the owner allowlist", async () => {
      const h = harness();
      const err = await callExpectingError(VALID, h, BOB);
      expect(err.code).toBe("permission-denied");
      expect(h.loadApplication).not.toHaveBeenCalled();
      expectNothingWritten(h);
    });

    it("rejects a missing Application with the anti-enumeration shape", async () => {
      const h = harness({ app: null });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("permission-denied");
      expect(err.message).toBe("Application or asset not found, or not owned by caller.");
      expectNothingWritten(h);
    });

    it("rejects an Application owned by someone else, identically", async () => {
      vi.stubEnv("MATCHLINE_OWNER_UIDS", `${ALICE},${BOB}`);
      const h = harness({ app: { owner_uid: BOB, generated_assets: [makeAsset({ owner_uid: BOB })] } });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("permission-denied");
      expect(err.message).toBe("Application or asset not found, or not owned by caller.");
      expect(h.loadAttestation).not.toHaveBeenCalled();
      expectNothingWritten(h);
    });

    it("rejects an asset that is not on the Application", async () => {
      const h = harness();
      const err = await callExpectingError({ ...VALID, assetId: "asset-404" }, h);
      expect(err.code).toBe("permission-denied");
      expectNothingWritten(h);
    });
  });

  describe("arguments", () => {
    it.each([
      ["missing data", undefined],
      ["missing applicationId", { assetId: ASSET_ID, format: "txt" }],
      ["blank assetId", { applicationId: APP_ID, assetId: "  ", format: "txt" }],
      ["applicationId with a slash", { applicationId: "a/b", assetId: ASSET_ID, format: "txt" }],
      ["assetId with a slash", { applicationId: APP_ID, assetId: "../x", format: "txt" }],
    ])("rejects %s with invalid-argument before any read", async (_label, data) => {
      const h = harness();
      const err = await callExpectingError(data as ExportAssetData | undefined, h);
      expect(err.code).toBe("invalid-argument");
      expect(h.loadApplication).not.toHaveBeenCalled();
      expectNothingWritten(h);
    });

    it.each([["pdf"], ["docx"], ["json"], ["rtf"], ["TXT"], [undefined], [7]])(
      "rejects format %j with invalid-argument before any read",
      async (format) => {
        const h = harness();
        const err = await callExpectingError({ ...VALID, format: format as string }, h);
        expect(err.code).toBe("invalid-argument");
        expect(err.message).toMatch(/Unsupported export format .*Supported: txt\./);
        expect(h.loadApplication).not.toHaveBeenCalled();
        expectNothingWritten(h);
      },
    );
  });

  describe("server-side export gate", () => {
    it("refuses a non-resume asset", async () => {
      const h = harness({ app: { owner_uid: ALICE, generated_assets: [makeAsset({ kind: "cover_letter" })] } });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("failed-precondition");
      expectNothingWritten(h);
    });

    it("refuses an asset with no generated content", async () => {
      const h = harness({ app: { owner_uid: ALICE, generated_assets: [makeAsset({ generated_content: undefined })] } });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("failed-precondition");
      expect(err.details).toEqual({ reason: "no-content" });
      expectNothingWritten(h);
    });

    it("refuses malformed content", async () => {
      const malformed = { ...CONTENT, bullets: [{ id: "b1", text: 42, source_unit_ids: [] }] } as unknown as GeneratedAssetContent;
      const h = harness({ app: { owner_uid: ALICE, generated_assets: [makeAsset({ generated_content: malformed })] } });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("failed-precondition");
      expect(err.details).toEqual({ reason: "malformed-content" });
      expect(h.loadAttestation).not.toHaveBeenCalled();
      expectNothingWritten(h);
    });

    it("refuses when there is no attestation for the current content", async () => {
      const h = harness({ attestations: [] });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("failed-precondition");
      expect(err.details).toEqual({ reason: "no-attestation" });
      expect(h.loadAttestation).toHaveBeenCalledWith(APP_ID, validationAttestationId(ASSET_ID, assetContentVersion(CONTENT)));
      expectNothingWritten(h);
    });

    it("refuses a stale pass: passed, but for the content before an edit", async () => {
      const before = { ...CONTENT, bullets: [{ ...CONTENT.bullets[0], text: "Shipped search." }, CONTENT.bullets[1]] };
      // The asset still says "passed" (client-writable display state);
      // only the attestation for the pre-edit content exists.
      const h = harness({ attestations: [attestationFor(before)] });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("failed-precondition");
      expect(err.details).toEqual({ reason: "no-attestation" });
      expectNothingWritten(h);
    });

    it("refuses an attestation stored under the current id whose fields do not match", async () => {
      const forged = { ...attestationFor(CONTENT), owner_uid: BOB };
      const h = harness({ attestations: [forged] });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("failed-precondition");
      expect(err.details).toEqual({ reason: "attestation-mismatch" });
      expectNothingWritten(h);
    });

    it("refuses a failed attestation", async () => {
      const h = harness({ attestations: [attestationFor(CONTENT, { status: "failed" })] });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("failed-precondition");
      expect(err.details).toEqual({ reason: "not-passed" });
      expectNothingWritten(h);
    });

    it.each([
      ["missing", [unit("u1")], "evidence-missing"],
      ["unapproved", [unit("u1"), unit("u2", { user_approved: false })], "evidence-unapproved"],
      ["edited", [unit("u1"), unit("u2", { raw_text: "rewritten" })], "evidence-changed"],
    ] as const)("refuses when a cited Unit is %s", async (_label, units, reason) => {
      const h = harness({ units });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("failed-precondition");
      expect(err.details).toEqual({ reason });
      expect(h.loadUnits).toHaveBeenCalledWith(["u1", "u2"], ALICE);
      expectNothingWritten(h);
    });

    it("refuses evidence recorded under an older format", async () => {
      const att = attestationFor(CONTENT, { validated_unit_versions: { u1: "ev2:old", u2: unitEvidenceVersion(UNITS[1]) } });
      const h = harness({ attestations: [att] });
      const err = await callExpectingError(VALID, h);
      expect(err.details).toEqual({ reason: "evidence-outdated" });
      expectNothingWritten(h);
    });

    it("ignores the asset's own validation_status: the attestation decides", async () => {
      const h = harness({
        app: { owner_uid: ALICE, role_id: "role-1", generated_assets: [makeAsset({ validation_status: "stale" })] },
      });
      const out = await exportAssetHandler(makeRequest(VALID), h.deps);
      expect(out.format).toBe("txt");
    });
  });

  describe("success", () => {
    it("writes one private object at the asset's path and returns a signed URL and the filename", async () => {
      const h = harness();
      const out = await exportAssetHandler(makeRequest(VALID), h.deps);

      expect(h.filePaths).toEqual(["applications/app-1/asset-1.txt"]);
      expect(h.save).toHaveBeenCalledTimes(1);
      const [bytes, options] = h.save.mock.calls[0] as unknown as [Buffer, Record<string, unknown>];
      expect(bytes.toString("utf8")).toBe(renderPlainText(CONTENT));
      expect(bytes.toString("utf8")).toContain("Product leader — platforms.");
      const disposition =
        "attachment; filename=\"Acme - Senior PM - Resume.txt\"; filename*=UTF-8''Acme%20%E2%80%94%20Senior%20PM%20%E2%80%94%20Resume.txt";
      expect(options).toEqual({
        resumable: false,
        contentType: "text/plain; charset=utf-8",
        metadata: { contentDisposition: disposition, cacheControl: "private, no-store" },
      });
      expect(h.getSignedUrl).toHaveBeenCalledWith({
        version: "v4",
        action: "read",
        expires: NOW + 5 * 60_000,
        responseDisposition: disposition,
        responseType: "text/plain; charset=utf-8",
      });
      expect(h.makePublic).not.toHaveBeenCalled();
      expect(out).toEqual({
        url: "https://storage.googleapis.com/test-bucket/applications/app-1/asset-1.txt?X-Goog-Signature=sig",
        filename: `Acme ${EM} Senior PM ${EM} Resume.txt`,
        format: "txt",
        contentType: "text/plain; charset=utf-8",
        expiresAt: "2026-10-29T12:05:00.000Z",
      });
    });

    it("renders the attested content object itself, in stored order", async () => {
      const reordered = { ...CONTENT, bullets: [CONTENT.bullets[1], CONTENT.bullets[0]] };
      // Reordering keeps the content version, so the same pass covers it.
      const h = harness({
        app: { owner_uid: ALICE, role_id: "role-1", generated_assets: [makeAsset({ generated_content: reordered })] },
      });
      await exportAssetHandler(makeRequest(VALID), h.deps);
      const text = (h.save.mock.calls[0]?.[0] as Buffer).toString("utf8");
      expect(text).toBe(renderPlainText(reordered));
      expect(text.indexOf("Cut churn")).toBeLessThan(text.indexOf("Shipped"));
    });

    it("leaves out the company when the Role has no Company document", async () => {
      const h = harness({ company: null });
      const out = await exportAssetHandler(makeRequest(VALID), h.deps);
      expect(out.filename).toBe(`Senior PM ${EM} Resume.txt`);
    });

    it("leaves out a Role or Company owned by someone else", async () => {
      const foreignCompany = harness({ company: { owner_uid: BOB, name: "Other Co" } });
      expect((await exportAssetHandler(makeRequest(VALID), foreignCompany.deps)).filename).toBe(
        `Senior PM ${EM} Resume.txt`,
      );
      const foreignRole = harness({ role: { owner_uid: BOB, title: "Spy", company_id: "co-1" } });
      expect((await exportAssetHandler(makeRequest(VALID), foreignRole.deps)).filename).toBe("Resume.txt");
    });

    it("overwrites the same object on re-export", async () => {
      const h = harness();
      await exportAssetHandler(makeRequest(VALID), h.deps);
      await exportAssetHandler(makeRequest(VALID), h.deps);
      expect(h.filePaths).toEqual(["applications/app-1/asset-1.txt", "applications/app-1/asset-1.txt"]);
      expect([...h.objects.keys()]).toEqual(["applications/app-1/asset-1.txt"]);
      expect(h.save).toHaveBeenCalledTimes(2);
    });

    it("returns the emulator URL and does not sign under the Storage emulator", async () => {
      const h = harness({ env: { FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199" } });
      const out = await exportAssetHandler(makeRequest(VALID), h.deps);
      expect(out.url).toBe("http://127.0.0.1:9199/test-bucket/applications/app-1/asset-1.txt");
      expect(h.getSignedUrl).not.toHaveBeenCalled();
      expect(h.save).toHaveBeenCalledTimes(1);
    });

    it("maps a Storage failure to internal without returning a URL", async () => {
      const h = harness({ saveError: new Error("bucket does not exist") });
      const err = await callExpectingError(VALID, h);
      expect(err.code).toBe("internal");
      expect(err.message).not.toContain("bucket does not exist");
      expect(h.getSignedUrl).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    });
  });
});
