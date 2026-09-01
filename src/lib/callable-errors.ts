/**
 * Map Firebase callable (`httpsCallable`) failures to human-readable
 * messages. Pure function — testable in isolation; a calling route's
 * only responsibility is rendering the returned string.
 *
 * Mirrors the convention `auth-errors.ts` established for the sign-in
 * surface, for the same reason: the provider's raw error text is not
 * user-facing copy.
 *
 * **Why this exists (#424, found via #422).** When a callable dies
 * without returning a well-formed Firebase error body — a Cloud Run
 * request-timeout kill, an uncaught server exception, a CORS-less
 * 500, or a rejected preflight that never reached the function at
 * all — `fetch` rejects and
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
 *
 * **The namespace trap.** `FunctionsError`'s constructor stores
 * `functions/${code}` (see `@firebase/functions`, and the public
 * `FunctionsErrorCode` type, which is literally
 * `` `functions/${FunctionsErrorCodeCore}` ``) while the synthesized
 * message stays the *bare* code. So the comparison above has to
 * normalize first: a naive `message === code` is `"internal" ===
 * "functions/internal"`, which is false, and the module would hand
 * back the very one-word banner it exists to replace. Codex caught
 * this on PR #423 — the first version of this file had the bug, and
 * its tests hid it by fabricating unnamespaced codes instead of the
 * SDK's real error shape. The tests now build real `FunctionsError`
 * instances so the shape cannot drift from reality again.
 *
 * **The status-suffix trap.** `@firebase/functions` 0.14.0 changed the
 * final line of `_errorForResponse` to
 * `new FunctionsError(code, \`${description} [${httpStatus}]\`, ...)`,
 * appending the HTTP status to *every* message. A bare code becomes
 * `internal [0]`, and our own `HttpsError` text becomes
 * `Extraction failed after retries; needs manual review. [400]`.
 * Both a `message === code` check and the raw pass-through break on
 * that. This repo installs 0.13.6, which has no suffix — verified in
 * `node_modules` and corroborated by the #422 screenshots, whose
 * banner read exactly `internal`. So it is latent, not live; but
 * Dependabot bumps `firebase` here, so it activates on upgrade
 * rather than in theory. Codex caught it on PR #423. Both the
 * bare-code comparison and the pass-through strip the suffix.
 */

import { FunctionsError } from "firebase/functions";

/** `FUNCTIONS_TYPE` in `@firebase/functions`; every code carries it. */
const CODE_PREFIX = "functions/";

/**
 * Trailing ` [<http status>]` that `@firebase/functions` >= 0.14.0
 * appends to every callable error message. Anchored and bounded to
 * 1-3 digits so it cannot eat a legitimate trailing bracket.
 */
const STATUS_SUFFIX = / \[\d{1,3}\]$/;

/**
 * SDK-generated stand-in used by >= 0.14.0 when the response body
 * carries an `error.status` but no `error.message`. It is machine
 * text, not copy written for a user, so it counts as bare.
 */
const BACKEND_STATUS_PREFIX = /^(Unknown b|B)ackend error status: /;

/**
 * Callable status codes this module maps explicitly, in their bare
 * (un-namespaced) form. Not the full `FunctionsErrorCodeCore` set —
 * only the codes reachable from the surfaces we actually call.
 * Anything else takes the default branch.
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
 * Neutral stand-in for `operation` so the default copy is accurate
 * for any caller. Reads as "...before that request finished".
 */
const DEFAULT_OPERATION = "that request";

export interface FriendlyCallableErrorOptions {
  /**
   * What the user was doing, as a noun phrase that reads naturally
   * after "before ... finished" and as the subject of "... timed
   * out" — e.g. `"extracting your resume"`, `"parsing the job
   * description"`.
   *
   * Timeout-class copy is shared by every callable surface, so
   * without this the JD-parse banner would tell the user their
   * *resume* took too long. Codex P2 on PR #423.
   */
  readonly operation?: string;
  /**
   * Caller-specific remediation appended to timeout-class messages.
   * Only surfaces that can actually act on it should pass one —
   * "trim your input" is good advice on a paste surface and
   * meaningless on a generate-from-stored-data surface.
   */
  readonly timeoutHint?: string;
}

/**
 * Read the callable error code off an unknown thrown value and strip
 * the `functions/` namespace. Returns `undefined` for anything that
 * isn't shaped like a `FunctionsError` — a plain `Error`, a string, a
 * rejected non-Error — so those take the generic branch rather than
 * matching on a coincidental `code` property of the wrong type.
 *
 * A code without the prefix is passed through unchanged: errors from
 * other Firebase products (a Firestore write that shares a catch
 * block with a callable, as in `RoleDetail`'s parse handler) reach
 * here too, and they carry real messages that the bare-code check
 * below will correctly prefer.
 */
function callableCode(err: unknown): string | undefined {
  const raw = (err as FunctionsError | undefined)?.code;
  if (typeof raw !== "string") return undefined;
  return raw.startsWith(CODE_PREFIX) ? raw.slice(CODE_PREFIX.length) : raw;
}

/**
 * True when the SDK filled `message` in from the status code because
 * the response carried no error body of its own. See the module
 * docstring — this is what separates "the server told us something"
 * from "the request died".
 *
 * `bareCode` is the normalized code; the raw namespaced form is
 * checked too, so a future SDK that stops stripping the prefix from
 * the synthesized message still reads as bare rather than as
 * server-authored.
 */
function normalizedMessage(err: unknown): string | undefined {
  const message = (err as FunctionsError | undefined)?.message;
  if (typeof message !== "string") return undefined;
  return message.replace(STATUS_SUFFIX, "").trim();
}

function isBareCode(err: unknown, bareCode: string): boolean {
  const message = normalizedMessage(err);
  if (message === undefined || message === "") return true;
  if (BACKEND_STATUS_PREFIX.test(message)) return true;
  return message === bareCode || message === `${CODE_PREFIX}${bareCode}`;
}

function joinHint(sentence: string, hint: string | undefined): string {
  return hint === undefined || hint.trim() === ""
    ? sentence
    : `${sentence} ${hint.trim()}`;
}

export function friendlyCallableError(
  err: unknown,
  options: FriendlyCallableErrorOptions = {},
): string {
  const code = callableCode(err);
  if (code === undefined) return GENERIC;

  // The server wrote this message for a human. Prefer it — minus the
  // SDK's status suffix, which is diagnostic noise in a banner.
  if (!isBareCode(err, code)) {
    return normalizedMessage(err) ?? GENERIC;
  }

  const operation = options.operation ?? DEFAULT_OPERATION;
  const hint = options.timeoutHint;

  switch (code) {
    case "internal":
      // `internal` is the SDK's catch-all for "the request died
      // without a well-formed Firebase error body" — it covers a
      // Cloud Run timeout kill, an uncaught server exception, AND a
      // request that never reached the function at all (a rejected
      // CORS preflight surfaces identically; that turned out to be
      // the real cause of #422). The code alone cannot distinguish
      // them, so the copy must not assert a specific diagnosis.
      // "Stopped responding" is true of every one of them, and
      // "try again" is the right next step for a user in all three.
      return joinHint(
        `The server stopped responding before ${operation} finished. ` +
          `Try again.`,
        hint,
      );
    case "deadline-exceeded":
      return joinHint(
        `${operation} took longer than expected and timed out. Try again.`,
        hint,
      );
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
