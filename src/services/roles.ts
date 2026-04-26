import { FirebaseError } from "firebase/app";
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

/**
 * Fetch a Role doc by id. Returns `undefined` for BOTH
 * "doc doesn't exist" AND "doc exists but caller doesn't own
 * it" — anti-enumeration mirror of the server-side pattern
 * at #109 / #120.
 *
 * The Firestore rules layer rejects cross-owner reads with
 * `permission-denied`. Without this catch, a foreign Role id
 * would surface as a thrown error that the container would
 * route to its "error" state — leaking that the doc EXISTS
 * (a missing doc would just return `snap.exists() === false`,
 * a different code path). Collapsing both shapes to
 * `undefined` means the caller can't distinguish the two,
 * matching the spec's anti-enumeration contract.
 *
 * cursor CHANGES_REQUESTED round 1 on PR #132 caught this.
 *
 * Other error codes (transport, unauthenticated, etc.)
 * propagate normally so the container's error state still
 * fires for genuine failures.
 */
export async function getRole(id: string): Promise<Role | undefined> {
  try {
    const snap = await getDoc(roleRef(id));
    return snap.exists() ? snap.data() : undefined;
  } catch (err) {
    if (err instanceof FirebaseError && err.code === "permission-denied") {
      return undefined;
    }
    throw err;
  }
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
