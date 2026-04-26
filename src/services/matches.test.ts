/**
 * Service-layer tests for `setMatchApprovalState` + the
 * `approvalStateOf` derivation (#130 + cursor #133 r1's
 * unified-setter refactor).
 *
 * The unified setter eliminates the dual-write race
 * CodeRabbit caught on PR #133: each click produces ONE
 * `updateDoc` call with the FULL flag pair, so per-doc
 * per-client Firestore write ordering means the LAST
 * submitted write wins deterministically. No interleaved
 * `setMatchApproval` + `setMatchRejection` shape that
 * could produce inconsistent state across offline resync,
 * multi-tab, or rapid double-clicks.
 *
 * vi.mock pattern matches `roles.test.ts` (#132 r1's
 * anti-enumeration test). Narrow on purpose so it doesn't
 * set a precedent for shotgun Firestore mocking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UnitMatch } from "../types/capability.ts";

vi.mock("./auth.ts", () => ({
  getOwnerUidOrThrow: () => "user-alice",
  ownerScope: () => [],
}));

const updateDoc = vi.fn();

vi.mock("firebase/firestore", () => ({
  updateDoc: (...args: unknown[]) => updateDoc(...args),
  // The other firestore exports aren't reached in these
  // tests; throw if accessed so a future test that reaches
  // for them gets a loud signal.
  getDoc: () => {
    throw new Error("getDoc not mocked in matches.test.ts");
  },
  getDocs: () => {
    throw new Error("getDocs not mocked in matches.test.ts");
  },
  onSnapshot: () => {
    throw new Error("onSnapshot not mocked in matches.test.ts");
  },
  orderBy: () => undefined,
  query: () => undefined,
  setDoc: () => {
    throw new Error("setDoc not mocked in matches.test.ts");
  },
  where: () => undefined,
}));

vi.mock("./firestore.ts", () => ({
  typedCollection: () => undefined,
  typedDoc: (_path: string, id: string) => ({ __mockedRef: id }),
}));

beforeEach(() => {
  updateDoc.mockReset();
  updateDoc.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

const { setMatchApprovalState, approvalStateOf } = await import("./matches.ts");

describe("setMatchApprovalState — single-writer, atomic flag pair (cursor #133 r1)", () => {
  it("APPROVED: writes { approved_for_use: true, user_rejected: false }", async () => {
    await setMatchApprovalState("match-1", "approved");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc.mock.calls[0]![1]).toEqual({
      approved_for_use: true,
      user_rejected: false,
    });
  });

  it("REJECTED: writes { approved_for_use: false, user_rejected: true }", async () => {
    await setMatchApprovalState("match-1", "rejected");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc.mock.calls[0]![1]).toEqual({
      approved_for_use: false,
      user_rejected: true,
    });
  });

  it("NONE: writes { approved_for_use: false, user_rejected: false } (clears both)", async () => {
    // Click-to-revert from either state lands here. Single
    // call clears both flags atomically.
    await setMatchApprovalState("match-1", "none");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc.mock.calls[0]![1]).toEqual({
      approved_for_use: false,
      user_rejected: false,
    });
  });

  it("ALL THREE STATES write BOTH flags every time — pinning that the contradictory shape can't sneak in via partial writes", async () => {
    // Defensive pin: every write must include both fields,
    // never just one. A future code change that issues a
    // partial { approved_for_use: ... } without
    // user_rejected (or vice versa) would break the
    // mutual-exclusion guarantee under concurrent writes.
    for (const state of ["approved", "rejected", "none"] as const) {
      updateDoc.mockClear();
      await setMatchApprovalState("match-1", state);
      const payload = updateDoc.mock.calls[0]![1] as Record<string, unknown>;
      expect("approved_for_use" in payload).toBe(true);
      expect("user_rejected" in payload).toBe(true);
    }
  });

  it("passes the matchId through to updateDoc's ref arg", async () => {
    await setMatchApprovalState("specific-match-id", "approved");
    expect(updateDoc.mock.calls[0]![0]).toEqual({
      __mockedRef: "specific-match-id",
    });
  });
});

describe("approvalStateOf — derive enum from persisted flag pair", () => {
  // Helper: build a minimal UnitMatch shape with just the
  // two flags. Other fields aren't read by approvalStateOf.
  function flags(
    approved_for_use: boolean,
    user_rejected: boolean,
  ): Pick<UnitMatch, "approved_for_use" | "user_rejected"> {
    return { approved_for_use, user_rejected };
  }

  it("(false, false) → 'none'", () => {
    expect(approvalStateOf(flags(false, false))).toBe("none");
  });

  it("(true, false) → 'approved'", () => {
    expect(approvalStateOf(flags(true, false))).toBe("approved");
  });

  it("(false, true) → 'rejected'", () => {
    expect(approvalStateOf(flags(false, true))).toBe("rejected");
  });

  it("(true, true) → 'rejected' (defends to the more conservative interpretation)", () => {
    // The contradictory shape shouldn't be producible via
    // setMatchApprovalState (it always writes one of the
    // three valid pairs), but a manual Firestore write or
    // a future schema migration could in principle surface
    // it. Defaulting to "rejected" mirrors the matching
    // pipeline's filter at #82 — rejected matches are dead
    // to downstream readers, so the conservative read is
    // correct.
    expect(approvalStateOf(flags(true, true))).toBe("rejected");
  });
});
