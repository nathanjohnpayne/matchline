/**
 * Service-layer test for `getRole`'s anti-enumeration
 * behavior (cursor #132 r1).
 *
 * Mocks `firebase/firestore`'s `getDoc` directly. The other
 * module exports here (subscribeRequirementsForRole, etc.)
 * are exercised by hand-testing + the emulator integration
 * surface; this file only pins the new try/catch logic that
 * the container relies on for routing missing/foreign Role
 * IDs to the not-found state instead of the error state.
 *
 * Why one focused test and not full service-layer coverage:
 * the established pattern in this codebase is to test pure
 * helpers + write paths via emulator integration. This is
 * the first vi.mock service-layer test; it's narrow on
 * purpose so it doesn't set a precedent for shotgun mocking
 * Firestore everywhere. Future extensions to anti-
 * enumeration logic in this file would land alongside.
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
  // The rest of the firestore surface is unused in these
  // tests; throw if accessed so a future test that reaches
  // for them gets a loud signal.
  getDocs: () => {
    throw new Error("getDocs not mocked in roles.test.ts");
  },
  onSnapshot: () => {
    throw new Error("onSnapshot not mocked in roles.test.ts");
  },
  query: () => undefined,
  setDoc: () => {
    throw new Error("setDoc not mocked in roles.test.ts");
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

// Imported AFTER the mocks are declared so the module under
// test sees the mocked firebase/firestore.
const { getRole } = await import("./roles.ts");

describe("getRole — anti-enumeration (cursor #132 r1)", () => {
  it("returns the Role when the doc exists and caller owns it", async () => {
    const fakeRole = { id: "role-1", owner_uid: "user-alice", title: "PM" };
    getDoc.mockResolvedValueOnce({ exists: () => true, data: () => fakeRole });
    await expect(getRole("role-1")).resolves.toEqual(fakeRole);
  });

  it("returns undefined when the doc does not exist (snap.exists() === false)", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => undefined,
    });
    await expect(getRole("missing")).resolves.toBeUndefined();
  });

  it("returns undefined when Firestore rules deny the read (permission-denied) — collapses missing-OR-foreign into one shape", async () => {
    // This is the load-bearing test. Without the try/catch
    // in getRole, this would throw and the container would
    // route to its "error" state, leaking that the doc
    // EXISTS (vs. returning undefined which is the same
    // shape as a missing doc). Collapsing to undefined here
    // matches the server-side anti-enumeration pattern.
    getDoc.mockRejectedValueOnce(
      new FirebaseError("permission-denied", "Missing or insufficient permissions."),
    );
    await expect(getRole("foreign-role")).resolves.toBeUndefined();
  });

  it("propagates non-permission-denied errors (transport, unauthenticated, etc.)", async () => {
    // Genuine failures should still surface to the container
    // as errors — the anti-enumeration collapse only applies
    // to permission-denied (the cross-owner / non-existent
    // signal).
    const transport = new FirebaseError("unavailable", "transient transport error");
    getDoc.mockRejectedValueOnce(transport);
    await expect(getRole("any")).rejects.toBe(transport);
  });

  it("propagates non-FirebaseError errors verbatim", async () => {
    // Defensive: a future SDK update could throw a plain
    // Error subtype. The instanceof guard ensures we don't
    // accidentally swallow those as "permission-denied" too.
    const generic = new Error("something else");
    getDoc.mockRejectedValueOnce(generic);
    await expect(getRole("any")).rejects.toBe(generic);
  });
});
