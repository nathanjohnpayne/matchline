/**
 * Service-layer test for `getApplication`'s anti-enumeration
 * behavior (Codex P2 on PR #181 — mirror `getRole` from cursor
 * #132 r1).
 *
 * Mocks `firebase/firestore`'s `getDoc` directly. Same shape as
 * `roles.test.ts`; this file only pins the try/catch logic that
 * the ApplicationEditor container relies on for routing missing
 * or foreign applicationIds to the not-found surface instead of
 * the error surface.
 */

import { FirebaseError } from "firebase/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.ts", () => ({
  getOwnerUidOrThrow: () => "user-alice",
  ownerScope: () => [],
}));

const getDoc = vi.fn();

const updateDoc = vi.fn();

vi.mock("firebase/firestore", () => ({
  getDoc: (...args: unknown[]) => getDoc(...args),
  getDocs: () => {
    throw new Error("getDocs not mocked in applications.test.ts");
  },
  onSnapshot: () => {
    throw new Error("onSnapshot not mocked in applications.test.ts");
  },
  query: () => undefined,
  setDoc: () => {
    throw new Error("setDoc not mocked in applications.test.ts");
  },
  updateDoc: (...args: unknown[]) => updateDoc(...args),
  where: () => undefined,
}));

vi.mock("./firestore.ts", () => ({
  typedCollection: () => undefined,
  typedDoc: () => ({}),
}));

beforeEach(() => {
  getDoc.mockReset();
  updateDoc.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const { getApplication, removeBulletFromAsset, removeBulletFromContent } =
  await import("./applications.ts");

import type {
  Application,
  AssetRef,
  GeneratedAssetContent,
} from "./../types/crm.ts";

describe("getApplication — anti-enumeration (Codex P2 on PR #181)", () => {
  it("returns the Application when the doc exists and caller owns it", async () => {
    const fakeApp = {
      id: "app-1",
      owner_uid: "user-alice",
      role_id: "role-1",
      stage: "drafting",
      last_activity_at: "2026-04-01T00:00:00.000Z",
      generated_assets: [],
      approved_unit_ids: [],
    };
    getDoc.mockResolvedValueOnce({ exists: () => true, data: () => fakeApp });
    await expect(getApplication("app-1")).resolves.toEqual(fakeApp);
  });

  it("returns undefined when the doc does not exist (snap.exists() === false)", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => undefined,
    });
    await expect(getApplication("missing")).resolves.toBeUndefined();
  });

  it("returns undefined when Firestore rules deny the read (permission-denied) — collapses missing-OR-foreign into one shape", async () => {
    // Load-bearing test: without the try/catch, this would throw
    // and the editor container would route to its "error" surface,
    // leaking that the doc EXISTS (vs. returning undefined which
    // is the same shape as a missing doc). Collapsing to undefined
    // here matches the server-side anti-enumeration pattern that
    // `getRole` set the precedent for.
    getDoc.mockRejectedValueOnce(
      new FirebaseError(
        "permission-denied",
        "Missing or insufficient permissions.",
      ),
    );
    await expect(getApplication("foreign-app")).resolves.toBeUndefined();
  });

  it("propagates non-permission-denied errors (transport, unauthenticated, etc.)", async () => {
    const transport = new FirebaseError(
      "unavailable",
      "transient transport error",
    );
    getDoc.mockRejectedValueOnce(transport);
    await expect(getApplication("any")).rejects.toBe(transport);
  });

  it("propagates non-FirebaseError errors verbatim", async () => {
    const generic = new Error("something else");
    getDoc.mockRejectedValueOnce(generic);
    await expect(getApplication("any")).rejects.toBe(generic);
  });
});

function content(
  partial: Partial<GeneratedAssetContent> = {},
): GeneratedAssetContent {
  return {
    summary: { id: "summary", text: "summary", source_unit_ids: [] },
    bullets: [
      { id: "b1", text: "bullet one", source_unit_ids: [] },
      { id: "b2", text: "bullet two", source_unit_ids: [] },
    ],
    skills: [{ id: "sk1", text: "skill one", source_unit_ids: [] }],
    ...partial,
  };
}

function asset(partial: Partial<AssetRef> = {}): AssetRef {
  return {
    id: "asset-1",
    owner_uid: "u",
    application_id: "app-1",
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: content(),
    validation_status: "passed",
    created_at: "2026-04-01T00:00:00.000Z",
    ...partial,
  };
}

function application(partial: Partial<Application> = {}): Application {
  return {
    id: "app-1",
    owner_uid: "u",
    role_id: "role-1",
    stage: "drafting",
    last_activity_at: "2026-04-01T00:00:00.000Z",
    generated_assets: [asset()],
    approved_unit_ids: [],
    ...partial,
  };
}

describe("removeBulletFromContent (pure helper)", () => {
  it("removes from bullets[] and reports found=true", () => {
    const r = removeBulletFromContent(content(), "b1");
    expect(r.found).toBe(true);
    expect(r.content.bullets.map((b) => b.id)).toEqual(["b2"]);
    // Skills + summary untouched.
    expect(r.content.skills.length).toBe(1);
    expect(r.content.summary.id).toBe("summary");
  });

  it("removes from skills[] when the id matches a skill", () => {
    const r = removeBulletFromContent(content(), "sk1");
    expect(r.found).toBe(true);
    expect(r.content.skills.length).toBe(0);
    expect(r.content.bullets.length).toBe(2);
  });

  it("removes from education[] when present and the id matches", () => {
    const c = content({
      education: [
        { id: "e1", text: "BS", source_unit_ids: [] },
        { id: "e2", text: "MS", source_unit_ids: [] },
      ],
    });
    const r = removeBulletFromContent(c, "e1");
    expect(r.found).toBe(true);
    expect(r.content.education?.map((e) => e.id)).toEqual(["e2"]);
  });

  it("preserves the original content reference and found=false when no id matches", () => {
    const c = content();
    const r = removeBulletFromContent(c, "ghost");
    expect(r.found).toBe(false);
    // Same reference: callers can short-circuit a no-op write.
    expect(r.content).toBe(c);
  });

  it("does not introduce an `education` key when input has no education and id doesn't match there", () => {
    // Defensive: the spread should not add `education: []` to an
    // asset that was created without education metadata.
    const c = content();
    expect(c.education).toBeUndefined();
    const r = removeBulletFromContent(c, "b1");
    expect(r.found).toBe(true);
    expect(r.content.education).toBeUndefined();
  });
});

describe("removeBulletFromAsset (Firestore-mocked)", () => {
  it("returns 'application-not-found' when the application doesn't exist", async () => {
    getDoc.mockResolvedValueOnce({ exists: () => false, data: () => undefined });
    const r = await removeBulletFromAsset("missing", "asset-1", "b1");
    expect(r.status).toBe("application-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'application-not-found' on permission-denied (anti-enumeration)", async () => {
    // getApplication's catch collapses permission-denied to
    // undefined; removeBulletFromAsset should treat that as
    // application-not-found, not throw — same UX as a missing doc.
    getDoc.mockRejectedValueOnce(
      new FirebaseError("permission-denied", "denied"),
    );
    const r = await removeBulletFromAsset("foreign", "asset-1", "b1");
    expect(r.status).toBe("application-not-found");
  });

  it("returns 'asset-not-found' when the asset id is unknown", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await removeBulletFromAsset("app-1", "wrong-asset", "b1");
    expect(r.status).toBe("asset-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'asset-not-found' when the asset has no generated_content", async () => {
    const a = asset({ generated_content: undefined });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application({ generated_assets: [a] }),
    });
    const r = await removeBulletFromAsset("app-1", "asset-1", "b1");
    expect(r.status).toBe("asset-not-found");
  });

  it("refuses to remove the summary id (would corrupt the asset shape)", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await removeBulletFromAsset("app-1", "asset-1", "summary");
    expect(r.status).toBe("bullet-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'bullet-not-found' when no item matches", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await removeBulletFromAsset("app-1", "asset-1", "ghost");
    expect(r.status).toBe("bullet-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("removes the matching bullet, flips status to stale, and writes the patched generated_assets", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    const r = await removeBulletFromAsset("app-1", "asset-1", "b1");
    expect(r.status).toBe("removed");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    expect(writePayload.generated_assets).toHaveLength(1);
    const writtenAsset = writePayload.generated_assets[0];
    expect(writtenAsset.validation_status).toBe("stale");
    expect(writtenAsset.generated_content?.bullets.map((b) => b.id)).toEqual([
      "b2",
    ]);
  });

  it("preserves other assets in the array when removing from a specific asset", async () => {
    const otherAsset = asset({
      id: "asset-2",
      kind: "cover_letter",
      validation_status: "passed",
    });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () =>
        application({ generated_assets: [asset(), otherAsset] }),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    await removeBulletFromAsset("app-1", "asset-1", "b1");
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    expect(writePayload.generated_assets).toHaveLength(2);
    // The unrelated asset's status must NOT flip to stale.
    const untouched = writePayload.generated_assets.find(
      (a) => a.id === "asset-2",
    );
    expect(untouched?.validation_status).toBe("passed");
  });
});
