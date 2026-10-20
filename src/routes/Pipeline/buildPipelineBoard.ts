/**
 * Pure join for the Pipeline board (#510, sub-issue of #32).
 *
 * Turns the owner's Applications, Roles, Companies, Interactions and
 * People into one column per `ApplicationStage`, each holding card
 * view models. No Firestore, no clock: the caller passes `now`, so the
 * days-in-stage arithmetic is deterministic under test.
 *
 * Missing joins never drop a card. An Application whose Role or
 * Company could not be loaded (deleted, or its reader failed) still
 * renders, with `null` fields the view turns into a visible fallback.
 * Hiding the card would make the column count disagree with the
 * Applications the user actually has.
 */

import type {
  Application,
  ApplicationStage,
  Company,
  Interaction,
  Person,
  Role,
  UUID,
} from "../../types/crm.ts";

/** Board column order: `ApplicationStage` in its declared order. */
export const PIPELINE_STAGES: readonly ApplicationStage[] = [
  "saved",
  "drafting",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PipelineKeyContact {
  readonly personId: UUID;
  readonly name: string;
}

export interface PipelineCard {
  readonly applicationId: UUID;
  /** Click-through target: `/roles/<roleId>`. Always present on the Application. */
  readonly roleId: UUID;
  /** `null` when the Role or its Company could not be loaded. */
  readonly companyName: string | null;
  /** `null` when the Role could not be loaded. */
  readonly roleTitle: string | null;
  /**
   * Whole days since `last_activity_at`, floored, never negative.
   * `null` when the timestamp is unparseable.
   */
  readonly daysInStage: number | null;
  /**
   * Person on the most recent Interaction for this Application, or
   * `null` when there is none (or its Person could not be loaded).
   */
  readonly keyContact: PipelineKeyContact | null;
  /**
   * Reserved for the first open task, filled by #32's next-action
   * sub-issue once #34's task model exists. Always `null` for now.
   */
  readonly nextAction: string | null;
}

export interface PipelineColumn {
  readonly stage: ApplicationStage;
  readonly cards: readonly PipelineCard[];
}

export interface PipelineBoardInputs {
  readonly applications: readonly Application[];
  readonly roles: readonly Role[];
  readonly companies: readonly Company[];
  readonly interactions: readonly Interaction[];
  readonly people: readonly Person[];
  readonly now: Date;
}

/** Parse an ISO timestamp to epoch ms, or `null` when it is not a date. */
function toMs(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whole days between `lastActivityAt` and `now`, floored. A timestamp
 * in the future (clock skew between devices) reads as 0, not negative.
 */
export function daysInStage(lastActivityAt: string, now: Date): number | null {
  const then = toMs(lastActivityAt);
  if (then === null) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

/**
 * The most recent Interaction (by `occurred_at`) per Application id.
 * Interactions with no `application_id` or an unparseable timestamp
 * are ignored; ties keep the first one seen.
 */
export function latestInteractionByApplication(
  interactions: readonly Interaction[],
): ReadonlyMap<UUID, Interaction> {
  const latest = new Map<UUID, { readonly at: number; readonly it: Interaction }>();
  for (const it of interactions) {
    if (it.application_id === undefined) continue;
    const at = toMs(it.occurred_at);
    if (at === null) continue;
    const prev = latest.get(it.application_id);
    if (prev === undefined || at > prev.at) {
      latest.set(it.application_id, { at, it });
    }
  }
  return new Map([...latest].map(([id, v]) => [id, v.it]));
}

export function buildPipelineBoard(
  inputs: PipelineBoardInputs,
): readonly PipelineColumn[] {
  const rolesById = new Map(inputs.roles.map((r) => [r.id, r]));
  const companiesById = new Map(inputs.companies.map((c) => [c.id, c]));
  const peopleById = new Map(inputs.people.map((p) => [p.id, p]));
  const latest = latestInteractionByApplication(inputs.interactions);

  const byStage = new Map<ApplicationStage, PipelineCard[]>(
    PIPELINE_STAGES.map((s) => [s, []]),
  );
  // Most recently active first, so a card that just moved sits at the
  // top of its column. Ties break on id for a stable order.
  const ordered = [...inputs.applications].sort((a, b) => {
    const diff =
      (toMs(b.last_activity_at) ?? -Infinity) -
      (toMs(a.last_activity_at) ?? -Infinity);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return a.id.localeCompare(b.id);
  });

  for (const app of ordered) {
    // An unknown stage (bad data) has no column to land in.
    const column = byStage.get(app.stage);
    if (column === undefined) continue;
    const role = rolesById.get(app.role_id);
    const company =
      role === undefined ? undefined : companiesById.get(role.company_id);
    const interaction = latest.get(app.id);
    const person =
      interaction === undefined ? undefined : peopleById.get(interaction.person_id);
    column.push({
      applicationId: app.id,
      roleId: app.role_id,
      companyName: company?.name ?? null,
      roleTitle: role?.title ?? null,
      daysInStage: daysInStage(app.last_activity_at, inputs.now),
      keyContact:
        person === undefined ? null : { personId: person.id, name: person.name },
      nextAction: null,
    });
  }

  return PIPELINE_STAGES.map((stage) => ({
    stage,
    cards: byStage.get(stage) ?? [],
  }));
}
