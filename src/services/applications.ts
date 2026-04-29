import { FirebaseError } from "firebase/app";
import {
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  type QueryConstraint,
} from "firebase/firestore";

import type { Application, ApplicationStage } from "../types/crm.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

const PATH = "applications";

const col = () => typedCollection<Application>(PATH);
const ref = (id: string) => typedDoc<Application>(PATH, id);

export async function listApplications(
  ...constraints: QueryConstraint[]
): Promise<Application[]> {
  const snap = await getDocs(query(col(), ...ownerScope(), ...constraints));
  return snap.docs.map((d) => d.data());
}

export async function listApplicationsByStage(
  stage: ApplicationStage,
): Promise<Application[]> {
  return listApplications(where("stage", "==", stage));
}

/**
 * Fetch an Application doc by id. Returns `undefined` for BOTH
 * "doc doesn't exist" AND "doc exists but caller doesn't own it"
 * — anti-enumeration mirror of `getRole` (and the server-side
 * pattern at #109 / #120).
 *
 * The Firestore rules layer rejects cross-owner reads with
 * `permission-denied`. Without this catch, a foreign Application
 * id would surface as a thrown error that the ApplicationEditor
 * container would route to its "error" state — leaking that the
 * doc EXISTS (a missing doc would just return
 * `snap.exists() === false`, a different code path). Collapsing
 * both shapes to `undefined` means the caller can't distinguish
 * the two, matching the not-found surface the editor renders.
 *
 * Codex P2 on PR #181 caught the inconsistency with `getRole`.
 *
 * Other error codes (transport, unauthenticated, etc.) propagate
 * normally so the container's error state still fires for genuine
 * failures.
 */
export async function getApplication(
  id: string,
): Promise<Application | undefined> {
  try {
    const snap = await getDoc(ref(id));
    return snap.exists() ? snap.data() : undefined;
  } catch (err) {
    if (err instanceof FirebaseError && err.code === "permission-denied") {
      return undefined;
    }
    throw err;
  }
}

/** See `upsertExperienceUnit` for the owner_uid-stamping rationale. */
export async function upsertApplication(
  app: Omit<Application, "owner_uid">,
): Promise<void> {
  await setDoc(
    ref(app.id),
    { ...app, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}
