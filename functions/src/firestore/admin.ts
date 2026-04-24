/**
 * firebase-admin Firestore singleton for server-side writes. The
 * admin SDK bypasses firestore.rules by default — callable handlers
 * that use this must validate auth themselves (the callable wrapper
 * already throws `unauthenticated` for missing request.auth).
 *
 * Kept intentionally small: all server-side Firestore access routes
 * through `getAdminDb()` so tests can mock at one choke point and
 * so the first line that wires real data has a named home to live
 * alongside.
 */

import type { Firestore } from "firebase-admin/firestore";
import { getFirestore } from "firebase-admin/firestore";

let db: Firestore | undefined;

export function getAdminDb(): Firestore {
  if (!db) db = getFirestore();
  return db;
}
