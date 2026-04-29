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
  where: () => undefined,
}));

vi.mock("./firestore.ts", () => ({
  typedCollection: () => undefined,
  typedDoc: () => ({}),
}));

beforeEach(() => {
  getDoc.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const { getApplication } = await import("./applications.ts");

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
