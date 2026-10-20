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
} from "../../types/crm.ts";

export interface PipelineReaders {
  readonly listApplications: () => Promise<Application[]>;
  readonly listRoles: () => Promise<Role[]>;
  readonly listCompanies: () => Promise<Company[]>;
  readonly listInteractions: () => Promise<Interaction[]>;
  readonly listPeople: () => Promise<Person[]>;
}

export interface PipelineData {
  readonly applications: readonly Application[];
  readonly roles: readonly Role[];
  readonly companies: readonly Company[];
  readonly interactions: readonly Interaction[];
  readonly people: readonly Person[];
  /** True when any enrichment reader failed and its data is missing. */
  readonly partial: boolean;
}

export async function loadPipelineData(
  readers: PipelineReaders,
): Promise<PipelineData> {
  const [applications, roles, companies, interactions, people] =
    await Promise.allSettled([
      readers.listApplications(),
      readers.listRoles(),
      readers.listCompanies(),
      readers.listInteractions(),
      readers.listPeople(),
    ]);
  if (applications.status === "rejected") {
    throw applications.reason instanceof Error
      ? applications.reason
      : new Error(String(applications.reason));
  }
  const enrichment = [roles, companies, interactions, people];
  for (const r of enrichment) {
    if (r.status === "rejected") {
      console.error("Pipeline: an enrichment read failed:", r.reason);
    }
  }
  const valueOr = <T>(r: PromiseSettledResult<T[]>): T[] =>
    r.status === "fulfilled" ? r.value : [];
  return {
    applications: applications.value,
    roles: valueOr(roles),
    companies: valueOr(companies),
    interactions: valueOr(interactions),
    people: valueOr(people),
    partial: enrichment.some((r) => r.status === "rejected"),
  };
}
