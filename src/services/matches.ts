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
 * The user's review state for a UnitMatch. Three values
 * encode the full state space of the `(approved_for_use,
 * user_rejected)` flag pair:
 *
 *   - `approved`  → `{ approved_for_use: true,  user_rejected: false }`
 *   - `rejected`  → `{ approved_for_use: false, user_rejected: true  }`
 *   - `none`      → `{ approved_for_use: false, user_rejected: false }`
 *
 * The contradictory `{ approved_for_use: true, user_rejected:
 * true }` shape is structurally unrepresentable in this enum;
 * `setMatchApprovalState` is the single write surface, so
 * it can't be produced by callers either.
 */
export type MatchApprovalState = "approved" | "rejected" | "none";

/**
 * Compute the canonical user-action state from the persisted
 * flag pair. The persisted shape can in theory drift if a
 * future schema change skips this service; this function
 * defaults a `(true, true)` shape to "rejected" because the
 * matching pipeline (#82) filters rejected matches out, so
 * preferring the more conservative interpretation matches
 * the zero-fab discipline.
 */
export function approvalStateOf(
  match: Pick<UnitMatch, "approved_for_use" | "user_rejected">,
): MatchApprovalState {
  if (match.user_rejected) return "rejected";
  if (match.approved_for_use) return "approved";
  return "none";
}

/**
 * Atomically set a UnitMatch's user-review state. The
 * Matches tab (#21 / sub-issues #129 + #130) wires this to
 * both the Approve and Reject buttons via a single call:
 * the UI layer computes the next `MatchApprovalState` from
 * the click + current state, then issues ONE write.
 *
 * **Why one setter, not two.** The prior shape used separate
 * `setMatchApproval` and `setMatchRejection`. Each was atomic
 * per-call (writing both flags consistently), but rapid
 * back-to-back clicks could issue two pending writes whose
 * server-application order isn't airtight across offline
 * resync, multi-tab scenarios, or other Firestore corner
 * cases. CodeRabbit on PR #133 caught the race; the
 * single-setter shape eliminates it because each click
 * produces exactly one `updateDoc`. Per-doc per-client write
 * ordering means the LAST submitted write wins
 * deterministically.
 *
 * **Why the enum, not booleans.** A boolean pair has 4 states
 * but only 3 are valid (`(true, true)` is contradictory).
 * The enum makes the invalid state unrepresentable at the
 * type level; future callers (batch import, CLI, etc.) can't
 * accidentally produce it.
 *
 * Generation (#120 + #121) gates on `approved_for_use ===
 * true`; matching (#82) filters `user_rejected === true` OUT
 * on re-run. Both consume the persisted flags, not this
 * enum directly — the enum is the WRITE-side abstraction.
 *
 * Owner check happens at the rules layer, not here.
 */
export async function setMatchApprovalState(
  matchId: string,
  state: MatchApprovalState,
): Promise<void> {
  const update: Pick<UnitMatch, "approved_for_use" | "user_rejected"> =
    state === "approved"
      ? { approved_for_use: true, user_rejected: false }
      : state === "rejected"
        ? { approved_for_use: false, user_rejected: true }
        : { approved_for_use: false, user_rejected: false };
  await updateDoc(ref(matchId), update);
}
