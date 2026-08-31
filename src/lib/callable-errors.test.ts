/**
 * Unit tests for `friendlyCallableError` (#422).
 *
 * The regression these pin: the Onboarding route rendered a callable
 * failure's raw `.message`, and a Cloud Run request-timeout kill
 * reaches the client as a `FunctionsError` whose message is the
 * literal string `"internal"`. Every case below distinguishes the
 * two shapes the SDK can hand us — a real server message vs. a
 * message the SDK filled in from the status code.
 */

import { describe, expect, it } from "vitest";

import { friendlyCallableError } from "./callable-errors.ts";

/**
 * Build the shape `@firebase/functions` throws. `_errorForResponse`
 * defaults `description` (which becomes `.message`) to the code when
 * the response carries no error body, so the default here reproduces
 * the bare-code case exactly.
 */
function functionsError(code: string, message: string = code): unknown {
  return Object.assign(new Error(message), { code, name: "FirebaseError" });
}

describe("friendlyCallableError", () => {
  describe("bare status codes (no server error body)", () => {
    it("maps the #422 'internal' case to actionable copy, not the raw code", () => {
      const msg = friendlyCallableError(functionsError("internal"));
      expect(msg).not.toBe("internal");
      expect(msg).toContain("stopped responding");
      // The user needs a next action, not just a diagnosis.
      expect(msg).toContain("try again");
    });

    it("maps deadline-exceeded to a timeout message", () => {
      const msg = friendlyCallableError(functionsError("deadline-exceeded"));
      expect(msg).toContain("timed out");
    });

    it("maps unavailable to a connectivity message", () => {
      expect(friendlyCallableError(functionsError("unavailable"))).toContain(
        "Check your connection",
      );
    });

    it("maps unauthenticated to a re-sign-in prompt", () => {
      expect(friendlyCallableError(functionsError("unauthenticated"))).toContain(
        "Sign in again",
      );
    });

    it("maps invalid-argument to an input-rejected message", () => {
      expect(friendlyCallableError(functionsError("invalid-argument"))).toContain(
        "rejected that input",
      );
    });

    it("maps failed-precondition to a manual-review hint", () => {
      expect(
        friendlyCallableError(functionsError("failed-precondition")),
      ).toContain("manual review");
    });

    it("maps resource-exhausted to a quota message", () => {
      expect(friendlyCallableError(functionsError("resource-exhausted"))).toContain(
        "quota",
      );
    });

    it("never returns a message equal to the code it was given", () => {
      const codes = [
        "internal",
        "deadline-exceeded",
        "unavailable",
        "unauthenticated",
        "permission-denied",
        "invalid-argument",
        "failed-precondition",
        "resource-exhausted",
        "cancelled",
      ];
      for (const code of codes) {
        expect(friendlyCallableError(functionsError(code))).not.toBe(code);
      }
    });
  });

  describe("server-authored messages", () => {
    it("prefers the server's message over the code map", () => {
      // What `extractFromResumeCallable` actually throws when the
      // extraction retry budget is exhausted.
      const err = functionsError(
        "failed-precondition",
        "Extraction failed after retries; needs manual review.",
      );
      expect(friendlyCallableError(err)).toBe(
        "Extraction failed after retries; needs manual review.",
      );
    });

    it("prefers the server's message even for codes with a mapping", () => {
      const err = functionsError("invalid-argument", "Paste some text first.");
      expect(friendlyCallableError(err)).toBe("Paste some text first.");
    });

    it("falls back to the code map when the message is whitespace only", () => {
      const msg = friendlyCallableError(functionsError("internal", "   "));
      expect(msg).toContain("stopped responding");
    });
  });

  describe("boundary and non-callable inputs", () => {
    it("returns the generic message for an unmapped code", () => {
      expect(friendlyCallableError(functionsError("unimplemented"))).toBe(
        "Something went wrong. Try again.",
      );
    });

    it("returns the generic message for a plain Error", () => {
      expect(friendlyCallableError(new Error("kaboom"))).toBe(
        "Something went wrong. Try again.",
      );
    });

    it("returns the generic message for a non-string code", () => {
      const err = Object.assign(new Error("x"), { code: 500 });
      expect(friendlyCallableError(err)).toBe("Something went wrong. Try again.");
    });

    it("returns the generic message for null, undefined, and a bare string", () => {
      expect(friendlyCallableError(null)).toBe("Something went wrong. Try again.");
      expect(friendlyCallableError(undefined)).toBe(
        "Something went wrong. Try again.",
      );
      expect(friendlyCallableError("internal")).toBe(
        "Something went wrong. Try again.",
      );
    });
  });
});
