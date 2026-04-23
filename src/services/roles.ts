import {
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
  type QueryConstraint,
} from "firebase/firestore";

import type { JobRequirementUnit } from "../types/capability.ts";
import type { Role } from "../types/crm.ts";

import { ownerScope } from "./auth.ts";
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

export async function upsertRole(role: Role): Promise<void> {
  await setDoc(roleRef(role.id), role, { merge: true });
}

export async function listRequirementsForRole(
  roleId: string,
): Promise<JobRequirementUnit[]> {
  const snap = await getDocs(
    query(reqCol(), ...ownerScope(), where("role_id", "==", roleId)),
  );
  return snap.docs.map((d) => d.data());
}

export async function upsertRequirement(req: JobRequirementUnit): Promise<void> {
  await setDoc(reqRef(req.id), req, { merge: true });
}
