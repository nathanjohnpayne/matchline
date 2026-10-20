/**
 * Pipeline container (#510, #511; sub-issues of #32). Reads the owner's
 * Applications plus the Roles, Companies, Interactions and People that
 * enrich their cards, joins them with `buildPipelineBoard`, and hands
 * the columns to `PipelineView`.
 *
 * Moving a card (#511) is optimistic: `pipelineMoveReducer` applies the
 * new stage at once, `moveApplicationToStage` writes only `stage` and
 * `last_activity_at`, and a rejected write rolls the card back to its
 * column with an inline error (UI guidance rule 10, never a toast). A
 * drop on the card's own column, or a second move while the first is
 * in flight, writes nothing.
 *
 * Tasks (#34) live in `usePipelineTasks`: the sidebar's Due today /
 * Upcoming / Follow-ups, the card quick-add, and optimistic completion
 * that also resets the card's days in stage.
 *
 * The readers and the writer are injectable (`deps`) so the container
 * can be exercised end to end in a DOM test with fakes; the app renders
 * it with no props and gets the real services.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactElement,
} from "react";

import { beginAppBusy } from "../../lib/appBusy.ts";
import {
  listApplications,
  moveApplicationToStage,
} from "../../services/applications.ts";
import {
  listCompanies,
  listInteractions,
  listPeople,
} from "../../services/people.ts";
import { listRoles } from "../../services/roles.ts";
import { completeTask, createTask, listTasks } from "../../services/tasks.ts";
import type { ApplicationStage, UUID } from "../../types/crm.ts";

import { buildPipelineBoard } from "./buildPipelineBoard.ts";
import {
  loadPipelineData,
  type PipelineData,
  type PipelineReaders,
} from "./loadPipelineData.ts";
import {
  EMPTY_MOVE_STATE,
  isNoopMove,
  pipelineMoveReducer,
} from "./pipelineMoves.ts";
import PipelineView, {
  STAGE_LABELS,
  type PipelineLoadState,
  type PipelineMoves,
} from "./PipelineView.tsx";
import { usePipelineTasks, type PipelineTaskDeps } from "./usePipelineTasks.ts";

export interface PipelineDeps extends PipelineReaders, PipelineTaskDeps {
  readonly moveApplicationToStage: (
    id: UUID,
    stage: ApplicationStage,
    at: string,
  ) => Promise<void>;
  /** Clock for the move time and days-in-stage. */
  readonly now: () => Date;
}

const DEFAULT_DEPS: PipelineDeps = {
  // Wrapped so the service's rest-parameter constraints are not passed
  // an argument.
  listApplications: () => listApplications(),
  listRoles: () => listRoles(),
  listCompanies,
  listInteractions,
  listPeople,
  listTasks,
  moveApplicationToStage,
  createTask: (input, now) => createTask(input, now),
  completeTask,
  now: () => new Date(),
};

export default function Pipeline({
  deps = DEFAULT_DEPS,
}: {
  readonly deps?: PipelineDeps;
}): ReactElement {
  const [status, setStatus] = useState<PipelineLoadState>("loading");
  const [data, setData] = useState<PipelineData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [moveState, dispatch] = useReducer(pipelineMoveReducer, EMPTY_MOVE_STATE);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [focusApplicationId, setFocusApplicationId] = useState<UUID | null>(null);
  // One clock reading per load or move, so the days-in-stage figures
  // agree across every card on the board.
  const [now, setNow] = useState<Date>(() => deps.now());

  useEffect(() => {
    let cancelled = false;
    loadPipelineData(deps).then(
      (next) => {
        if (cancelled) return;
        setData(next);
        dispatch({ type: "loaded", applications: next.applications });
        setNow(deps.now());
        setStatus("ready");
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deps]);

  const columns = useMemo(
    () =>
      data === null
        ? []
        : buildPipelineBoard({
            ...data,
            applications: moveState.applications,
            now,
          }),
    [data, moveState.applications, now],
  );

  /** "Acme: Staff PM" for announcements, with the board's own fallbacks. */
  const describe = useCallback(
    (id: UUID): string => {
      for (const column of columns) {
        const card = column.cards.find((c) => c.applicationId === id);
        if (card !== undefined) {
          return `${card.companyName ?? "Unknown company"}: ${card.roleTitle ?? "Role unavailable"}`;
        }
      }
      return "Application";
    },
    [columns],
  );

  const onMove = useCallback(
    (id: UUID, stage: ApplicationStage): void => {
      if (isNoopMove(moveState, id, stage)) return;
      const from = moveState.applications.find((a) => a.id === id)?.stage;
      const at = deps.now();
      const label = describe(id);
      dispatch({ type: "move", id, stage, at: at.toISOString() });
      setNow(at);
      setMoveError(null);
      setFocusApplicationId(id);
      setAnnouncement(`Moved ${label} to ${STAGE_LABELS[stage]}.`);
      // The write has no lease of its own; hold the update banner's
      // reload off until it settles, as other writes do (#434).
      const releaseBusy = beginAppBusy("pipeline.move");
      deps
        .moveApplicationToStage(id, stage, at.toISOString())
        .then(
          () => dispatch({ type: "confirm", id }),
          (err: unknown) => {
            dispatch({ type: "fail", id });
            const reason = (err instanceof Error ? err.message : String(err))
              .trim()
              .replace(/\.$/, "");
            const back = from === undefined ? "" : ` It's back in ${STAGE_LABELS[from]}.`;
            setMoveError(
              `Couldn't move ${label} to ${STAGE_LABELS[stage]}: ${reason}.${back}`,
            );
            setAnnouncement(
              `Move failed. ${label} is back in ${from === undefined ? "its column" : STAGE_LABELS[from]}.`,
            );
          },
        )
        .finally(releaseBusy);
    },
    [deps, describe, moveState],
  );

  const tasks = usePipelineTasks({
    deps,
    loadedTasks: data?.tasks ?? null,
    // Before the first load there is nothing to withhold.
    tasksLoaded: data?.tasksLoaded ?? true,
    applications: moveState.applications,
    labelFor: describe,
    now,
    dispatch,
    onActivity: setNow,
  });

  const moves: PipelineMoves = {
    onMove,
    pendingIds: new Set(moveState.pending.keys()),
    error: moveError,
    onDismissError: () => setMoveError(null),
    announcement,
    focusApplicationId,
  };

  return (
    <PipelineView
      status={status}
      columns={columns}
      error={error}
      partial={data?.partial ?? false}
      moves={moves}
      tasks={tasks}
    />
  );
}
