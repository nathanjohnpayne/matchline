import { describe, expect, it } from "vitest";

import { ownerUidOrThrow } from "./auth.ts";

describe("ownerUidOrThrow", () => {
  it("returns the uid when one is provided", () => {
    expect(ownerUidOrThrow("abc-123")).toBe("abc-123");
  });

  it("throws on undefined", () => {
    expect(() => ownerUidOrThrow(undefined)).toThrow(
      /Service-layer call requires a signed-in user/,
    );
  });

  it("throws on empty string (falsy)", () => {
    // A present-but-empty uid means something broke upstream — there
    // is no legitimate case where Firebase Auth returns an empty uid.
    expect(() => ownerUidOrThrow("")).toThrow(
      /Service-layer call requires a signed-in user/,
    );
  });

  it("error message points at the route guard as the upstream owner", () => {
    // The message specifically names App.tsx's route guard so the
    // first agent hitting this throw knows where to look.
    try {
      ownerUidOrThrow(undefined);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/route guard in App\.tsx/);
    }
  });
});
