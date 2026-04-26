/**
 * Service-layer test for `setMatchApproval`'s mutual-
 * exclusion with `user_rejected` (cursor #132 r2).
 *
 * The two flags MUST NOT coexist as `{ approved_for_use:
 * true, user_rejected: true }` — generation gates on
 * `approved_for_use === true` (#120 / #121) and the
 * matching pipeline filters out `user_rejected: true`
 * matches on re-run (#82). A match in both states would
 * confuse downstream readers: generation would consume it,
 * but the next matching run would silently drop the
 * underlying Unit pair.
 *
 * This test pins the service-layer guarantee: approving
 * always writes `user_rejected: false`. Un-approving does
 * NOT write `user_rejected` (un-approve is not the same
 * intent as reject; that's `setMatchRejection`'s job in
 * #130).
 *
 * vi.mock pattern matches `roles.test.ts` (#132 r1's
 * anti-enumeration test). Narrow on purpose so it doesn't
 * set a precedent for shotgun Firestore mocking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { setMatchApproval, setMatchRejection } = await import("./matches.ts");

describe("setMatchApproval — mutual exclusion (cursor #132 r2)", () => {
  it("APPROVE: writes approved_for_use:true AND user_rejected:false (clears stale rejection)", async () => {
    // The load-bearing pin. A previously-rejected match
    // with `{ approved_for_use: false, user_rejected: true }`
    // becomes `{ approved_for_use: true, user_rejected:
    // false }` — clearing the stale flag so generation
    // and matching agree on the match's status.
    await setMatchApproval("match-1", { approved_for_use: true });
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc.mock.calls[0]![1]).toEqual({
      approved_for_use: true,
      user_rejected: false,
    });
  });

  it("UN-APPROVE: writes approved_for_use:false WITHOUT touching user_rejected (un-approve is not reject)", async () => {
    // Un-approving is "withdraw approval"; it doesn't
    // imply "reject." The rejection toggle is its own
    // intent (setMatchRejection ships in #130). The two
    // user intents must remain distinguishable.
    await setMatchApproval("match-1", { approved_for_use: false });
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc.mock.calls[0]![1]).toEqual({
      approved_for_use: false,
    });
    // Critically, user_rejected is NOT in the payload.
    const payload = updateDoc.mock.calls[0]![1] as Record<string, unknown>;
    expect("user_rejected" in payload).toBe(false);
  });

  it("APPROVE: passes the matchId through to updateDoc's ref arg", async () => {
    await setMatchApproval("specific-match-id", { approved_for_use: true });
    expect(updateDoc.mock.calls[0]![0]).toEqual({
      __mockedRef: "specific-match-id",
    });
  });
});

describe("setMatchRejection — symmetric mutual exclusion (#130)", () => {
  it("REJECT: writes user_rejected:true AND approved_for_use:false (clears stale approval)", async () => {
    // Symmetric to APPROVE's clear-rejection. Rejecting a
    // previously-approved match must clear the approval
    // flag — otherwise generation (gates on
    // approved_for_use) would consume the match while the
    // next matching run (filters user_rejected) would drop
    // the underlying Unit pair.
    await setMatchRejection("match-1", { user_rejected: true });
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc.mock.calls[0]![1]).toEqual({
      user_rejected: true,
      approved_for_use: false,
    });
  });

  it("UN-REJECT: writes user_rejected:false WITHOUT touching approved_for_use (un-reject is not approve)", async () => {
    // Un-rejecting is "withdraw rejection," not "approve."
    // If the user wants the match approved after
    // un-rejecting, that's a separate setMatchApproval click.
    await setMatchRejection("match-1", { user_rejected: false });
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc.mock.calls[0]![1]).toEqual({
      user_rejected: false,
    });
    const payload = updateDoc.mock.calls[0]![1] as Record<string, unknown>;
    expect("approved_for_use" in payload).toBe(false);
  });

  it("REJECT: passes the matchId through to updateDoc's ref arg", async () => {
    await setMatchRejection("specific-match-id", { user_rejected: true });
    expect(updateDoc.mock.calls[0]![0]).toEqual({
      __mockedRef: "specific-match-id",
    });
  });
});
