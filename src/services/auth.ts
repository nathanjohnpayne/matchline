import { where, type QueryConstraint } from "firebase/firestore";

import { getAuthClient } from "../firebase.ts";

/**
 * Return the `owner_uid` of the currently authenticated user, or
 * undefined if no user is signed in.
 *
 * Sprint 1 wires Firebase Auth. Until then, there is no signed-in user
 * and service-layer callers must tolerate `undefined`.
 */
export function currentOwnerUid(): string | undefined {
  return getAuthClient().currentUser?.uid ?? undefined;
}

/**
 * Firestore query scope that restricts a list operation to documents
 * owned by the current user. Every `list*` function in the service
 * layer MUST spread this into its query so the query shape matches
 * what `firestore.rules` allows.
 *
 * Firestore evaluates list-query rules against the *query constraint*,
 * not the returned documents — an unscoped `getDocs(query(col()))`
 * will be rejected wholesale even if every returned doc would pass
 * per-document rules. See firestore.rules for the owner_uid invariant.
 *
 * Sprint 0 does not perform live reads, so the helper returns `[]`
 * when no user is signed in — this is the pre-auth pass-through.
 * Sprint 1 must add Firebase Auth wiring (see plan § Phase 1 c1) and
 * either throw here or require callers to check for auth upstream.
 */
export function ownerScope(): QueryConstraint[] {
  const uid = currentOwnerUid();
  if (!uid) return [];
  return [where("owner_uid", "==", uid)];
}
