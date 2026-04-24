/**
 * Pure state helpers for the Unit Review inline-edit flow.
 * Extracted so the edit-mode state machine (view → editing →
 * saving → view/error → editing) is exercisable without booting
 * React. The row component wraps these with `useState`.
 *
 * State machine:
 *
 *   view     —click Edit→        editing
 *   editing  —type in a field→   editing (draft updates)
 *   editing  —click Cancel→      view (draft discarded)
 *   editing  —click Save→        saving (optimistic view uses draft)
 *   saving   —service resolves→  view (draft cleared, subscription
 *                                delivers fresh data on next tick)
 *   saving   —service rejects→   error (draft preserved so the
 *                                user can retry or adjust)
 *   error    —click Retry→       saving
 *   error    —click Cancel→      view (draft discarded)
 *   error    —type in a field→   editing (draft updates, error
 *                                dismissed — user is actively
 *                                fixing)
 *
 * The hook `useInlineEdit.ts` maps UI events to state transitions;
 * this module owns the pure logic those transitions apply.
 */

import type { ExperienceUnit, Metric } from "../../types/capability.ts";

/**
 * Fields the inline-edit UI can mutate. The state-machine- and
 * server-stamped fields (`id`, `owner_uid`, `created_at`,
 * `updated_at`, `embedding`, `user_approved`, `rejected`,
 * `flagged`, `reembed_pending`) are excluded — those flow through
 * their own service methods (`setApproval`, `markReembedPending`,
 * `updateFields`'s internal side effects). A type-level mismatch
 * here would surface at compile time via the `updateFields`
 * signature from #78.
 */
export type EditableUnitFields = Pick<
  ExperienceUnit,
  | "raw_text"
  | "normalized_summary"
  | "source_type"
  | "source_ref"
  | "unit_type"
  | "skills"
  | "tools"
  | "domains"
  | "seniority_signals"
  | "scope_signals"
  | "business_outcomes"
  | "metrics"
  | "evidence_type"
  | "confidence_score"
  | "date_range"
>;

/**
 * Edit-mode status for a single row.
 *
 * **baseSnapshot** is the Unit observed when the user clicked
 * Edit. We diff drafts against this, NOT the live subscription
 * value, so a concurrent update landing mid-edit can't shift
 * the comparison base. nathanpayne-codex Phase 4b on #90.
 */
export type EditStatus =
  | { readonly kind: "view" }
  | {
      readonly kind: "editing";
      readonly draft: EditableUnitFields;
      readonly baseSnapshot: ExperienceUnit;
    }
  | {
      readonly kind: "saving";
      readonly draft: EditableUnitFields;
      readonly baseSnapshot: ExperienceUnit;
    }
  | {
      readonly kind: "error";
      readonly draft: EditableUnitFields;
      readonly baseSnapshot: ExperienceUnit;
      readonly error: Error;
    };

export const VIEW_STATUS: EditStatus = Object.freeze({ kind: "view" });

/**
 * Extract the editable fields from a Unit. Used to seed the draft
 * when the row transitions from view → editing (click Edit).
 */
export function editableFromUnit(unit: ExperienceUnit): EditableUnitFields {
  return {
    raw_text: unit.raw_text,
    normalized_summary: unit.normalized_summary,
    source_type: unit.source_type,
    source_ref: unit.source_ref,
    unit_type: unit.unit_type,
    skills: unit.skills,
    tools: unit.tools,
    domains: unit.domains,
    seniority_signals: unit.seniority_signals,
    scope_signals: unit.scope_signals,
    business_outcomes: unit.business_outcomes,
    metrics: unit.metrics,
    evidence_type: unit.evidence_type,
    confidence_score: unit.confidence_score,
    // Conditional spread — Firestore rejects explicit `undefined`
    // for optional fields and the draft flows into updateFields
    // which writes the whole partial. If the Unit has no
    // date_range, omit the key entirely from the draft.
    ...(unit.date_range !== undefined ? { date_range: unit.date_range } : {}),
  };
}

/**
 * Choose the Unit to render in the row preview, given the live
 * subscription value and the current edit status. Pure so the
 * "rollback on error" policy is unit-tested.
 *
 * Policy (nathanpayne-codex Phase 4b round 2 on #90):
 *
 *   - `view` / `editing`: render the live persisted Unit.
 *   - `saving`: render the optimistic merge of draft over the
 *     edit-start snapshot. Gives instant "this is what's about
 *     to commit" feedback. Snapshot (not live) avoids flicker
 *     if the subscription delivers an update mid-save.
 *   - `error`: render the LIVE persisted Unit. The form below
 *     keeps the draft so the user can retry, but the row
 *     header rolls back to truth — otherwise the optimistic
 *     preview would lie about the persisted state next to the
 *     error banner.
 */
export function presentationUnit(
  liveUnit: ExperienceUnit,
  status: EditStatus,
): ExperienceUnit {
  if (status.kind === "saving") {
    return applyOptimistic(status.baseSnapshot, status.draft);
  }
  return liveUnit;
}

/**
 * Apply a partial update to a `Metric` (one row in the nested
 * metrics editor), stripping any keys whose value is `undefined`
 * so the result has optional fields absent rather than
 * explicit-undefined.
 *
 * Load-bearing for the service-layer write path: the service's
 * `buildUpdatePayload` only sanitizes top-level undefined, so a
 * metric with `value: undefined` would carry into `updateDoc()`
 * and Firestore would reject the save. nathanpayne-codex Phase 4b
 * round 2 on #90 caught this — clearing a metric's value/unit/
 * direction fields would have failed every save.
 *
 * Required Metric fields (`claim`, `confidence`) are unaffected
 * by intent — even if a caller passes them as undefined, the
 * strip removes them and the result is a malformed Metric. The
 * form never passes undefined for those.
 */
export function applyMetricUpdate(
  metric: Metric,
  partial: Partial<Metric>,
): Metric {
  const merged: Record<string, unknown> = { ...metric, ...partial };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete merged[key];
    }
  }
  return merged as unknown as Metric;
}

/**
 * Build the optimistic Unit to render during `saving`. Merges the
 * draft fields over the base Unit so the row shows the change
 * immediately while the service call is in flight. If the call
 * fails, we transition back to `error` with the same draft
 * preserved — the row continues to show the user's edits, not a
 * snap-back to the pre-edit state.
 *
 * Uses `applyDraft` rather than a direct object spread so the
 * `date_range` conditional shape is handled consistently (a
 * draft that cleared `date_range` by not having the key should
 * produce a unit with `date_range` also absent, not a partial
 * merge where the old range leaks through).
 */
export function applyOptimistic(
  base: ExperienceUnit,
  draft: EditableUnitFields,
): ExperienceUnit {
  // Strip date_range from the base so the draft's presence/absence
  // is authoritative. Then apply the full draft.
  const { date_range: _baseRange, ...baseWithoutRange } = base;
  const merged: ExperienceUnit = {
    ...baseWithoutRange,
    ...draft,
  };
  if (draft.date_range === undefined && "date_range" in merged) {
    delete (merged as { date_range?: unknown }).date_range;
  }
  return merged;
}

/**
 * Which fields in the draft differ from the Unit? Returned as a
 * partial whose keys are exactly those that changed. The
 * service's `updateFields` accepts this partial directly — no
 * point sending unchanged fields over the wire (and no point
 * bumping `updated_at` when nothing actually changed).
 *
 * Comparison is shallow + value-equality for primitives, and
 * array-identity-or-length-mismatch for arrays. Good enough at
 * this scale: if a caller sets `skills` to a fresh array with the
 * same entries, we'll write it; Firestore dedups the write anyway.
 * The common cases (append, remove, edit a single field) all
 * produce new references so they diff correctly.
 *
 * `date_range` is compared by nested field equality (start + end)
 * so a swap from `{ start, end }` to `{ start }` is recognized as
 * a change even if `start` is unchanged.
 */
export function draftDiff(
  base: ExperienceUnit,
  draft: EditableUnitFields,
): Partial<EditableUnitFields> {
  const diff: Partial<EditableUnitFields> = {};

  if (draft.raw_text !== base.raw_text) diff.raw_text = draft.raw_text;
  if (draft.normalized_summary !== base.normalized_summary)
    diff.normalized_summary = draft.normalized_summary;
  if (draft.source_type !== base.source_type)
    diff.source_type = draft.source_type;
  if (draft.source_ref !== base.source_ref) diff.source_ref = draft.source_ref;
  if (draft.unit_type !== base.unit_type) diff.unit_type = draft.unit_type;
  if (draft.evidence_type !== base.evidence_type)
    diff.evidence_type = draft.evidence_type;
  if (draft.confidence_score !== base.confidence_score)
    diff.confidence_score = draft.confidence_score;

  if (!stringArrayEqual(draft.skills, base.skills)) diff.skills = draft.skills;
  if (!stringArrayEqual(draft.tools, base.tools)) diff.tools = draft.tools;
  if (!stringArrayEqual(draft.domains, base.domains))
    diff.domains = draft.domains;
  if (!stringArrayEqual(draft.seniority_signals, base.seniority_signals))
    diff.seniority_signals = draft.seniority_signals;
  if (!stringArrayEqual(draft.scope_signals, base.scope_signals))
    diff.scope_signals = draft.scope_signals;
  if (!stringArrayEqual(draft.business_outcomes, base.business_outcomes))
    diff.business_outcomes = draft.business_outcomes;

  if (!metricsEqual(draft.metrics, base.metrics))
    diff.metrics = draft.metrics;

  if (!dateRangeEqual(draft.date_range, base.date_range)) {
    // Set to the draft value (may be undefined — the service
    // layer's `updateFields` will omit the field via conditional
    // spread if absent).
    diff.date_range = draft.date_range;
  }

  return diff;
}

function stringArrayEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function metricsEqual(
  a: ExperienceUnit["metrics"],
  b: ExperienceUnit["metrics"],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (
      ai.claim !== bi.claim ||
      ai.value !== bi.value ||
      ai.unit !== bi.unit ||
      ai.direction !== bi.direction ||
      ai.confidence !== bi.confidence
    ) {
      return false;
    }
  }
  return true;
}

function dateRangeEqual(
  a: ExperienceUnit["date_range"],
  b: ExperienceUnit["date_range"],
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.start === b.start && a.end === b.end;
}
