import { where, type QueryConstraint } from "firebase/firestore";

import { getAuthClient } from "../firebase.ts";

/**
 * Return the `owner_uid` of the currently authenticated user, or
 * undefined if no user is signed in. Prefer `getOwnerUidOrThrow()`
 * when the caller cannot proceed without a uid — unscoped Firestore
 * queries are rejected wholesale by rules and leak a confusing error.
 */
export function currentOwnerUid(): string | undefined {
  return getAuthClient().currentUser?.uid ?? undefined;
}

/**
 * Pure assertion helper. Extracted so the throw behavior can be
 * unit-tested without mocking Firebase's auth module.
 */
export function ownerUidOrThrow(uid: string | undefined): string {
  if (!uid) {
    throw new Error(
      "Service-layer call requires a signed-in user, but currentUser is null. " +
        "The route guard in App.tsx should prevent this — if you're hitting it, " +
        "you're calling the service layer from an unauthenticated context.",
    );
  }
  return uid;
}

/**
 * Return the current user's uid or throw. The thrown path is the "bug
 * in caller" branch — routes are gated by the AuthProvider, so no
 * signed-in-required service should fire before auth resolves.
 */
export function getOwnerUidOrThrow(): string {
  return ownerUidOrThrow(currentOwnerUid());
}

/**
 * Firestore query scope that restricts a list operation to documents
 * owned by the current user. Every `list*` function in the service
 * layer spreads this into its query so the query shape matches what
 * `firestore.rules` allows.
 *
 * Firestore evaluates list-query rules against the *query constraint*,
 * not the returned documents — an unscoped `getDocs(query(col()))`
 * is rejected wholesale even if every returned doc would pass
 * per-document rules. See firestore.rules for the owner_uid invariant.
 *
 * Throws via `getOwnerUidOrThrow()` if no user is signed in. Post-#57,
 * the auth gate in App.tsx ensures every service call happens with a
 * resolved user — hitting this throw signals a bug (service call
 * originated from an unguarded code path).
 */
export function ownerScope(): QueryConstraint[] {
  return [where("owner_uid", "==", getOwnerUidOrThrow())];
}
