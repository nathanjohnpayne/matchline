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
import { httpsCallable } from "firebase/functions";

import { getFunctionsClient } from "../firebase.ts";
import { callableOptions } from "./callable-timeouts.ts";
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

/**
 * Upsert a UnitMatch directly. Most callers should NOT use
 * this — the matching pipeline owns match creation and the
 * UI uses `setMatchApprovalState` for the user-action flag
 * pair. This is the escape hatch for tests + the eval
 * harness (#25) + future migration scripts.
 *
 * Stamps `owner_uid` from the signed-in user (see
 * `upsertExperienceUnit` for the rationale).
 *
 * **Rejects the contradictory `(approved_for_use: true,
 * user_rejected: true)` shape.** The unified setter and
 * the carry-forward canonicalization handle the V1 write
 * paths, but `upsertMatch` is a generic write surface that
 * could otherwise produce the bad pair. cursor
 * CHANGES_REQUESTED round 4 on PR #133. The Firestore rule
 * (`isValidUnitMatchWrite`) is the security boundary; this
 * service-layer guard is defense in depth + a clearer
 * error message at the call site.
 */
export async function upsertMatch(
  match: Omit<UnitMatch, "owner_uid">,
): Promise<void> {
  if (match.approved_for_use && match.user_rejected) {
    throw new Error(
      "upsertMatch: refusing to write the contradictory " +
        "{ approved_for_use: true, user_rejected: true } shape. " +
        "Use `setMatchApprovalState` for user-action toggles; " +
        "rejection wins for the canonical interpretation.",
    );
  }
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
 * true`. The matching pipeline's `replaceMatchesForRole`
 * (cursor #133 r2) carries `user_rejected` AND
 * `approved_for_use` forward across rerun by reading the
 * existing match for each (Unit, Requirement) pair before
 * the clear-and-replace, so the user's review state is
 * durable. Note: the `rejected-exclusion` integration test
 * at #82 covers rejected EXPERIENCE UNITS (`user_approved:
 * false`), NOT rejected MATCHES — the rejected-Match
 * carry-forward is pinned by `tests/matching-replace.
 * integration.test.ts` (added in #133 r2).
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

/**
 * Invoke the `runMatching` HTTPS callable (#99). Returns
 * when the server-side persist transaction has committed —
 * the Firestore subscription will deliver the new matches
 * shortly thereafter, so callers typically don't need to
 * read the response.
 *
 * The Matches tab (#21 / sub-issue #131) calls this on
 * auto-trigger when a Role's matches subscription resolves
 * to an empty set on first render.
 *
 * Server-side error mapping (per `runMatching.ts`):
 *   - `unauthenticated` if no auth context
 *   - `invalid-argument` for missing/malformed roleId
 *   - `permission-denied` for foreign/missing role_id
 * Client surfaces these via the rejection path; the caller
 * decides whether to log + retry or surface to the user.
 */
export async function invokeRunMatching(roleId: string): Promise<void> {
  const fn = httpsCallable<
    { roleId: string },
    { matches: UnitMatch[] }
  >(
    getFunctionsClient(),
    "runMatching",
    callableOptions("runMatching"),
  );
  await fn({ roleId });
}
