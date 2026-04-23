/**
 * Map Firebase Auth error codes to human-readable messages for the
 * sign-in surface. Pure function — testable in isolation; the SignIn
 * route's only responsibility is rendering the returned string.
 *
 * Anti-enumeration: we don't reveal whether an email is registered,
 * so `auth/user-not-found`, `auth/wrong-password`, and
 * `auth/invalid-credential` all collapse to the same generic message.
 */

import type { AuthError } from "firebase/auth";

export type AuthErrorCode =
  | "auth/invalid-email"
  | "auth/weak-password"
  | "auth/email-already-in-use"
  | "auth/invalid-credential"
  | "auth/wrong-password"
  | "auth/user-not-found"
  | "auth/too-many-requests"
  | "auth/network-request-failed";

export function friendlyAuthError(err: unknown): string {
  const code = (err as AuthError | undefined)?.code;
  switch (code) {
    case "auth/invalid-email":
      return "That doesn't look like a valid email.";
    case "auth/weak-password":
      // Firebase's server-side default policy rejects <6 chars, but
      // the form's client-side minLength is 8 (stricter UX). Keeping
      // the message length-neutral means it stays accurate if
      // Firebase's policy changes or the form's minLength is tuned.
      return "That password is too short. Try a longer one.";
    case "auth/email-already-in-use":
      return "An account with that email already exists. Try signing in.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Email or password didn't match. Try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network request failed. Check your connection and try again.";
    default:
      return "Something went wrong. Try again.";
  }
}
