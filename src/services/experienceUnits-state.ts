/**
 * Pure state helpers for ExperienceUnit, factored out of
 * `experienceUnits.ts` so they can be exercised without booting
 * Firestore. The Firestore-touching glue in `experienceUnits.ts`
 * delegates to these so the four-way approval state and the re-embed
 * trigger logic are tested at a tight unit-level.
 *
 * If you add a new approval state or a new field that should
 * invalidate the embedding, update the relevant helper here AND its
 * test in `experienceUnits-state.test.ts`. The route layer is not
 * allowed to know about the flag fields directly — it only ever
 * passes a state name through `setApproval(id, state)` and a partial
 * through `updateFields(id, partial)`.
 */

/**
 * The four approval states the Unit Review surface exposes. Each maps
 * to a unique combination of `user_approved` / `rejected` / `flagged`
 * via `flagsForApprovalState()` below.
 */
export type ApprovalState = "approved" | "rejected" | "flagged" | "pending";

export interface ApprovalFlags {
  user_approved: boolean;
  rejected: boolean;
  flagged: boolean;
}

/**
 * Read-direction inverse of `flagsForApprovalState`. Given a Unit,
 * return the `ApprovalState` its three flags encode. Rejected is
 * checked first because `flagsForApprovalState("rejected")` sets
 * `flagged: false`; flagged is checked before approval because the
 * flagged state forces `user_approved: false` by design (see
 * "flagged is exclusive-with-approved" rationale on the write
 * mapping).
 *
 * Consumed by `UnitRow` (for the pill), `Filters` (for the approval
 * filter), and any downstream surface that needs the user-visible
 * state from the stored flags. Keep this as the single source of
 * truth for read-direction state derivation so callers can't
 * independently reinvent the mapping and drift out of sync with
 * `flagsForApprovalState`.
 */
export function displayStateOf(unit: {
  readonly user_approved: boolean;
  readonly rejected?: boolean;
  readonly flagged?: boolean;
}): ApprovalState {
  if (unit.rejected === true) return "rejected";
  if (unit.flagged === true) return "flagged";
  if (unit.user_approved) return "approved";
  return "pending";
}

/**
 * Map an `ApprovalState` to the flag combination that represents it on
 * the Firestore document. Always returns all three flags explicitly
 * (no `undefined`) so the resulting object can be passed to
 * `updateDoc` without leaving stale flags from a prior state — e.g.
 * flipping rejected → approved must clear `rejected: true`, not just
 * set `user_approved: true` and leave a stale rejection.
 *
 * Decision: `flagged` is treated as orthogonal-but-exclusive — setting
 * a Unit to `flagged` forces `user_approved: false`. The rationale is
 * UX: "I want a second look at this" implies "don't use it for
 * matching yet." If we ever need a "flagged AND approved" combination
 * (e.g. "approved but reviewer noted X for the future"), it should be
 * a separate field, not the same `flagged` flag.
 */
export function flagsForApprovalState(state: ApprovalState): ApprovalFlags {
  switch (state) {
    case "approved":
      return { user_approved: true, rejected: false, flagged: false };
    case "rejected":
      return { user_approved: false, rejected: true, flagged: false };
    case "flagged":
      return { user_approved: false, rejected: false, flagged: true };
    case "pending":
      return { user_approved: false, rejected: false, flagged: false };
  }
}

/**
 * Fields whose mutation invalidates the stored embedding. The
 * embedding is computed from `normalized_summary` (and indirectly
 * from `raw_text` upstream of normalization), so changes to either
 * mean the cached vector is stale.
 *
 * Kept as a frozen Set so an accidental `add()` from a future caller
 * throws rather than silently widening the trigger surface.
 */
export const EMBEDDING_INVALIDATING_FIELDS: ReadonlySet<string> = new Set([
  "raw_text",
  "normalized_summary",
]);

/**
 * Predicate: does this partial update touch any field that
 * invalidates the embedding? If yes, the service layer must set
 * `reembed_pending: true` on the same write so the re-embed callable
 * (sub-issue #84) picks the Unit up.
 */
export function shouldMarkReembed(
  partial: Readonly<Record<string, unknown>>,
): boolean {
  for (const key of Object.keys(partial)) {
    if (EMBEDDING_INVALIDATING_FIELDS.has(key)) return true;
  }
  return false;
}

/**
 * Fields the generic `updateFields` service method refuses at
 * runtime. Mirrors (and belts-and-suspenders) the compile-time
 * exclusion in `EditableFields`. Two families:
 *
 *   - **State-machine-owned** (approval flags + re-embed flag):
 *     owned by `setApproval` and the re-embed lifecycle; a bypass
 *     recreates the Codex-P1 stale-flag contradiction.
 *   - **Server-stamped immutable** (id, owner_uid, created_at):
 *     set once on insert. Overwriting id silently re-targets the
 *     doc; overwriting owner_uid would be rejected by rules but
 *     pollutes intent; overwriting created_at loses the insert
 *     timestamp. `updated_at` is in this set too — `updateFields`
 *     stamps it itself from the current clock, and a caller-supplied
 *     value would override that.
 *
 * Exported so the service and the tests stay in lockstep — add a
 * field here to widen the guard, and the test in
 * `experienceUnits-state.test.ts` will verify every entry rejects.
 */
export const STATE_MACHINE_OWNED_FIELDS: readonly string[] = [
  "user_approved",
  "rejected",
  "flagged",
  "reembed_pending",
] as const;

export const SERVER_STAMPED_IMMUTABLE_FIELDS: readonly string[] = [
  "id",
  "owner_uid",
  "created_at",
  "updated_at",
] as const;

/**
 * Translate a partial update payload into a Firestore-valid
 * shape, converting explicit `undefined` on any field into a
 * deletion sentinel. The `deleteSentinel` factory is injected so
 * this helper stays pure — the caller (the service's
 * `updateFields`) passes Firestore's `deleteField()`; tests pass
 * a stand-in marker to verify the translation happens without
 * booting Firestore.
 *
 * Load-bearing for optional-field removal: the inline-edit form
 * from #81 signals "remove this optional field" by including its
 * key in the partial with `undefined` (the natural TS shape of
 * "the user cleared this"), but Firestore's `updateDoc` rejects
 * raw undefined. Codex P1 on #90 caught the prior service
 * behavior which spread raw undefined into updateDoc — clearing
 * the date range would fail the save every time.
 *
 * Always stamps `updated_at` from the injected timestamp.
 */
export function buildUpdatePayload<TDeleteSentinel>(
  partial: Readonly<Record<string, unknown>>,
  options: {
    readonly now: string;
    readonly deleteSentinel: () => TDeleteSentinel;
  },
): Record<string, unknown> {
  const update: Record<string, unknown> = { updated_at: options.now };
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) {
      update[key] = options.deleteSentinel();
    } else {
      update[key] = value;
    }
  }
  return update;
}

/**
 * Runtime guard: throw if a partial update touches any
 * state-machine-owned or server-stamped immutable field. The
 * thrown error names the correct entry point (or explains why the
 * field is immutable) so the caller's first stack trace tells them
 * where to go.
 *
 * The compile-time `EditableFields` Omit is the primary defense;
 * this guard catches JS-land callers and `as any` bypasses. Codex
 * P1 (round 1) motivated the state-machine set; Codex P2 (round 2)
 * motivated widening to the server-stamped immutables.
 */
export function assertNoStateMachineFields(
  partial: Readonly<Record<string, unknown>>,
): void {
  for (const forbidden of STATE_MACHINE_OWNED_FIELDS) {
    if (forbidden in partial) {
      throw new Error(
        `updateFields: "${forbidden}" is owned by the approval/re-embed ` +
          `state machine. Use setApproval(id, state) to flip approval flags ` +
          `and markReembedPending(id, pending) to clear the re-embed flag.`,
      );
    }
  }
  for (const forbidden of SERVER_STAMPED_IMMUTABLE_FIELDS) {
    if (forbidden in partial) {
      throw new Error(
        `updateFields: "${forbidden}" is server-stamped and immutable after ` +
          `insert. id/owner_uid/created_at are set once on create; ` +
          `updated_at is stamped by updateFields itself on every write.`,
      );
    }
  }
}

/**
 * Input shape for `buildManualUnit` and the public `manualInsert`
 * service. Required fields are the minimum a manual Unit needs to be
 * useful for matching; everything else has a sensible default applied
 * inside `buildManualUnit`. Defaults at this boundary mean future
 * non-form entry paths (e.g. CLI importer, bulk upload) get the same
 * defaults without reimplementing them.
 */
export interface ManualUnitInput {
  raw_text: string;
  normalized_summary: string;
  unit_type: import("../types/capability.ts").UnitType;

  source_ref?: string;
  skills?: string[];
  tools?: string[];
  domains?: string[];
  seniority_signals?: string[];
  scope_signals?: string[];
  business_outcomes?: string[];
  metrics?: import("../types/capability.ts").Metric[];
  date_range?: import("../types/capability.ts").DateRange;

  /** Defaults to 1.0 — user-entered Units are user-trusted. */
  confidence_score?: number;
  /** Defaults to true — manual entries are pre-approved. */
  user_approved?: boolean;
}

/**
 * Pure constructor for a manually-authored ExperienceUnit. Stamps
 * every server-controlled or default field so the result is a fully
 * valid `ExperienceUnit` ready to write to Firestore.
 *
 * Extracted from the `manualInsert` service so the stamping rules
 * (defaults, `source_type: "manual"`, `evidence_type: "user_confirmed"`,
 * conditional `date_range` spread) can be unit-tested without
 * mocking Firestore or auth — see `experienceUnits-state.test.ts`.
 */
export function buildManualUnit(
  input: ManualUnitInput,
  ownerUid: string,
  id: string,
  nowIso: string,
): import("../types/capability.ts").ExperienceUnit {
  return {
    id,
    owner_uid: ownerUid,
    source_type: "manual",
    source_ref: input.source_ref ?? "manual entry",
    raw_text: input.raw_text,
    normalized_summary: input.normalized_summary,
    unit_type: input.unit_type,
    skills: input.skills ?? [],
    tools: input.tools ?? [],
    domains: input.domains ?? [],
    seniority_signals: input.seniority_signals ?? [],
    scope_signals: input.scope_signals ?? [],
    business_outcomes: input.business_outcomes ?? [],
    metrics: input.metrics ?? [],
    evidence_type: "user_confirmed",
    confidence_score: input.confidence_score ?? 1.0,
    user_approved: input.user_approved ?? true,
    // Manual Units are born needing an embedding — they arrive with
    // no stored vector and the re-embed callable (#84) is the only
    // path that computes one. Without this flag, a manual Unit
    // would stay permanently unembedded until an unrelated edit
    // triggered the flag. Codex P2 review on #78 caught this.
    reembed_pending: true,
    created_at: nowIso,
    updated_at: nowIso,
    // Conditional spread — Firestore rejects explicit `undefined` on
    // optional fields; the field must be omitted entirely when absent.
    ...(input.date_range !== undefined ? { date_range: input.date_range } : {}),
  };
}
