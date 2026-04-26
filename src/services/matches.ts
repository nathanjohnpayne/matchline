import {
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
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

/**
 * Toggle a UnitMatch's `approved_for_use` flag. The
 * Matches tab (#21 / sub-issue #129) wires this to the
 * Approve button; the generation pipeline (#120 +
 * #121) reads `approved_for_use === true` as the gate
 * for which Units flow into the LLM prompt.
 *
 * **Mutual exclusion with `user_rejected` is enforced
 * here.** Approving a previously-rejected match (or a
 * match that the matching pipeline at #82 already filtered
 * via `user_rejected`) MUST clear the rejection flag —
 * otherwise the match could land in `{ approved_for_use:
 * true, user_rejected: true }`, which is nonsensical:
 * generation would consume it but the next matching run
 * would silently filter the underlying Unit pair.
 * cursor CHANGES_REQUESTED round 2 on PR #132 caught the
 * gap — the prior version wrote only `approved_for_use`,
 * leaving the stale rejection in place.
 *
 * Symmetric clearing on the un-approve side: setting
 * `approved_for_use: false` does NOT touch `user_rejected`
 * (un-approving is "withdraw approval," not "reject" —
 * those are different user intents). Use `setMatchRejection`
 * (sub-issue #130) for the explicit rejection path.
 *
 * `updateDoc` is preferred over `setDoc(..., { merge: true
 * })` because a future field on `UnitMatch` doesn't have to
 * be defaulted in this call site.
 *
 * Owner check happens at the rules layer, not here. The
 * client-side guard would be a confused-deputy attack
 * surface (an attacker who can write the doc has already
 * bypassed it). `getOwnerUidOrThrow` is in the audit log
 * but not the gate.
 */
export async function setMatchApproval(
  matchId: string,
  approval: { approved_for_use: boolean },
): Promise<void> {
  // When approving (true), also clear any stale rejection
  // flag. When un-approving (false), only flip
  // approved_for_use; un-approving is not the same user
  // intent as rejecting.
  const update: Pick<UnitMatch, "approved_for_use"> &
    Partial<Pick<UnitMatch, "user_rejected">> = approval.approved_for_use
    ? { approved_for_use: true, user_rejected: false }
    : { approved_for_use: false };
  await updateDoc(ref(matchId), update);
}

/**
 * Toggle a UnitMatch's `user_rejected` flag. The Matches tab
 * (#21 / sub-issue #130) wires this to the Reject button;
 * the matching pipeline (#82 / `tests/rejected-exclusion.
 * integration.test.ts`) filters `user_rejected: true`
 * matches OUT of the input set on re-run, which propagates
 * to generation as "the underlying Unit pair has nothing
 * to ground on for this Requirement."
 *
 * **Symmetric mutual exclusion with `approved_for_use`,
 * mirroring `setMatchApproval`.** Rejecting a previously-
 * approved match MUST clear the approval flag — otherwise
 * the match could land in `{ approved_for_use: true,
 * user_rejected: true }`, which generation would consume
 * (it gates on `approved_for_use === true`) but the next
 * matching run would drop. cursor's #132 r2 catch named
 * this surface; the symmetric write here closes the same
 * gap on the rejection side.
 *
 * Un-rejecting (`user_rejected: false`) does NOT touch
 * `approved_for_use` — un-reject is "withdraw rejection,"
 * not "approve." If the user wants the match approved
 * after un-rejecting, that's a separate `setMatchApproval`
 * click.
 */
export async function setMatchRejection(
  matchId: string,
  rejection: { user_rejected: boolean },
): Promise<void> {
  // When rejecting (true), also clear any stale approval
  // flag. When un-rejecting (false), only flip
  // user_rejected; un-rejecting is not the same user
  // intent as approving.
  const update: Pick<UnitMatch, "user_rejected"> &
    Partial<Pick<UnitMatch, "approved_for_use">> = rejection.user_rejected
    ? { user_rejected: true, approved_for_use: false }
    : { user_rejected: false };
  await updateDoc(ref(matchId), update);
}
