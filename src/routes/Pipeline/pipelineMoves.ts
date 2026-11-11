/**
 * Optimistic stage moves for the Pipeline board (#511, sub-issue of
 * #32). A pure reducer over the board's Applications: a move applies
 * at once, then the write either confirms it or rolls it back.
 *
 * The reducer keeps the pre-move Application for every in-flight move,
 * so a rollback restores exactly what was there (stage AND
 * `last_activity_at`) rather than guessing. A card with a move in
 * flight cannot be moved again until that write settles; otherwise a
 * late failure of the first write would roll back over the second.
 */

import type { Application, ApplicationStage, UUID } from "../../types/crm.ts";

import { PIPELINE_STAGES } from "./buildPipelineBoard.ts";

export interface PipelineMoveState {
  readonly applications: readonly Application[];
  /** Application id → the Application as it was before its in-flight move. */
  readonly pending: ReadonlyMap<UUID, Application>;
}

export type PipelineMoveAction =
  | { readonly type: "loaded"; readonly applications: readonly Application[] }
  | {
      readonly type: "move";
      readonly id: UUID;
      readonly stage: ApplicationStage;
      /** ISO time of the move; the new `last_activity_at`. */
      readonly at: string;
    }
  | { readonly type: "confirm"; readonly id: UUID }
  | { readonly type: "fail"; readonly id: UUID }
  | {
      /**
       * Activity recorded elsewhere (a completed task, #34) moved
       * `last_activity_at`, and that write has already landed. While a
       * move of the card is in flight the touch is merged into the
       * stored pre-move snapshot too, so a later rollback restores the
       * persisted timestamp instead of the stale one (Codex P2 on
       * #585). Timestamps only move forward.
       */
      readonly type: "touched";
      readonly id: UUID;
      readonly at: string;
    };

export const EMPTY_MOVE_STATE: PipelineMoveState = {
  applications: [],
  pending: new Map(),
};

/**
 * True when moving `id` to `stage` would do nothing: an unknown
 * Application, its own column, or a move already in flight. The
 * container checks this before writing, so a no-op never reaches
 * Firestore.
 */
export function isNoopMove(
  state: PipelineMoveState,
  id: UUID,
  stage: ApplicationStage,
): boolean {
  if (state.pending.has(id)) return true;
  const app = state.applications.find((a) => a.id === id);
  return app === undefined || app.stage === stage;
}

/**
 * The stage one column to the left (`-1`) or right (`+1`) of `stage`,
 * or `null` at either end of the board. Drives the keyboard move.
 */
export function neighborStage(
  stage: ApplicationStage,
  direction: -1 | 1,
): ApplicationStage | null {
  const i = PIPELINE_STAGES.indexOf(stage);
  if (i === -1) return null;
  return PIPELINE_STAGES[i + direction] ?? null;
}

function withoutPending(
  pending: ReadonlyMap<UUID, Application>,
  id: UUID,
): ReadonlyMap<UUID, Application> {
  const next = new Map(pending);
  next.delete(id);
  return next;
}

export function pipelineMoveReducer(
  state: PipelineMoveState,
  action: PipelineMoveAction,
): PipelineMoveState {
  switch (action.type) {
    case "loaded":
      return { applications: action.applications, pending: new Map() };
    case "move": {
      if (isNoopMove(state, action.id, action.stage)) return state;
      const before = state.applications.find((a) => a.id === action.id);
      if (before === undefined) return state;
      const pending = new Map(state.pending);
      pending.set(action.id, before);
      return {
        applications: state.applications.map((a) =>
          a.id === action.id
            ? { ...a, stage: action.stage, last_activity_at: action.at }
            : a,
        ),
        pending,
      };
    }
    case "confirm":
      if (!state.pending.has(action.id)) return state;
      return { ...state, pending: withoutPending(state.pending, action.id) };
    case "touched": {
      if (!state.applications.some((a) => a.id === action.id)) return state;
      const later = (current: string): string =>
        Date.parse(action.at) > Date.parse(current) ? action.at : current;
      const before = state.pending.get(action.id);
      let pending = state.pending;
      if (before !== undefined) {
        const next = new Map(state.pending);
        next.set(action.id, {
          ...before,
          last_activity_at: later(before.last_activity_at),
        });
        pending = next;
      }
      return {
        applications: state.applications.map((a) =>
          a.id === action.id
            ? { ...a, last_activity_at: later(a.last_activity_at) }
            : a,
        ),
        pending,
      };
    }
    case "fail": {
      const before = state.pending.get(action.id);
      if (before === undefined) return state;
      return {
        applications: state.applications.map((a) =>
          a.id === action.id ? before : a,
        ),
        pending: withoutPending(state.pending, action.id),
      };
    }
  }
}
