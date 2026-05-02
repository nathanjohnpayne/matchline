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
  | "auth/network-request-failed"
  // Google SSO popup-flow codes (#26 / sign-in expansion).
  | "auth/popup-closed-by-user"
  | "auth/cancelled-popup-request"
  | "auth/popup-blocked"
  | "auth/account-exists-with-different-credential"
  | "auth/operation-not-allowed"
  | "auth/unauthorized-domain";

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
    // Google SSO popup paths. Closed-by-user is the most common
    // and is intentional — surface a soft message rather than an
    // alarming error. cancelled-popup-request fires when a second
    // popup is opened before the first resolves; same friendly
    // soft-message treatment.
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled. Try again?";
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in popup. Allow popups for this site and try again, or use email + password below.";
    case "auth/account-exists-with-different-credential":
      // The user previously signed up with a different provider
      // (e.g. email/password) under the same email. Firebase's
      // default linking behavior requires server-side coordination;
      // for V1 just steer the user to the right path.
      return "An account with this email already exists with a different sign-in method. Try email + password below.";
    case "auth/operation-not-allowed":
      // Google provider not enabled in the Firebase console.
      // Should never hit in normal use; surface the diagnostic.
      return "Google sign-in is not enabled for this app. Use email + password below.";
    case "auth/unauthorized-domain":
      // The current domain isn't on the OAuth redirect allowlist.
      // Same diagnostic class as operation-not-allowed.
      return "Google sign-in isn't authorized for this domain. Use email + password below.";
    default:
      return "Something went wrong. Try again.";
  }
}
