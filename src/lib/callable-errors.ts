/**
 * Map Firebase callable (`httpsCallable`) failures to human-readable
 * messages. Pure function — testable in isolation; a calling route's
 * only responsibility is rendering the returned string.
 *
 * Mirrors the convention `auth-errors.ts` established for the sign-in
 * surface, for the same reason: the provider's raw error text is not
 * user-facing copy.
 *
 * **Why this exists (#422).** When a callable dies without returning a
 * well-formed Firebase error body — a Cloud Run request-timeout kill,
 * an uncaught server exception, a CORS-less 500 — `fetch` rejects and
 * `@firebase/functions` synthesizes `{ status: 0 }`. Its
 * `_errorForResponse` then defaults `description` to the error *code*,
 * so `FunctionsError.message` is the literal string `"internal"`. The
 * Onboarding route rendered that verbatim and the user got a
 * one-word, unactionable banner.
 *
 * **The bare-code test.** A callable that fails deliberately — every
 * `HttpsError` our functions throw — carries a real message written
 * for the user ("Extraction failed after retries; needs manual
 * review."). A callable that fails structurally carries a message
 * identical to its code. That difference is the whole signal: we
 * prefer the server's own message whenever it is not just the code
 * echoed back, and fall through to the code map only when it is.
 * That keeps every intentional server message authoritative without
 * this module having to enumerate them.
 */

import type { FunctionsError } from "firebase/functions";

/**
 * Callable status codes this module maps explicitly. Not the full
 * `FunctionsErrorCode` set — only the codes reachable from the
 * surfaces we actually call. Anything else takes the default branch.
 */
export type MappedCallableErrorCode =
  | "internal"
  | "deadline-exceeded"
  | "unavailable"
  | "unauthenticated"
  | "permission-denied"
  | "invalid-argument"
  | "failed-precondition"
  | "resource-exhausted"
  | "cancelled";

const GENERIC = "Something went wrong. Try again.";

/**
 * Read the callable error code off an unknown thrown value.
 * Returns `undefined` for anything that isn't shaped like a
 * `FunctionsError` — a plain `Error`, a string, a rejected
 * non-Error — so those take the generic branch rather than
 * matching on a coincidental `code` property of the wrong type.
 */
function callableCode(err: unknown): string | undefined {
  const code = (err as FunctionsError | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True when the SDK filled `message` in from the status code because
 * the response carried no error body of its own. See the module
 * docstring — this is what separates "the server told us something"
 * from "the request died".
 */
function isBareCode(err: unknown, code: string): boolean {
  const message = (err as FunctionsError | undefined)?.message;
  return typeof message !== "string" || message.trim() === "" || message === code;
}

export function friendlyCallableError(err: unknown): string {
  const code = callableCode(err);
  if (code === undefined) return GENERIC;

  // The server wrote this message for a human. Prefer it.
  if (!isBareCode(err, code)) {
    return (err as FunctionsError).message;
  }

  switch (code) {
    case "internal":
      // The #422 case. `internal` on a long-running callable is
      // almost always the request being killed at the server's
      // timeout, so lead with the interpretation that's actionable
      // rather than the literal one ("an internal error occurred"),
      // which tells the user nothing they can act on.
      return "The server stopped responding before extraction finished. This usually means the resume took too long to process — try again, or trim it to the roles most relevant to your target market.";
    case "deadline-exceeded":
      return "Extraction took longer than expected and timed out. Try again, or trim the resume to the roles most relevant to your target market.";
    case "unavailable":
      return "Couldn't reach the server. Check your connection and try again.";
    case "unauthenticated":
      return "Your session expired. Sign in again and retry.";
    case "permission-denied":
      return "You don't have access to that.";
    case "invalid-argument":
      return "The server rejected that input. Check the content and try again.";
    case "failed-precondition":
      // Reached only if a `failed-precondition` arrives without its
      // message — our own throws always carry one, so this is the
      // defensive branch.
      return "The server couldn't complete this step. Try again; if it keeps failing, the content may need manual review.";
    case "resource-exhausted":
      return "Rate limit or quota reached. Wait a moment and try again.";
    case "cancelled":
      return "That request was cancelled. Try again.";
    default:
      return GENERIC;
  }
}
