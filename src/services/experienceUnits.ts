import {
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  type QueryConstraint,
} from "firebase/firestore";

import type { ExperienceUnit } from "../types/capability.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
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

/**
 * Upsert an ExperienceUnit. The caller provides everything except
 * `owner_uid` — it's stamped here from the current auth state so the
 * client SDK never has to compute it and can never mis-stamp it. Any
 * mismatch with the auth user's uid would be rejected by
 * `firestore.rules` anyway; stamping from the verified client-side
 * auth state keeps the rules-layer check tight and makes the service
 * API simpler.
 */
export async function upsertExperienceUnit(
  unit: Omit<ExperienceUnit, "owner_uid">,
): Promise<void> {
  await setDoc(
    ref(unit.id),
    { ...unit, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}
