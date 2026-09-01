/**
 * Pure helper: decide whether the Matches tab should
 * auto-trigger the `runMatching` callable on first load
 * (#131 + cursor #134 r1).
 *
 * Why this is a separate module:
 *
 *   The container's `useEffect` watches multiple state
 *   dependencies; the gate logic determines whether to fire
 *   ONCE per Role mount. Bugs in the gate compose silently
 *   (premature fire = wasted LLM call + false zero state;
 *   missed fire = empty Matches tab forever). Lifting the
 *   pure decision out of the effect makes it directly
 *   unit-testable without mocking Firestore.
 *
 *   cursor CHANGES_REQUESTED round 1 on PR #134 caught the
 *   prior shape: the gate gated on `status === "ready"` and
 *   `matches.length === 0`, but `status="ready"` was driven
 *   by the FIRST REQUIREMENTS snapshot — Matches subscribes
 *   separately, so during the window between "Requirements
 *   snapshot arrived" and "Matches snapshot arrived" the
 *   `matches.length === 0` check would falsely succeed
 *   against the INITIAL state, even on a Role with persisted
 *   matches. The new `matchesFirstSnapshotReceived` gate
 *   closes that race.
 */

import type { LoadState } from "./RoleDetailView.tsx";

export interface AutoTriggerGateInputs {
  /** Container's discriminated load state. */
  readonly status: LoadState;
  /**
   * True iff the Matches Firestore subscription has
   * delivered AT LEAST ONE snapshot for the current Role.
   * Until this flips, `matchCount === 0` is just the
   * initial-state default — NOT a meaningful signal that
   * the Role has no persisted matches.
   */
  readonly matchesFirstSnapshotReceived: boolean;
  /** Most recent Matches snapshot's length. */
  readonly matchCount: number;
  /** Most recent Requirements snapshot's length. */
  readonly requirementCount: number;
  /** True once we've fired the trigger OR observed a non-empty matches set. */
  readonly alreadyTriggered: boolean;
  /**
   * True when at least one persisted match predates
   * `structural_evidence` (#435) — the field is absent rather
   * than `false`.
   *
   * Such rows can't be evaluated by `computeGaps`'s evidence
   * gate, so a must-have they cover may be covered on neutral
   * credit alone. Rerunning matching recomputes the flag, and
   * matching is cheap — no LLM call once embeddings exist, per
   * `specs/matchline.md` — so the fix is simply to fire once on
   * the next Role view rather than leave the Role in a stale
   * state until the user thinks to rerun by hand.
   *
   * Without this, the `matchCount > 0` short-circuit below
   * would keep legacy Roles stale indefinitely: the user has
   * no reason to suspect a rerun is needed, and nothing else
   * triggers one. Codex P2 round 2 on PR #435.
   */
  readonly hasEvidenceUnscoredMatches: boolean;
}

export function shouldAutoTriggerMatching(
  inputs: AutoTriggerGateInputs,
): boolean {
  // (1) Role must be loaded — we know it exists + we own it.
  if (inputs.status !== "ready") return false;
  // (2) Matches subscription must have produced at least one
  //     real snapshot. Without this, an empty `matches`
  //     array is just the initial state, not a known-empty
  //     storage signal. cursor #134 r1 caught the bug.
  if (!inputs.matchesFirstSnapshotReceived) return false;
  // (3) We haven't already fired (or seen non-empty
  //     matches that signaled "no need to fire"). Refs in
  //     the container hold this across renders.
  if (inputs.alreadyTriggered) return false;
  // (4) There must be Requirements to score against. With
  //     zero, matching has nothing to do — DON'T mark
  //     triggered, so a later parsing run delivering
  //     Requirements re-evaluates the gate.
  if (inputs.requirementCount === 0) return false;
  // (5) And the Role must currently have no persisted
  //     matches. With one or more, the user already saw
  //     them; rerun would be a no-op — UNLESS some of them
  //     predate `structural_evidence`, in which case the
  //     rerun is what backfills the flag the Gaps view
  //     depends on. Firing is bounded: the caller sets
  //     `alreadyTriggered` when it fires, so this is at most
  //     one rerun per mount even if the backfill somehow
  //     doesn't take.
  if (inputs.matchCount > 0 && !inputs.hasEvidenceUnscoredMatches) {
    return false;
  }
  return true;
}
