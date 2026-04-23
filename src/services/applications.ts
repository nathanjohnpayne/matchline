import {
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  type QueryConstraint,
} from "firebase/firestore";

import type { Application, ApplicationStage } from "../types/crm.ts";

import { typedCollection, typedDoc } from "./firestore.ts";

const PATH = "applications";

const col = () => typedCollection<Application>(PATH);
const ref = (id: string) => typedDoc<Application>(PATH, id);

export async function listApplications(
  ...constraints: QueryConstraint[]
): Promise<Application[]> {
  const snap = await getDocs(query(col(), ...constraints));
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

export async function upsertApplication(app: Application): Promise<void> {
  await setDoc(ref(app.id), app, { merge: true });
}
