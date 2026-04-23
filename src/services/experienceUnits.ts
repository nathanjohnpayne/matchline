import {
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  type QueryConstraint,
} from "firebase/firestore";

import type { ExperienceUnit } from "../types/capability.ts";

import { ownerScope } from "./auth.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

const PATH = "experienceUnits";

const col = () => typedCollection<ExperienceUnit>(PATH);
const ref = (id: string) => typedDoc<ExperienceUnit>(PATH, id);

export async function listExperienceUnits(
  ...constraints: QueryConstraint[]
): Promise<ExperienceUnit[]> {
  const snap = await getDocs(query(col(), ...ownerScope(), ...constraints));
  return snap.docs.map((d) => d.data());
}

export async function listApprovedExperienceUnits(): Promise<ExperienceUnit[]> {
  return listExperienceUnits(where("user_approved", "==", true));
}

export async function getExperienceUnit(
  id: string,
): Promise<ExperienceUnit | undefined> {
  const snap = await getDoc(ref(id));
  return snap.exists() ? snap.data() : undefined;
}

export async function upsertExperienceUnit(unit: ExperienceUnit): Promise<void> {
  await setDoc(ref(unit.id), unit, { merge: true });
}
