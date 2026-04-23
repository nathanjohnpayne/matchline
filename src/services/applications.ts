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

export async function getApplication(
  id: string,
): Promise<Application | undefined> {
  const snap = await getDoc(ref(id));
  return snap.exists() ? snap.data() : undefined;
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
