/**
 * Unit tests for `friendlyCallableError` (#422).
 *
 * The regression these pin: the Onboarding route rendered a callable
 * failure's raw `.message`, and a Cloud Run request-timeout kill
 * reaches the client as a `FunctionsError` whose message is the
 * literal string `"internal"`.
 *
 * **Fixtures use the real `FunctionsError` class, deliberately.** The
 * first version of these tests hand-rolled `Object.assign(new Error(
 * code), { code })`, which put the *bare* code on `.code`. The SDK
 * actually stores `functions/${code}` — see its constructor, and the
 * public `FunctionsErrorCode` type, which is literally
 * `` `functions/${FunctionsErrorCodeCore}` ``. That gap hid a real
 * bug: `message === code` compared `"internal"` against
 * `"functions/internal"`, never matched, and the mapper handed back
 * the one-word banner it exists to replace. Codex caught it on PR
 * #423. Constructing the SDK's own error type means the fixture
 * cannot drift from the shape production actually throws.
 */

import { FunctionsError } from "firebase/functions";
import { describe, expect, it } from "vitest";

import { friendlyCallableError } from "./callable-errors.ts";

/**
 * A structurally-failed call: `_errorForResponse` defaults
 * `description` (which becomes `.message`) to the bare status code
 * when the response carries no error body.
 */
function bareError(code: string): FunctionsError {
  return new FunctionsError(code as never, code);
}

/** A deliberate `HttpsError` from our own function code. */
function serverError(code: string, message: string): FunctionsError {
  return new FunctionsError(code as never, message);
}

describe("friendlyCallableError", () => {
  describe("the SDK's namespaced code shape", () => {
    it("stores a namespaced code with a bare message (fixture sanity check)", () => {
      // If this ever fails, the SDK changed and the normalization in
      // callable-errors.ts needs revisiting — the assertion exists so
      // that shows up here rather than as a mystery banner in prod.
      const err = bareError("internal");
      expect(err.code).toBe("functions/internal");
      expect(err.message).toBe("internal");
    });

    it("does not mistake a namespaced bare code for a server message", () => {
      // The exact bug Codex found: message "internal" !== code
      // "functions/internal", so a naive comparison treats the bare
      // status as server-authored and passes it straight through.
      expect(friendlyCallableError(bareError("internal"))).not.toBe("internal");
    });

    it("treats a message equal to the namespaced code as bare too", () => {
      // Defensive: an SDK that stops stripping the prefix from the
      // synthesized message must still read as bare, not authored.
      const err = serverError("internal", "functions/internal");
      expect(friendlyCallableError(err)).not.toBe("functions/internal");
      expect(friendlyCallableError(err)).toContain("stopped responding");
    });
  });

  describe("bare status codes (no server error body)", () => {
    it("maps the #422 'internal' case to actionable copy", () => {
      const msg = friendlyCallableError(bareError("internal"));
      expect(msg).toContain("stopped responding");
      // Case-insensitive: the retry prompt may lead its own sentence.
      // What matters is that the user is told to retry, not the casing.
      expect(msg).toMatch(/try again/i);
    });

    it("maps deadline-exceeded to a timeout message", () => {
      expect(friendlyCallableError(bareError("deadline-exceeded"))).toContain(
        "timed out",
      );
    });

    it("maps unavailable to a connectivity message", () => {
      expect(friendlyCallableError(bareError("unavailable"))).toContain(
        "Check your connection",
      );
    });

    it("maps unauthenticated to a re-sign-in prompt", () => {
      expect(friendlyCallableError(bareError("unauthenticated"))).toContain(
        "Sign in again",
      );
    });

    it("maps invalid-argument to an input-rejected message", () => {
      expect(friendlyCallableError(bareError("invalid-argument"))).toContain(
        "rejected that input",
      );
    });

    it("maps failed-precondition to a manual-review hint", () => {
      expect(friendlyCallableError(bareError("failed-precondition"))).toContain(
        "manual review",
      );
    });

    it("maps resource-exhausted to a quota message", () => {
      expect(friendlyCallableError(bareError("resource-exhausted"))).toContain(
        "quota",
      );
    });

    it("never echoes the code, bare or namespaced, as the whole message", () => {
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
        const msg = friendlyCallableError(bareError(code));
        expect(msg).not.toBe(code);
        expect(msg).not.toBe(`functions/${code}`);
      }
    });
  });

  describe("operation-specific copy", () => {
    // Codex P2 on #423: timeout-class copy is shared by every
    // callable surface, so hardcoding resume wording gave the JD
    // parse an unrelated diagnosis and remediation.
    it("names the operation in the internal-timeout message", () => {
      const msg = friendlyCallableError(bareError("internal"), {
        operation: "parsing the job description",
      });
      expect(msg).toContain("parsing the job description");
      expect(msg).not.toContain("resume");
    });

    it("names the operation in the deadline-exceeded message", () => {
      const msg = friendlyCallableError(bareError("deadline-exceeded"), {
        operation: "extracting your resume",
      });
      expect(msg).toContain("extracting your resume");
    });

    it("appends a caller-supplied timeout hint", () => {
      const msg = friendlyCallableError(bareError("internal"), {
        operation: "extracting your resume",
        timeoutHint: "Try trimming it.",
      });
      expect(msg).toContain("Try trimming it.");
    });

    it("omits the hint entirely when the caller supplies none", () => {
      // Generation reads from stored data; there is nothing to trim,
      // so it must not inherit another surface's advice.
      const msg = friendlyCallableError(bareError("internal"), {
        operation: "generating your resume",
      });
      expect(msg).not.toContain("trim");
      expect(msg).toContain("generating your resume");
    });

    it("ignores a whitespace-only hint rather than leaving a dangling space", () => {
      const msg = friendlyCallableError(bareError("internal"), {
        operation: "doing the thing",
        timeoutHint: "   ",
      });
      expect(msg).toBe(msg.trim());
      expect(msg).not.toContain("  ");
    });

    it("falls back to neutral wording with no operation given", () => {
      const msg = friendlyCallableError(bareError("internal"));
      expect(msg).toContain("that request");
      expect(msg).not.toContain("resume");
    });

    it("does not apply operation copy to non-timeout codes", () => {
      const msg = friendlyCallableError(bareError("unauthenticated"), {
        operation: "extracting your resume",
      });
      expect(msg).toBe("Your session expired. Sign in again and retry.");
    });
  });

  describe("server-authored messages", () => {
    it("prefers the server's message over the code map", () => {
      // What `extractFromResumeCallable` actually throws when the
      // extraction retry budget is exhausted.
      const err = serverError(
        "failed-precondition",
        "Extraction failed after retries; needs manual review.",
      );
      expect(friendlyCallableError(err)).toBe(
        "Extraction failed after retries; needs manual review.",
      );
    });

    it("prefers the server's message even for codes with a mapping", () => {
      const err = serverError("invalid-argument", "Paste some text first.");
      expect(friendlyCallableError(err)).toBe("Paste some text first.");
    });

    it("ignores operation options when the server wrote the message", () => {
      const err = serverError("internal", "The pipeline exploded.");
      expect(
        friendlyCallableError(err, { operation: "extracting your resume" }),
      ).toBe("The pipeline exploded.");
    });

    it("falls back to the code map when the message is whitespace only", () => {
      expect(friendlyCallableError(serverError("internal", "   "))).toContain(
        "stopped responding",
      );
    });
  });

  describe("errors from other Firebase products", () => {
    it("passes through an unprefixed code's real message", () => {
      // `RoleDetail`'s parse handler shares one catch between a
      // Firestore write and the callable, so non-callable errors
      // reach this mapper too.
      const err = Object.assign(new Error("Missing or insufficient permissions."), {
        code: "permission-denied",
      });
      expect(friendlyCallableError(err)).toBe(
        "Missing or insufficient permissions.",
      );
    });
  });

  describe("boundary and non-callable inputs", () => {
    it("returns the generic message for an unmapped code", () => {
      expect(friendlyCallableError(bareError("unimplemented"))).toBe(
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
