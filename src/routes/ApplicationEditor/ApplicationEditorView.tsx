/**
 * Presentational component for the Application Editor surface (#24).
 *
 * Receives a pre-fetched Application + the user's owner-scoped
 * Experience Units + a pre-resolved primary resume `asset` from the
 * container. Does not subscribe or talk to Firestore. Split from
 * the container (`index.tsx`) so the rendering shape can be
 * exercised with `renderToStaticMarkup` without mocking Firebase —
 * matching the convention used by UnitReview (#86) and
 * RoleDetail (#129).
 *
 * PR 1 scope (this file): two-pane shell + read-only bullets with
 * `source_unit_ids` chips. Validation flag badges, the resolution
 * popover, and the export-button gate land in PR 2. Inline edit +
 * autosave land in PR 3. The component is shaped so those
 * additions slot in without restructuring the layout.
 */

import type { ReactElement } from "react";

import type { ExperienceUnit } from "../../types/capability.ts";
import type {
  Application,
  AssetRef,
  GeneratedItem,
} from "../../types/crm.ts";

/**
 * Subscription load state. Mirrors the three-way discriminator from
 * UnitReview (#86): a fresh mount must not render an "empty" surface
 * before the first snapshot, and an error must not render the empty
 * state under the alert.
 */
export type LoadState = "loading" | "error" | "ready";

export interface ApplicationEditorViewProps {
  /** Subscription/load state discriminator. Required. */
  readonly status: LoadState;
  /**
   * The Application document. `null` after a one-shot fetch resolves
   * to "doc doesn't exist or isn't yours" — anti-enumeration mirrors
   * RoleDetail's not-found surface (#129).
   */
  readonly application: Application | null;
  /**
   * Pre-resolved primary resume asset for the left pane. The
   * container computes this via `selectPrimaryResumeAsset` so the
   * view stays purely presentational. `null` means the Application
   * has no generated resume yet (the empty-state surface).
   */
  readonly asset: AssetRef | null;
  /**
   * The user's owner-scoped ExperienceUnits, delivered by the
   * container's `subscribeByOwner`. The view filters down to the
   * Units referenced by `application.approved_unit_ids` for the
   * right pane and uses the full set for chip lookup.
   */
  readonly units: readonly ExperienceUnit[];
  /** Subscription error, surfaced when `status === "error"`. */
  readonly error?: Error | null;
}

export default function ApplicationEditorView({
  status,
  application,
  asset,
  units,
  error,
}: ApplicationEditorViewProps): ReactElement {
  if (status === "loading") {
    return (
      <section
        className="mx-auto max-w-6xl space-y-4"
        role="status"
        aria-live="polite"
        data-load-state="loading"
        data-testid="application-editor-loading"
      >
        <p className="text-sm text-zinc-500">Loading Application&hellip;</p>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section
        className="mx-auto max-w-6xl space-y-4"
        role="alert"
        data-load-state="error"
        data-testid="application-editor-error"
      >
        <p className="text-sm text-red-700 dark:text-red-400">
          Couldn&rsquo;t load Application
          {error !== null && error !== undefined ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }

  if (application === null) {
    // Anti-enumeration mirror: "missing OR not yours" collapses to a
    // single user-facing surface. Same shape as RoleDetail (#129).
    return (
      <section
        className="mx-auto max-w-6xl space-y-4"
        data-testid="application-editor-not-found"
      >
        <p className="text-sm text-zinc-500">
          Application not found, or not owned by you.
        </p>
      </section>
    );
  }

  // Lookup map for chip resolution — every bullet/summary/skill
  // carries `source_unit_ids` referencing Units the user has, so a
  // single owner-wide lookup is fine. Built once per render rather
  // than per-chip.
  const unitsById = new Map<string, ExperienceUnit>(
    units.map((u) => [u.id, u]),
  );

  // Right pane shows ONLY the Units this Application was generated
  // against — the snapshot of approved-at-generation-time. The full
  // owner-scoped set is the source for chip lookup, but cluttering
  // the right pane with un-cited Units would obscure traceability.
  const applicationUnits = application.approved_unit_ids
    .map((id) => unitsById.get(id))
    .filter((u): u is ExperienceUnit => u !== undefined);

  return (
    <section
      className="mx-auto max-w-6xl space-y-4"
      data-testid="application-editor"
      data-load-state="ready"
    >
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Application Editor
        </h1>
        <p className="text-sm text-zinc-500">
          Application: <span data-testid="application-id">{application.id}</span>
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <ResumePane
          asset={asset}
          unitsById={unitsById}
        />
        <UnitsPane units={applicationUnits} />
      </div>
    </section>
  );
}

interface ResumePaneProps {
  readonly asset: AssetRef | null;
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
}

function ResumePane({ asset, unitsById }: ResumePaneProps): ReactElement {
  if (asset === null || asset.generated_content === undefined) {
    return (
      <article
        className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center"
        data-testid="resume-pane-empty"
      >
        <p className="text-sm text-zinc-500">
          No generated resume yet. Generate a resume from the Role to
          start editing.
        </p>
      </article>
    );
  }
  const content = asset.generated_content;
  return (
    <article
      className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-5"
      aria-label="Generated resume"
      data-testid="resume-pane"
    >
      <Section heading="Summary">
        <BulletItem item={content.summary} unitsById={unitsById} />
      </Section>

      <Section heading="Experience">
        {content.bullets.length === 0 ? (
          <p className="text-sm italic text-zinc-500">No bullets generated.</p>
        ) : (
          <ul className="space-y-3" data-testid="resume-bullets">
            {content.bullets.map((bullet) => (
              <li key={bullet.id}>
                <BulletItem item={bullet} unitsById={unitsById} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {content.skills.length > 0 && (
        <Section heading="Skills">
          <ul className="space-y-2" data-testid="resume-skills">
            {content.skills.map((skill) => (
              <li key={skill.id}>
                <BulletItem item={skill} unitsById={unitsById} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {content.education !== undefined && content.education.length > 0 && (
        <Section heading="Education">
          <ul className="space-y-2" data-testid="resume-education">
            {content.education.map((edu) => (
              <li key={edu.id}>
                <BulletItem item={edu} unitsById={unitsById} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </article>
  );
}

interface SectionProps {
  readonly heading: string;
  readonly children: ReactElement | ReactElement[];
}

function Section({ heading, children }: SectionProps): ReactElement {
  return (
    <div className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {heading}
      </h2>
      {children}
    </div>
  );
}

interface BulletItemProps {
  readonly item: GeneratedItem;
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
}

function BulletItem({ item, unitsById }: BulletItemProps): ReactElement {
  return (
    <div
      className="space-y-1.5"
      data-bullet-id={item.id}
    >
      <p className="text-sm text-zinc-900 dark:text-zinc-100">{item.text}</p>
      {item.source_unit_ids.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label="Source Units"
        >
          {item.source_unit_ids.map((unitId, index) => {
            const unit = unitsById.get(unitId);
            const label = unit?.normalized_summary ?? "(missing Unit)";
            const resolved = unit !== undefined;
            // Composite key: a generator could in principle ground a
            // bullet on the same Unit twice (the `source_unit_ids: UUID[]`
            // type doesn't disallow duplicates), in which case
            // `key={unitId}` collides and React's reconciliation goes
            // unstable. CodeRabbit Major on PR 181.
            return (
              <li key={`${item.id}:${unitId}:${index}`}>
                <span
                  className={
                    resolved
                      ? "inline-block max-w-[28ch] truncate rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      : "inline-block max-w-[28ch] truncate rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  }
                  title={label}
                  data-source-unit-id={unitId}
                  data-source-resolved={resolved ? "true" : "false"}
                >
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface UnitsPaneProps {
  readonly units: readonly ExperienceUnit[];
}

function UnitsPane({ units }: UnitsPaneProps): ReactElement {
  return (
    <aside
      className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 space-y-3"
      aria-label="Approved Experience Units for this Application"
      data-testid="units-pane"
    >
      <header className="space-y-0.5">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Source Units
        </h2>
        <p className="text-xs text-zinc-500">
          {units.length} approved Unit{units.length === 1 ? "" : "s"}{" "}
          {units.length === 1 ? "was" : "were"} used to ground this Application.
        </p>
      </header>
      {units.length === 0 ? (
        <p className="text-sm italic text-zinc-500">
          No Units linked to this Application yet.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="units-list">
          {units.map((unit) => (
            <li
              key={unit.id}
              className="rounded border border-zinc-200 dark:border-zinc-800 px-2 py-1.5 text-xs text-zinc-700 dark:text-zinc-300"
              data-unit-id={unit.id}
            >
              <p
                className="truncate"
                title={unit.normalized_summary}
              >
                {unit.normalized_summary}
              </p>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
