/**
 * Read everything the Pipeline board joins (#510), with the readers
 * injected so the failure handling is testable without Firestore.
 *
 * Applications are the board itself: if they cannot be read there is
 * nothing to show, so that failure rejects and the view renders its
 * inline error. Every other reader only enriches cards, so its failure
 * degrades to an empty list and a `partial` flag; the cards still
 * render, with the same fallbacks a missing Role or Company gets.
 */

import type {
  Application,
  Company,
  Interaction,
  Person,
  Role,
  Task,
} from "../../types/crm.ts";

export interface PipelineReaders {
  readonly listApplications: () => Promise<Application[]>;
  readonly listRoles: () => Promise<Role[]>;
  readonly listCompanies: () => Promise<Company[]>;
  readonly listInteractions: () => Promise<Interaction[]>;
  readonly listPeople: () => Promise<Person[]>;
  /** Follow-up tasks (#34). */
  readonly listTasks: () => Promise<Task[]>;
}

export interface PipelineData {
  readonly applications: readonly Application[];
  readonly roles: readonly Role[];
  readonly companies: readonly Company[];
  readonly interactions: readonly Interaction[];
  readonly people: readonly Person[];
  readonly tasks: readonly Task[];
  /** True when any enrichment reader failed and its data is missing. */
  readonly partial: boolean;
}

export async function loadPipelineData(
  readers: PipelineReaders,
): Promise<PipelineData> {
  // Start every read at once. The enrichment reads are wrapped in
  // `allSettled`, which never rejects, so they cannot raise an
  // unhandled rejection while Applications is awaited on its own.
  // Awaiting Applications first lets its failure surface as soon as it
  // happens instead of waiting out a slow enrichment read. Codex P2 on
  // PR #576.
  const applicationsRead = readers.listApplications();
  const enrichmentRead = Promise.allSettled([
    readers.listRoles(),
    readers.listCompanies(),
    readers.listInteractions(),
    readers.listPeople(),
    readers.listTasks(),
  ]);
  let applications: Application[];
  try {
    applications = await applicationsRead;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const enrichment = await enrichmentRead;
  const [roles, companies, interactions, people, tasks] = enrichment;
  for (const r of enrichment) {
    if (r.status === "rejected") {
      console.error("Pipeline: an enrichment read failed:", r.reason);
    }
  }
  const valueOr = <T>(r: PromiseSettledResult<T[]>): T[] =>
    r.status === "fulfilled" ? r.value : [];
  return {
    applications,
    roles: valueOr(roles),
    companies: valueOr(companies),
    interactions: valueOr(interactions),
    people: valueOr(people),
    tasks: valueOr(tasks),
    partial: enrichment.some((r) => r.status === "rejected"),
  };
}
