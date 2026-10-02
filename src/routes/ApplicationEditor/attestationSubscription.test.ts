import { describe, expect, it } from "vitest";

import { attestationSubscription } from "./attestationSubscription.ts";

const base = ["app-1", "asset-1", "cv2-aaaa", "2026-10-02T00:00:00.000Z"] as const;

describe("attestationSubscription", () => {
  it("is null until there is an application, an asset and content to fingerprint", () => {
    expect(attestationSubscription(undefined, "asset-1", "cv2-aaaa", undefined)).toBeNull();
    expect(attestationSubscription("app-1", undefined, "cv2-aaaa", undefined)).toBeNull();
    expect(attestationSubscription("app-1", "asset-1", null, undefined)).toBeNull();
  });

  it("re-opens the listener when ONLY a new verdict lands, so a listener ended by an error recovers (Codex on #506)", () => {
    const before = attestationSubscription(...base)!;
    const after = attestationSubscription("app-1", "asset-1", "cv2-aaaa", "2026-10-02T00:05:00.000Z")!;
    expect(after.restartKey).not.toBe(before.restartKey);
    // Still the same record: a re-subscribe never points at other content.
    expect(after.recordKey).toBe(before.recordKey);
  });

  it("keeps the listener across a refetch that changes neither the content nor the verdict", () => {
    expect(attestationSubscription(...base)!.restartKey).toBe(attestationSubscription(...base)!.restartKey);
  });

  it("moves to a new record when the content changes", () => {
    const a = attestationSubscription(...base)!;
    const b = attestationSubscription("app-1", "asset-1", "cv2-bbbb", base[3])!;
    expect(b.recordKey).not.toBe(a.recordKey);
    expect(b.restartKey).not.toBe(a.restartKey);
  });

  it("re-opens for a first verdict on content that had none", () => {
    expect(attestationSubscription("app-1", "asset-1", "cv2-aaaa", undefined)!.restartKey).not.toBe(
      attestationSubscription(...base)!.restartKey,
    );
  });
});
