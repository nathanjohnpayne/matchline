/**
 * Pipeline board view (#510, sub-issue of #32): seven stage columns of
 * Application cards, built by `buildPipelineBoard`.
 *
 * Moving cards (#511): when the container passes `moves`, a card can
 * be dragged to another column with the browser's native drag API
 * (the drop target gets a 2px border, no animation), or moved one
 * column with the Left / Right arrow keys while focused. Both call the
 * same `moves.onMove`. Without `moves` the board is read-only, which
 * keeps the static-render tests and any read-only caller unchanged.
 *
 * Presentational, no Firestore. The container (`index.tsx`) owns
 * loading, the join, the optimistic state and the write.
 *
 * UI guidance § Pipeline (#32): a muted column header with stage name
 * and count; cards at most three lines (company, muted truncated
 * title, metadata row). Below `md` the board is a vertical stack with
 * pill headers; from `md` up the seven columns sit side by side.
 * Loading and read failures render inline (rule 10), never as a toast.
 *
 * Muted text stays at or above 4.5:1 contrast on its background in
 * both themes (accessibility baseline): zinc-500/600 on light,
 * zinc-400 on dark. zinc-400 on white is about 2.5:1, and zinc-500 on
 * a zinc-100 chip is about 4.4:1, so chips use zinc-600 (CodeRabbit on
 * PR #576).
 */

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { Link } from "react-router-dom";

import type { ApplicationStage, UUID } from "../../types/crm.ts";

import TaskQuickAdd from "../../components/TaskQuickAdd.tsx";

import type { PipelineCard, PipelineColumn } from "./buildPipelineBoard.ts";
import { neighborStage } from "./pipelineMoves.ts";
import TaskSidebar, { type PipelineTasks } from "./TaskSidebar.tsx";

/** `DataTransfer` type carrying a dragged card's Application id. */
export const PIPELINE_CARD_MIME = "application/x-matchline-application";

/** Everything the board needs to make cards movable (#511). */
export interface PipelineMoves {
  /** Move an Application to a stage. The container ignores no-ops. */
  readonly onMove: (applicationId: UUID, stage: ApplicationStage) => void;
  /** Applications whose move is still being written. */
  readonly pendingIds: ReadonlySet<UUID>;
  /** Inline failure from the last rejected move, or `null`. */
  readonly error: string | null;
  readonly onDismissError: () => void;
  /** Polite live-region text describing the last move. */
  readonly announcement: string;
  /** The card to keep focused after it moves (keyboard moves). */
  readonly focusApplicationId: UUID | null;
}

export type PipelineLoadState = "loading" | "ready" | "error";

export interface PipelineViewProps {
  readonly status: PipelineLoadState;
  readonly columns: readonly PipelineColumn[];
  readonly error: Error | null;
  /** Some enrichment data (Roles, Companies, contacts) failed to load. */
  readonly partial: boolean;
  /** Present when cards can be moved; absent for a read-only board. */
  readonly moves?: PipelineMoves;
  /** Present when tasks are enabled (#34): sidebar + card quick-add. */
  readonly tasks?: PipelineTasks;
}

export const STAGE_LABELS: Readonly<Record<ApplicationStage, string>> = {
  saved: "Saved",
  drafting: "Drafting",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** What an empty column is for, so an empty board still teaches the flow. */
export const STAGE_EMPTY_COPY: Readonly<Record<ApplicationStage, string>> = {
  saved: "No applications in Saved. Roles you're tracking but haven't started on sit here.",
  drafting: "No applications in Drafting. This is where a resume is being tailored before you send it.",
  applied: "No applications in Applied. Sent applications wait here until you hear back.",
  interviewing: "No applications in Interviewing. This is where live processes land when you hear back.",
  offer: "No applications in Offer. Offers land here.",
  rejected: "No applications in Rejected. Closed-out applications are kept here for the record.",
  withdrawn: "No applications in Withdrawn. Applications you pull out of end up here.",
};

const UNKNOWN_COMPANY = "Unknown company";
const UNKNOWN_ROLE = "Role unavailable";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== "");
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

function daysLabel(days: number): string {
  return days === 1 ? "1 day in stage" : `${days} days in stage`;
}

const MOVE_HINT_ID = "pipeline-move-hint";

function cardLabel(card: PipelineCard): string {
  return `${card.companyName ?? UNKNOWN_COMPANY}: ${card.roleTitle ?? UNKNOWN_ROLE}`;
}

function Card({
  card,
  stage,
  moves,
  reserveActionSpace,
}: {
  readonly card: PipelineCard;
  readonly stage: ApplicationStage;
  readonly moves: PipelineMoves | undefined;
  /** Leave room at the top right for the `+ task` button. */
  readonly reserveActionSpace: boolean;
}): ReactElement {
  const company = card.companyName ?? UNKNOWN_COMPANY;
  const title = card.roleTitle ?? UNKNOWN_ROLE;
  const pending = moves?.pendingIds.has(card.applicationId) ?? false;
  const ref = useRef<HTMLAnchorElement>(null);
  const shouldFocus = moves?.focusApplicationId === card.applicationId;

  // A moved card remounts in its new column (React keys are per list),
  // which drops focus. Restore it so a keyboard user can keep moving
  // the same card.
  useEffect(() => {
    if (shouldFocus) ref.current?.focus();
  }, [shouldFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>): void => {
    if (moves === undefined) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const direction =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : null;
    if (direction === null) return;
    e.preventDefault();
    const target = neighborStage(stage, direction);
    if (target !== null) moves.onMove(card.applicationId, target);
  };

  const onDragStart = (e: DragEvent<HTMLAnchorElement>): void => {
    e.dataTransfer.setData(PIPELINE_CARD_MIME, card.applicationId);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <Link
      to={`/roles/${card.roleId}`}
      ref={ref}
      data-testid="pipeline-card"
      data-application-id={card.applicationId}
      {...(moves !== undefined && {
        draggable: !pending,
        onDragStart,
        onKeyDown,
        "aria-keyshortcuts": "ArrowLeft ArrowRight",
        "aria-describedby": MOVE_HINT_ID,
        "aria-busy": pending,
        "data-pending": pending ? "true" : undefined,
      })}
      className={
        (pending ? "opacity-60 " : "") +
        (reserveActionSpace ? "pr-8 " : "") +
        "block rounded-md border border-zinc-200 bg-white px-3 py-2 transition duration-150 ease-in-out hover:border-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-50 motion-reduce:transition-none dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:focus-visible:ring-zinc-100 dark:focus-visible:ring-offset-zinc-950"
      }
    >
      <p
        className={
          "truncate text-sm font-medium leading-snug " +
          (card.companyName === null
            ? "italic text-zinc-500 dark:text-zinc-400"
            : "text-zinc-900 dark:text-zinc-100")
        }
        data-testid="pipeline-card-company"
      >
        {company}
      </p>
      <p
        className={
          "truncate text-xs leading-snug " +
          (card.roleTitle === null
            ? "italic text-zinc-500 dark:text-zinc-400"
            : "text-zinc-500 dark:text-zinc-400")
        }
        data-testid="pipeline-card-title"
        title={title}
      >
        {title}
      </p>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400">
        {card.daysInStage !== null && (
          <span
            className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            data-testid="pipeline-card-days"
            title={daysLabel(card.daysInStage)}
            aria-label={daysLabel(card.daysInStage)}
          >
            {card.daysInStage}d
          </span>
        )}
        {/* Next-action chip slot: filled by #32's next-action
            sub-issue once #34's tasks exist. `nextAction` is always
            null until then, so nothing renders here. */}
        {card.nextAction !== null && (
          <span
            className="min-w-0 truncate rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            data-testid="pipeline-card-next-action"
          >
            {card.nextAction}
          </span>
        )}
        {card.keyContact !== null && (
          <span
            className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[10px] font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
            data-testid="pipeline-card-contact"
            title={card.keyContact.name}
            aria-label={`Key contact: ${card.keyContact.name}`}
          >
            {initials(card.keyContact.name)}
          </span>
        )}
      </div>
    </Link>
  );
}

/**
 * The card's `+ task` affordance (#34). A sibling of the card link,
 * not a child: a button inside an `<a>` is invalid and would also
 * navigate.
 */
function CardTaskAdd({
  card,
  tasks,
}: {
  readonly card: PipelineCard;
  readonly tasks: PipelineTasks;
}): ReactElement {
  const [open, setOpen] = useState(false);
  // Locked while a save is in flight: closing and reopening the form
  // mid-save would start a second submission and a duplicate task.
  const [saving, setSaving] = useState(false);
  const label = cardLabel(card);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={saving}
        aria-expanded={open}
        aria-label={`Add task for ${label}`}
        title="Add task"
        data-action="pipeline-card-add-task"
        data-application-id={card.applicationId}
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-sm text-zinc-600 disabled:opacity-60 hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:focus-visible:ring-zinc-100"
      >
        +
      </button>
      {open && (
        <div className="mt-1.5">
          <TaskQuickAdd
            label={label}
            defaultDueAt={tasks.defaultDueAtFor(card.applicationId)}
            onSubmit={async (title, dueAt) => {
              setSaving(true);
              try {
                await tasks.onAddTask(card.applicationId, title, dueAt);
                setOpen(false);
              } finally {
                setSaving(false);
              }
            }}
            onCancel={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}

function Column({
  column,
  moves,
  tasks,
}: {
  readonly column: PipelineColumn;
  readonly moves: PipelineMoves | undefined;
  readonly tasks: PipelineTasks | undefined;
}): ReactElement {
  const label = STAGE_LABELS[column.stage];
  const headingId = `pipeline-column-${column.stage}`;
  const [dragOver, setDragOver] = useState(false);

  const carriesCard = (e: DragEvent<HTMLElement>): boolean =>
    Array.from(e.dataTransfer.types).includes(PIPELINE_CARD_MIME);

  const dropHandlers =
    moves === undefined
      ? {}
      : {
          onDragOver: (e: DragEvent<HTMLElement>): void => {
            if (!carriesCard(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!dragOver) setDragOver(true);
          },
          onDragLeave: (e: DragEvent<HTMLElement>): void => {
            // Moving between children fires dragleave on the column;
            // only clear the highlight when the pointer really left it.
            const next = e.relatedTarget;
            if (next instanceof Node && e.currentTarget.contains(next)) return;
            setDragOver(false);
          },
          onDrop: (e: DragEvent<HTMLElement>): void => {
            setDragOver(false);
            const id = e.dataTransfer.getData(PIPELINE_CARD_MIME);
            if (id === "") return;
            e.preventDefault();
            moves.onMove(id, column.stage);
          },
        };

  return (
    <section
      aria-labelledby={headingId}
      data-testid="pipeline-column"
      data-stage={column.stage}
      data-drop-target={dragOver ? "true" : undefined}
      {...dropHandlers}
      className={
        "min-w-0 space-y-2 " +
        (moves === undefined
          ? ""
          : // Always 2px so the highlight never shifts the layout.
            "-m-1 rounded-md border-2 p-1 " +
            (dragOver
              ? "border-zinc-900 dark:border-zinc-100"
              : "border-transparent"))
      }
    >
      {/* One header element, two shapes: a pill below md, a muted
          header row from md up. */}
      <h2
        id={headingId}
        className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 md:flex md:rounded-none md:bg-transparent md:px-0 md:uppercase md:tracking-wide md:text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300 md:dark:bg-transparent md:dark:text-zinc-400"
        data-testid="pipeline-column-header"
      >
        <span>{label}</span>
        <span
          className="tabular-nums text-zinc-600 md:text-zinc-500 dark:text-zinc-400"
          data-testid="pipeline-column-count"
        >
          {column.cards.length}
        </span>
      </h2>
      {column.cards.length === 0 ? (
        <p
          className="text-xs leading-snug text-zinc-600 dark:text-zinc-400"
          data-testid="pipeline-column-empty"
        >
          {STAGE_EMPTY_COPY[column.stage]}
        </p>
      ) : (
        <ul className="space-y-2">
          {column.cards.map((card) => (
            <li key={card.applicationId} className="relative">
              <Card
                card={card}
                stage={column.stage}
                moves={moves}
                reserveActionSpace={tasks !== undefined}
              />
              {tasks !== undefined && <CardTaskAdd card={card} tasks={tasks} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function PipelineView({
  status,
  columns,
  error,
  partial,
  moves,
  tasks,
}: PipelineViewProps): ReactElement {
  return (
    <section
      className="mx-auto max-w-7xl space-y-4"
      data-testid="pipeline"
      data-pipeline-status={status}
    >
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Pipeline
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Every application by stage. Open a card to see its Role.
          {moves !== undefined && (
            <span id={MOVE_HINT_ID}>
              {" "}
              Drag a card to another column, or focus it and press the Left
              or Right arrow key to move it one stage.
            </span>
          )}
        </p>
      </header>

      {moves !== undefined && (
        // Always mounted so screen readers pick up each new message.
        <p
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="pipeline-announcement"
        >
          {moves.announcement}
        </p>
      )}

      {status === "loading" && (
        <p
          className="text-sm text-zinc-500 dark:text-zinc-400"
          data-testid="pipeline-loading"
          role="status"
          aria-live="polite"
        >
          Loading pipeline&hellip;
        </p>
      )}

      {status === "error" && (
        <p
          role="alert"
          data-testid="pipeline-error"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          Couldn&apos;t load your applications
          {error !== null ? `: ${error.message}` : "."}
        </p>
      )}

      {status === "ready" && (
        <>
          {partial && (
            <p
              role="status"
              data-testid="pipeline-partial"
              className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
            >
              Some details couldn&apos;t be loaded, so a few cards show
              placeholders. Reload to try again.
            </p>
          )}
          {moves !== undefined && moves.error !== null && (
            <div
              role="alert"
              data-testid="pipeline-move-error"
              className="flex items-start justify-between gap-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              <p>{moves.error}</p>
              <button
                type="button"
                onClick={moves.onDismissError}
                data-action="pipeline-dismiss-move-error"
                className="shrink-0 rounded px-1.5 text-xs text-red-700 hover:bg-red-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 dark:text-red-300 dark:hover:bg-red-900 dark:focus-visible:ring-red-300"
              >
                Dismiss
              </button>
            </div>
          )}
          {/* Sidebar first in reading order so due work is met first;
              from lg up it sits to the right of the board. */}
          <div className="flex flex-col gap-6 lg:flex-row-reverse lg:items-start lg:gap-4">
            {tasks !== undefined && (
              <div className="lg:w-64 lg:shrink-0">
                <TaskSidebar tasks={tasks} />
              </div>
            )}
            <div
              className="flex min-w-0 flex-1 flex-col gap-6 md:grid md:grid-cols-7 md:gap-3"
              data-testid="pipeline-board"
            >
              {columns.map((column) => (
                <Column
                  key={column.stage}
                  column={column}
                  moves={moves}
                  tasks={tasks}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
