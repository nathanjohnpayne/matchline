/**
 * Pipeline board view (#510, sub-issue of #32). Read-only: seven stage
 * columns of Application cards, built by `buildPipelineBoard`.
 *
 * Pure presentational, no Firestore, so it is exercised with
 * `renderToStaticMarkup` like `RoleDetailView`. The container
 * (`index.tsx`) owns loading and the join.
 *
 * UI guidance § Pipeline (#32): a muted column header with stage name
 * and count; cards at most three lines (company, muted truncated
 * title, metadata row). Below `md` the board is a vertical stack with
 * pill headers; from `md` up the seven columns sit side by side.
 * Loading and read failures render inline (rule 10), never as a toast.
 */

import type { ReactElement } from "react";
import { Link } from "react-router-dom";

import type { ApplicationStage } from "../../types/crm.ts";

import type { PipelineCard, PipelineColumn } from "./buildPipelineBoard.ts";

export type PipelineLoadState = "loading" | "ready" | "error";

export interface PipelineViewProps {
  readonly status: PipelineLoadState;
  readonly columns: readonly PipelineColumn[];
  readonly error: Error | null;
  /** Some enrichment data (Roles, Companies, contacts) failed to load. */
  readonly partial: boolean;
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

function Card({ card }: { readonly card: PipelineCard }): ReactElement {
  const company = card.companyName ?? UNKNOWN_COMPANY;
  const title = card.roleTitle ?? UNKNOWN_ROLE;
  return (
    <Link
      to={`/roles/${card.roleId}`}
      data-testid="pipeline-card"
      data-application-id={card.applicationId}
      className="block rounded-md border border-zinc-200 bg-white px-3 py-2 transition duration-150 hover:border-zinc-400 focus:border-zinc-900 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:focus:border-zinc-100"
    >
      <p
        className={
          "truncate text-sm font-medium leading-snug " +
          (card.companyName === null
            ? "italic text-zinc-400 dark:text-zinc-500"
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
            ? "italic text-zinc-400 dark:text-zinc-500"
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
            className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 tabular-nums dark:bg-zinc-800"
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
            className="min-w-0 truncate rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800"
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

function Column({ column }: { readonly column: PipelineColumn }): ReactElement {
  const label = STAGE_LABELS[column.stage];
  const headingId = `pipeline-column-${column.stage}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="pipeline-column"
      data-stage={column.stage}
      className="min-w-0 space-y-2"
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
          className="tabular-nums text-zinc-400 dark:text-zinc-500"
          data-testid="pipeline-column-count"
        >
          {column.cards.length}
        </span>
      </h2>
      {column.cards.length === 0 ? (
        <p
          className="text-xs leading-snug text-zinc-400 dark:text-zinc-500"
          data-testid="pipeline-column-empty"
        >
          {STAGE_EMPTY_COPY[column.stage]}
        </p>
      ) : (
        <ul className="space-y-2">
          {column.cards.map((card) => (
            <li key={card.applicationId}>
              <Card card={card} />
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
        </p>
      </header>

      {status === "loading" && (
        <p
          className="text-sm text-zinc-500"
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
          <div
            className="flex flex-col gap-6 md:grid md:grid-cols-7 md:gap-3"
            data-testid="pipeline-board"
          >
            {columns.map((column) => (
              <Column key={column.stage} column={column} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
