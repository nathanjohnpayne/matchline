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
 * exclusion in `EditableFields`. Keeps the approval state machine
 * (owned by `setApproval`) and the re-embed flag lifecycle (owned
 * by `updateFields` internal logic + the re-embed callable) from
 * being bypassed by a JS-land caller or a `partial as any` escape
 * hatch.
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

/**
 * Runtime guard: throw if a partial update touches any
 * state-machine-owned field. The thrown error names the correct
 * entry point so the caller's first stack trace tells them where
 * to go.
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
