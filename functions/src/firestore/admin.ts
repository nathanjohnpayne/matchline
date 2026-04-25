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
 *
 * **Test-init contract.** The integration test in
 * `tests/matching-replace.integration.test.ts` runs this code under
 * the Firestore emulator. It MUST call `initializeAdminAppForTests`
 * exported below — NOT `initializeApp` from `firebase-admin/app`
 * directly. Codex P1 on PR #104 caught that the root `firebase-admin`
 * install (the test's import resolution) and the functions-copy
 * (this file's import resolution) are SEPARATE module instances
 * with separate default-app registries. Initializing the root copy
 * leaves this copy throwing "default app does not exist" because
 * its registry is empty. Routing the init through this module
 * forces the same module instance both sides use.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import type { Firestore } from "firebase-admin/firestore";
import { getFirestore } from "firebase-admin/firestore";

let db: Firestore | undefined;

export function getAdminDb(): Firestore {
  if (!db) db = getFirestore();
  return db;
}

/**
 * Initialize the firebase-admin default app for the integration
 * test harness. Idempotent (no-op if a default app already exists).
 *
 * MUST be called from the functions-package module instance — i.e.
 * tests import this function via `../functions/src/firestore/admin.ts`
 * rather than calling `initializeApp` directly. Same Codex-P1
 * rationale as the file docstring.
 */
export function initializeAdminAppForTests(projectId: string): void {
  if (getApps().length === 0) {
    initializeApp({ projectId });
  }
}
