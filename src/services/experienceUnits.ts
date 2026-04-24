import {
  deleteField,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type QueryConstraint,
  type Unsubscribe,
  type UpdateData,
} from "firebase/firestore";

import type { ExperienceUnit } from "../types/capability.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
import {
  assertNoStateMachineFields,
  buildManualUnit,
  buildUpdatePayload,
  DELETABLE_EDITABLE_FIELDS,
  flagsForApprovalState,
  shouldMarkReembed,
  type ApprovalState,
  type ManualUnitInput,
} from "./experienceUnits-state.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

const PATH = "experienceUnits";

const col = () => typedCollection<ExperienceUnit>(PATH);
const ref = (id: string) => typedDoc<ExperienceUnit>(PATH, id);

/**
 * Default `id` factory used by `manualInsert`. Browser-native crypto
 * is universally supported on modern browsers and in node 19+ (vitest
 * runs node 20). Tests can inject a deterministic factory via the
 * optional `deps` arg.
 */
function defaultId(): string {
  return globalThis.crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function listExperienceUnits(
  ...constraints: QueryConstraint[]
): Promise<ExperienceUnit[]> {
  const snap = await getDocs(query(col(), ...ownerScope(), ...constraints));
  return snap.docs.map((d) => d.data());
}

/**
 * Returns Units that are eligible to enter the matching pipeline.
 * Used by both the Role Detail Matches tab (sub-issue #21) and the
 * `#82` rejected-exclusion integration test that pins the
 * zero-fabrication invariant at the service boundary.
 *
 * Eligibility = `user_approved == true`. Rejected and flagged Units
 * are NOT approved (see `flagsForApprovalState`), so a single
 * positive check is sufficient — but the docstring is explicit so a
 * future maintainer doesn't add a `where("rejected", "!=", true)`
 * thinking the filter is incomplete (Firestore would require a
 * separate composite index for that combination, and it's already
 * implied by `user_approved == true`).
 */
export async function listApprovedExperienceUnits(): Promise<ExperienceUnit[]> {
  return listExperienceUnits(where("user_approved", "==", true));
}

/**
 * Units the user has explicitly rejected. Powers the rejected-review
 * tab in the Unit Review surface (#79 / #82). Distinct from "pending"
 * (which is `user_approved: false` AND `rejected` unset/false).
 */
export async function listRejectedExperienceUnits(): Promise<ExperienceUnit[]> {
  return listExperienceUnits(where("rejected", "==", true));
}

export async function getExperienceUnit(
  id: string,
): Promise<ExperienceUnit | undefined> {
  const snap = await getDoc(ref(id));
  return snap.exists() ? snap.data() : undefined;
}

/**
 * Realtime subscription to every Unit owned by the current user. The
 * Unit Review list view (sub-issue #79) is the primary consumer; it
 * receives the full owner-scoped set and applies filters client-side
 * (V1 single-user data volume is well under any need for indexed
 * server-side filtering — see #80 for the filter UI).
 *
 * Returns the firestore `Unsubscribe` cleanup function — the caller
 * (a React effect) must invoke it on unmount.
 */
export function subscribeByOwner(
  callback: (units: ExperienceUnit[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(col(), ...ownerScope());
  return onSnapshot(
    q,
    (snap) => callback(snap.docs.map((d) => d.data())),
    onError,
  );
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

/**
 * Fields `updateFields` refuses to edit. Broken into two groups:
 *
 *   - **Server-stamped identity.** `id`, `owner_uid`, `created_at`
 *     are set at insert time and never mutate. `updated_at` is
 *     stamped by `updateFields` itself on every write. Letting a
 *     caller pass these via the partial would silently overwrite
 *     them.
 *   - **State-machine-owned.** `user_approved`, `rejected`, and
 *     `flagged` together encode a four-way state that MUST only
 *     flip via `setApproval()`. The Codex P1 review on #78 caught
 *     a real bug here: before this exclusion, a caller could write
 *     `{ user_approved: true }` against a rejected Unit and leave
 *     `rejected: true` in place — a contradictory document that
 *     would pass both the approved query (used by matching) and
 *     the rejected query. `reembed_pending` is in the same family:
 *     owned by `updateFields`'s internal logic + the re-embed
 *     callable, never by an ad-hoc partial from a route.
 *
 * The type-level exclusion gives a compile-time error if a caller
 * passes any of these — the approval bug can't recur silently.
 */
type EditableFields = Omit<
  ExperienceUnit,
  | "id"
  | "owner_uid"
  | "created_at"
  | "updated_at"
  | "reembed_pending"
  | "user_approved"
  | "rejected"
  | "flagged"
>;

/**
 * Apply a partial update to a Unit. Two automatic side effects:
 *
 *   1. `updated_at` is bumped to now (the caller never sets it).
 *   2. If the partial touches a field that invalidates the embedding
 *      (`raw_text` or `normalized_summary`), `reembed_pending: true`
 *      is set on the same write so the re-embed callable (#84) picks
 *      it up.
 *
 * The caller is forbidden from passing `reembed_pending` directly —
 * use `markReembedPending()` for the callable's flag-clear path.
 */
export async function updateFields(
  id: string,
  partial: Partial<EditableFields>,
): Promise<void> {
  // Type-level guard (EditableFields Omit) is the primary defense;
  // this runtime guard catches JS-land or `as any` bypasses that
  // would otherwise recreate the Codex-P1 stale-flag contradiction.
  assertNoStateMachineFields(partial as Readonly<Record<string, unknown>>);

  // Build the update payload via the pure helper, translating
  // explicit `undefined` on optional fields into `deleteField()`
  // sentinels. Firestore's `updateDoc` rejects raw `undefined` —
  // the #81 inline-edit form signals "remove this optional field"
  // by including the key with `undefined`, and the service layer
  // is the narrowest place to convert to the Firestore-valid
  // sentinel. Codex P1 on #90 caught this.
  const update = buildUpdatePayload(
    partial as Readonly<Record<string, unknown>>,
    {
      now: nowIso(),
      deleteSentinel: deleteField,
      // Only `date_range` is optional in EditableFields; every
      // other editable field is required and `undefined` on it
      // would be a caller bug. Whitelist narrows the delete
      // translation to exactly what's safe to clear.
      // nathanpayne-codex Phase 4b on #90.
      deletableFields: DELETABLE_EDITABLE_FIELDS,
    },
  ) as UpdateData<ExperienceUnit>;
  if (shouldMarkReembed(partial as Readonly<Record<string, unknown>>)) {
    update.reembed_pending = true;
  }
  await updateDoc(ref(id), update);
}

/**
 * Atomically flip the approval state. Always writes the full
 * `user_approved` / `rejected` / `flagged` triple via
 * `flagsForApprovalState()` so a transition from one state to another
 * cannot leave a stale flag from the prior state — see the
 * "rejected → approved" regression test in
 * `experienceUnits-state.test.ts`.
 */
export async function setApproval(
  id: string,
  state: ApprovalState,
): Promise<void> {
  await updateDoc(ref(id), {
    ...flagsForApprovalState(state),
    updated_at: nowIso(),
  });
}

/**
 * Setter for the re-embed flag. Used by the re-embed callable (#84)
 * to clear the flag after a successful embedding refresh, and (in
 * principle) by an admin path to re-queue. Routes don't call this —
 * they go through `updateFields`, which sets the flag automatically
 * when relevant.
 */
export async function markReembedPending(
  id: string,
  pending: boolean,
): Promise<void> {
  await updateDoc(ref(id), {
    reembed_pending: pending,
    updated_at: nowIso(),
  });
}

export interface ManualInsertDeps {
  readonly generateId?: () => string;
  readonly now?: () => string;
}

/**
 * Re-export so callers can `import { ManualUnitInput } from
 * "./experienceUnits.ts"` rather than reaching into the state module.
 * The state module owns the type because `buildManualUnit` (the pure
 * stamping logic) consumes it.
 */
export type { ManualUnitInput };

/**
 * Create a new manually-authored ExperienceUnit. Stamps
 * `source_type: "manual"`, `source_ref: "manual entry"` (unless
 * overridden), `evidence_type: "user_confirmed"`, the current
 * `owner_uid` from auth, and a fresh UUID. Returns the new id.
 *
 * Defaults and stamping are pure-fn'd into `buildManualUnit` (in
 * `experienceUnits-state.ts`) so the rules can be exercised without
 * mocking Firestore or auth. This wrapper just resolves the three
 * runtime-y inputs (id, now, ownerUid) and calls Firestore.
 */
export async function manualInsert(
  data: ManualUnitInput,
  deps: ManualInsertDeps = {},
): Promise<string> {
  const generateId = deps.generateId ?? defaultId;
  const now = deps.now ?? nowIso;
  const id = generateId();
  const unit = buildManualUnit(data, getOwnerUidOrThrow(), id, now());
  await setDoc(ref(id), unit);
  return id;
}
