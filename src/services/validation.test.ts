/**
 * `subscribeValidationAttestation` must deliver only server-confirmed
 * state (Codex P1 on #506). Firestore's latency compensation hands a
 * client's own pending write to its listeners before the backend rules
 * reject it, so a forged `passed` attestation written by a compromised
 * client would otherwise reach the export gate. Mocks `onSnapshot` the
 * way `roles.test.ts` mocks `getDoc`: narrowly, for this one behavior.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

type Snap = {
  readonly exists: () => boolean;
  readonly data: () => unknown;
  readonly metadata: { readonly hasPendingWrites: boolean };
};

let deliver: ((snap: Snap) => void) | undefined;

vi.mock("firebase/firestore", () => ({
  doc: (..._args: unknown[]) => ({}),
  onSnapshot: (_ref: unknown, next: (snap: Snap) => void) => {
    deliver = next;
    return () => {};
  },
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => () => undefined }));
vi.mock("../firebase.ts", () => ({ getDb: () => ({}), getFunctionsClient: () => ({}) }));

afterEach(() => {
  deliver = undefined;
  vi.clearAllMocks();
});

const { subscribeValidationAttestation } = await import("./validation.ts");

const record = { asset_id: "a1", status: "passed" };
const snap = (exists: boolean, hasPendingWrites: boolean): Snap => ({
  exists: () => exists,
  data: () => record,
  metadata: { hasPendingWrites },
});

describe("subscribeValidationAttestation", () => {
  it("ignores a locally pending write, even one that claims `passed`", () => {
    const callback = vi.fn();
    subscribeValidationAttestation("app", "a1", "cv2-x", callback);
    deliver!(snap(true, true));
    expect(callback).not.toHaveBeenCalled();
  });

  it("delivers server-confirmed state: the record, or null when absent", () => {
    const callback = vi.fn();
    subscribeValidationAttestation("app", "a1", "cv2-x", callback);
    deliver!(snap(false, false));
    deliver!(snap(true, false));
    expect(callback.mock.calls).toEqual([[null], [record]]);
  });
});
