import {
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";

import type { UnitMatch } from "../types/capability.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
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

/**
 * List every UnitMatch produced by the matching pipeline (#99)
 * for a given Role. Powers the Matches tab (#21).
 *
 * Owner-scoped + `role_id` direct match. The `role_id` field is
 * denormalized from `jobRequirementUnits.role_id` onto every
 * UnitMatch at persist time so this query doesn't have to join
 * through Requirements (Firestore's `in`-clause has a 30-value
 * limit which would force chunking on Roles with many
 * Requirements). See `UnitMatch.role_id` docstring for the
 * write-side denormalization contract.
 *
 * Sorted high-to-low by `final_score` server-side via the
 * composite index in `firestore.indexes.json`. The matching
 * pipeline also pre-sorts before persist, so a fresh match set
 * is already ordered — but a Match the user later approves
 * (rev'ing `approved_for_use`) shouldn't disturb the rank, so
 * the index keeps the read deterministic.
 */
export async function listMatchesByRole(
  roleId: string,
): Promise<UnitMatch[]> {
  const snap = await getDocs(
    query(
      col(),
      ...ownerScope(),
      where("role_id", "==", roleId),
      orderBy("final_score", "desc"),
    ),
  );
  return snap.docs.map((d) => d.data());
}

/**
 * Subscribe to UnitMatch changes for a Role. Same query shape
 * as `listMatchesByRole`. Returns the firestore `Unsubscribe`
 * cleanup function — the caller (a React effect) must invoke
 * it on unmount.
 */
export function subscribeMatchesByRole(
  roleId: string,
  callback: (matches: UnitMatch[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    col(),
    ...ownerScope(),
    where("role_id", "==", roleId),
    orderBy("final_score", "desc"),
  );
  return onSnapshot(
    q,
    (snap) => callback(snap.docs.map((d) => d.data())),
    onError,
  );
}

/** See `upsertExperienceUnit` for the owner_uid-stamping rationale. */
export async function upsertMatch(
  match: Omit<UnitMatch, "owner_uid">,
): Promise<void> {
  await setDoc(
    ref(match.id),
    { ...match, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}
