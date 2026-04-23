import {
  getDocs,
  query,
  setDoc,
  where,
} from "firebase/firestore";

import type { UnitMatch } from "../types/capability.ts";

import { ownerScope } from "./auth.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

const PATH = "unitMatches";

const col = () => typedCollection<UnitMatch>(PATH);
const ref = (id: string) => typedDoc<UnitMatch>(PATH, id);

export async function listMatchesForRequirement(
  requirementId: string,
): Promise<UnitMatch[]> {
  const snap = await getDocs(
    query(col(), ...ownerScope(), where("job_requirement_unit_id", "==", requirementId)),
  );
  return snap.docs.map((d) => d.data());
}

export async function listMatchesForUnit(
  experienceUnitId: string,
): Promise<UnitMatch[]> {
  const snap = await getDocs(
    query(col(), ...ownerScope(), where("experience_unit_id", "==", experienceUnitId)),
  );
  return snap.docs.map((d) => d.data());
}

export async function upsertMatch(match: UnitMatch): Promise<void> {
  await setDoc(ref(match.id), match, { merge: true });
}
