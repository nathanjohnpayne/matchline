import { describe, expect, it } from "vitest";

import { friendlyAuthError } from "./auth-errors.ts";

describe("friendlyAuthError", () => {
  it("returns the generic fallback for undefined / null errors", () => {
    expect(friendlyAuthError(undefined)).toBe("Something went wrong. Try again.");
    expect(friendlyAuthError(null)).toBe("Something went wrong. Try again.");
  });

  it("returns the generic fallback for unknown codes", () => {
    expect(friendlyAuthError({ code: "auth/nothing-like-this" })).toBe(
      "Something went wrong. Try again.",
    );
  });

  it("returns the generic fallback when the error has no code at all", () => {
    expect(friendlyAuthError(new Error("boom"))).toBe(
      "Something went wrong. Try again.",
    );
    expect(friendlyAuthError("just a string")).toBe(
      "Something went wrong. Try again.",
    );
  });

  it("maps invalid-email to a format hint", () => {
    expect(friendlyAuthError({ code: "auth/invalid-email" })).toMatch(
      /valid email/i,
    );
  });

  it("maps weak-password to a length hint", () => {
    expect(friendlyAuthError({ code: "auth/weak-password" })).toMatch(
      /8 characters/,
    );
  });

  it("maps email-already-in-use to a try-signing-in hint", () => {
    expect(friendlyAuthError({ code: "auth/email-already-in-use" })).toMatch(
      /already exists/i,
    );
  });

  it("collapses user-not-found, wrong-password, and invalid-credential to one anti-enumeration message", () => {
    // This is a security property, not a cosmetic one: if these three
    // produced different strings, an attacker could enumerate whether
    // an email is registered based on which message appears.
    const a = friendlyAuthError({ code: "auth/user-not-found" });
    const b = friendlyAuthError({ code: "auth/wrong-password" });
    const c = friendlyAuthError({ code: "auth/invalid-credential" });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toMatch(/didn't match/);
  });

  it("maps too-many-requests to a rate-limit hint", () => {
    expect(friendlyAuthError({ code: "auth/too-many-requests" })).toMatch(
      /Too many/,
    );
  });

  it("maps network-request-failed to a connectivity hint", () => {
    expect(friendlyAuthError({ code: "auth/network-request-failed" })).toMatch(
      /Network request failed/,
    );
  });
});
