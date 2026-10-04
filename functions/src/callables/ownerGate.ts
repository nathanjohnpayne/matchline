/**
 * Owner allowlist and input-size gate shared by every callable (#439).
 *
 * ## Why authentication is not enough
 *
 * Matchline V1 is single-user (`specs/matchline.md`, `.ai_context.md`),
 * but Firebase Auth admits any account that can sign in — Google SSO
 * alone accepts every Google account. Before this module, each callable
 * checked `request.auth?.uid` and nothing else, so "signed in" was the
 * whole authorization story for handlers that bind the Anthropic and
 * OpenAI secrets. Ownership checks inside the pipelines (`owner_uid`
 * stamping, role/application ownership) scope *data*; they do not
 * bound *spend*, because a new account simply owns its own empty data.
 *
 * `requireOwner` makes the single-user scope an authorization rule:
 * the caller's uid must be on an explicit allowlist, checked first in
 * every handler, before argument parsing and before any LLM or
 * Firestore client is constructed.
 *
 * ## Configuration
 *
 * The allowlist is the `MATCHLINE_OWNER_UIDS` string param: one or
 * more Firebase Auth uids, comma-separated. It deliberately has no
 * default, so `firebase deploy` refuses to proceed (or prompts, when
 * interactive) until it is set — normally in
 * `functions/.env.<projectId>`, which the CLI writes on first prompt.
 * See DEPLOYMENT.md § Owner allowlist.
 *
 * **Fail closed.** An unset, empty, or all-whitespace value admits
 * nobody. A misconfigured deploy therefore locks the owner out
 * visibly (every call returns `permission-denied`) rather than
 * silently reopening the instance.
 *
 * The same uid must also be listed in the Firestore document
 * `config/access` (`owner_uids`) for `firestore.rules` to admit client
 * reads and writes; the rules cannot read function params.
 * `functions/scripts/set-owner-allowlist.ts` writes that document from
 * this same value. Each layer fails closed on its own.
 *
 * ## Why uid, not email
 *
 * A uid names exactly one account. An email allowlist has to reason
 * about `email_verified`, provider linking and address reuse, and the
 * rules-side allowlist is keyed by uid anyway. One identifier, one
 * failure mode.
 *
 * ## Why not an Auth blocking function
 *
 * `beforeUserCreated` would stop stranger accounts from existing at
 * all, but under this project's domain-restricted-sharing org policy
 * every deploy of an Auth blocking trigger retries a forbidden IAM
 * write and fails — DEPLOYMENT.md § Function inventory records that
 * as a reason not to add one. The allowlist enforces the same
 * boundary at the point that costs money.
 */

import { defineString } from "firebase-functions/params";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";

/**
 * Comma-separated Firebase Auth uids allowed to invoke callables.
 * Read at call time via `.value()`; never at module load, which runs
 * during deploy discovery when params are not resolved.
 */
export const ownerUidsParam = defineString("MATCHLINE_OWNER_UIDS", {
  description:
    "Comma-separated Firebase Auth uids allowed to call Matchline's callables. " +
    "Single-user V1: normally exactly one uid. Empty admits nobody.",
});

/**
 * Upper bound on a pasted-text payload (resume or JD), in UTF-8 bytes.
 *
 * A long resume is ~20-30 KB of text and a long JD well under that;
 * 100 KB leaves several-fold headroom while bounding the prompt a
 * single call can send to the model. Measured in bytes, not
 * characters, because bytes are what the request carries and what
 * tokenization scales with — a character count undercounts
 * multi-byte text.
 */
export const MAX_TEXT_INPUT_BYTES = 100 * 1024;

/**
 * Parse the raw param value into a set of uids. Pure — exported for
 * tests. Tolerates whitespace and empty segments ("a, ,b" → {a, b})
 * so a trailing comma in an env file cannot turn into an allowlisted
 * empty-string uid.
 */
export function parseOwnerAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Resolve the allowlist from the deployed param. */
export function ownerAllowlistFromParam(): ReadonlySet<string> {
  return parseOwnerAllowlist(ownerUidsParam.value());
}

/**
 * Authorize a callable request. Throws `unauthenticated` when there is
 * no signed-in user, `permission-denied` when the user is not on the
 * allowlist; otherwise returns the caller's uid.
 *
 * Call this as the first statement of every callable handler. The
 * `allowlist` argument exists for tests; production callers use the
 * default.
 */
export function requireOwner(
  request: Pick<CallableRequest<unknown>, "auth">,
  callableName: string,
  allowlist: ReadonlySet<string> = ownerAllowlistFromParam(),
): string {
  const uid = request.auth?.uid;
  if (typeof uid !== "string" || uid.length === 0) {
    throw new HttpsError(
      "unauthenticated",
      `${callableName} requires a signed-in user.`,
    );
  }
  if (!allowlist.has(uid)) {
    // Deliberately says nothing about how the allowlist is
    // configured or who is on it.
    throw new HttpsError(
      "permission-denied",
      "This Matchline instance is restricted to its owner.",
    );
  }
  return uid;
}

/**
 * Reject a pasted-text payload larger than `MAX_TEXT_INPUT_BYTES`.
 * Run after the type/emptiness checks and before the pipeline, so an
 * oversized payload never reaches a model.
 */
export function assertTextWithinLimit(
  text: string,
  maxBytes: number = MAX_TEXT_INPUT_BYTES,
): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    const limitKb = Math.floor(maxBytes / 1024);
    throw new HttpsError(
      "invalid-argument",
      `That text is too long (limit ${limitKb} KB). Trim it and try again.`,
      { bytes, maxBytes },
    );
  }
}
