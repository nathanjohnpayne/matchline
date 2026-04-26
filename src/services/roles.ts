import {
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
  type QueryConstraint,
  type Unsubscribe,
} from "firebase/firestore";

import type { JobRequirementUnit } from "../types/capability.ts";
import type { Role } from "../types/crm.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

const ROLES = "roles";
const REQUIREMENTS = "jobRequirementUnits";

const roleCol = () => typedCollection<Role>(ROLES);
const roleRef = (id: string) => typedDoc<Role>(ROLES, id);
const reqCol = () => typedCollection<JobRequirementUnit>(REQUIREMENTS);
const reqRef = (id: string) => typedDoc<JobRequirementUnit>(REQUIREMENTS, id);

export async function listRoles(
  ...constraints: QueryConstraint[]
): Promise<Role[]> {
  const snap = await getDocs(query(roleCol(), ...ownerScope(), ...constraints));
  return snap.docs.map((d) => d.data());
}

export async function getRole(id: string): Promise<Role | undefined> {
  const snap = await getDoc(roleRef(id));
  return snap.exists() ? snap.data() : undefined;
}

/** See `upsertExperienceUnit` for the owner_uid-stamping rationale. */
export async function upsertRole(
  role: Omit<Role, "owner_uid">,
): Promise<void> {
  await setDoc(
    roleRef(role.id),
    { ...role, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}

export async function listRequirementsForRole(
  roleId: string,
): Promise<JobRequirementUnit[]> {
  const snap = await getDocs(
    query(reqCol(), ...ownerScope(), where("role_id", "==", roleId)),
  );
  return snap.docs.map((d) => d.data());
}

/**
 * Subscribe to JobRequirementUnit changes for a Role.
 * Powers the Matches tab's left-side rows (#21 / sub-issue
 * #129). Returns the firestore `Unsubscribe` cleanup
 * function — caller (a React effect) must invoke it on
 * unmount.
 *
 * Same owner_uid + role_id query shape as
 * `listRequirementsForRole`; the subscription path lets
 * the editor inline-edit a Requirement and have the
 * Matches tab re-render against the new normalized text.
 */
export function subscribeRequirementsForRole(
  roleId: string,
  callback: (requirements: JobRequirementUnit[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    reqCol(),
    ...ownerScope(),
    where("role_id", "==", roleId),
  );
  return onSnapshot(
    q,
    (snap) => callback(snap.docs.map((d) => d.data())),
    onError,
  );
}

/** See `upsertExperienceUnit` for the owner_uid-stamping rationale. */
export async function upsertRequirement(
  req: Omit<JobRequirementUnit, "owner_uid">,
): Promise<void> {
  await setDoc(
    reqRef(req.id),
    { ...req, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}
