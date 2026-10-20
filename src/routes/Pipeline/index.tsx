/**
 * Pipeline container (#510, sub-issue of #32). Reads the owner's
 * Applications plus the Roles, Companies, Interactions and People that
 * enrich their cards, joins them with `buildPipelineBoard`, and hands
 * the columns to `PipelineView`.
 *
 * Container/view split mirrors Role Detail: the view is tested with
 * `renderToStaticMarkup`, the join and the read-failure handling are
 * pure modules with their own tests, and this file only wires them.
 *
 * Read-only by design: nothing here writes `stage` or
 * `last_activity_at`. Moving cards is #32's drag-and-drop sub-issue.
 * One-shot reads, not subscriptions, for the same reason: until cards
 * can move from this board, a fresh load on visit is current enough.
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";

import { listApplications } from "../../services/applications.ts";
import {
  listCompanies,
  listInteractions,
  listPeople,
} from "../../services/people.ts";
import { listRoles } from "../../services/roles.ts";

import { buildPipelineBoard } from "./buildPipelineBoard.ts";
import { loadPipelineData, type PipelineData } from "./loadPipelineData.ts";
import PipelineView, { type PipelineLoadState } from "./PipelineView.tsx";

export default function Pipeline(): ReactElement {
  const [status, setStatus] = useState<PipelineLoadState>("loading");
  const [data, setData] = useState<PipelineData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Captured once per load so the days-in-stage figures agree across
  // every card on the board.
  const [loadedAt, setLoadedAt] = useState<Date>(() => new Date());

  useEffect(() => {
    let cancelled = false;
    loadPipelineData({
      // Wrapped so the service's rest-parameter constraints are not
      // passed an argument.
      listApplications: () => listApplications(),
      listRoles: () => listRoles(),
      listCompanies,
      listInteractions,
      listPeople,
    }).then(
      (next) => {
        if (cancelled) return;
        setData(next);
        setLoadedAt(new Date());
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
  }, []);

  const columns = useMemo(
    () =>
      data === null
        ? []
        : buildPipelineBoard({ ...data, now: loadedAt }),
    [data, loadedAt],
  );

  return (
    <PipelineView
      status={status}
      columns={columns}
      error={error}
      partial={data?.partial ?? false}
    />
  );
}
