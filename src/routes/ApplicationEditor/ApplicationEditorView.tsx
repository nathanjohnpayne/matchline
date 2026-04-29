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
 * PR 1 scope: two-pane shell + read-only bullets with
 * `source_unit_ids` chips. PR 2 (this commit) adds validation flag
 * badges per item, a popover surfacing the rationale + three
 * resolution paths, and the export-button gate. Inline edit +
 * autosave land in PR 3.
 */

import type { ReactElement } from "react";

import type { ExperienceUnit } from "../../types/capability.ts";
import type {
  Application,
  AssetRef,
  GeneratedItem,
  ValidationFlag,
} from "../../types/crm.ts";

import { exportGateState } from "./exportGate.ts";
import FlagBadge from "./FlagBadge.tsx";
import { flagsByBullet } from "./flagsByBullet.ts";

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
  /**
   * Click handler for "Remove this bullet" in a flag popover.
   * Receives the offending item's id (the GeneratedItem.id, which
   * is what ValidationFlag.bullet_id references). The container
   * runs the service-layer `removeBulletFromAsset` and refetches.
   * Optional so PR 1 callers (which have no flags to render) keep
   * compiling.
   */
  readonly onRemoveBullet?: (bulletId: string) => void;
  /**
   * Click handler for "Add a supporting Unit" in a flag popover.
   * Opens the manual-add modal. The popover doesn't pass any
   * bullet context — PR 3 will wire the new Unit's id back into
   * `source_unit_ids[]`; PR 2 just gets the user past the no-Unit
   * deadlock by enabling them to create one.
   */
  readonly onAddSupportingUnit?: () => void;
  /**
   * Click handler for the Export button. Disabled state is
   * computed in the view from `asset.validation_status` via
   * `exportGateState`; the container only needs to provide a
   * handler for the enabled case. Actual export (PDF/DOCX) is
   * Phase 2 — PR 2 wires the gate, not the export. Optional so
   * PR 1 callers keep compiling.
   */
  readonly onExport?: () => void;
}

export default function ApplicationEditorView({
  status,
  application,
  asset,
  units,
  error,
  onRemoveBullet,
  onAddSupportingUnit,
  onExport,
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
  //
  // `approved_unit_ids` is typed as required on `Application`, but
  // the server-side generation pipeline reads it with `?? []`
  // (functions/src/generation/pipeline.ts) — i.e. the runtime
  // allows legacy docs to omit the field. Mirror that defense
  // here so a pre-pipeline Application renders an empty Units
  // pane instead of crashing the route. Codex P1 on PR #181.
  //
  // Dedupe via Set: nothing in the schema disallows duplicates in
  // approved_unit_ids, and a duplicate would render duplicate
  // `key={unit.id}` <li>s + inflate the count copy. CodeRabbit
  // Minor on PR #181.
  const applicationUnits = [
    ...new Set(application.approved_unit_ids ?? []),
  ]
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
          onRemoveBullet={onRemoveBullet}
          onAddSupportingUnit={onAddSupportingUnit}
          onExport={onExport}
        />
        <UnitsPane units={applicationUnits} />
      </div>
    </section>
  );
}

interface ResumePaneProps {
  readonly asset: AssetRef | null;
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
  readonly onRemoveBullet?: (bulletId: string) => void;
  readonly onAddSupportingUnit?: () => void;
  readonly onExport?: () => void;
}

function ResumePane({
  asset,
  unitsById,
  onRemoveBullet,
  onAddSupportingUnit,
  onExport,
}: ResumePaneProps): ReactElement {
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
  // Flag lookup keyed by GeneratedItem id. The orchestrator emits
  // flags for summary/bullets/skills/education uniformly, so a
  // single map covers all four sections.
  const flags = flagsByBullet(asset.validation_flags);
  const gate = exportGateState(asset);
  // The Remove resolution path is only valid for `bullets[]` —
  // the schema forbids removing `summary`, and removing a single
  // skill or education entry is structurally a bullet-removal too
  // (the data shape is identical), so we extend Remove to those.
  // Pre-compute the id sets for an O(1) check inside `BulletItem`.
  const bulletIds = new Set<string>([
    ...content.bullets.map((b) => b.id),
    ...content.skills.map((s) => s.id),
    ...(content.education ?? []).map((e) => e.id),
  ]);
  const renderItem = (
    item: GeneratedItem,
    keyPrefix: string,
  ): ReactElement => (
    <BulletItem
      key={`${keyPrefix}:${item.id}`}
      item={item}
      unitsById={unitsById}
      flags={flags.get(item.id)}
      canRemove={bulletIds.has(item.id)}
      onRemove={
        onRemoveBullet === undefined
          ? undefined
          : () => onRemoveBullet(item.id)
      }
      onAddSupportingUnit={onAddSupportingUnit}
    />
  );
  return (
    <article
      className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-5"
      aria-label="Generated resume"
      data-testid="resume-pane"
    >
      <ExportButton gate={gate} onExport={onExport} />

      <Section heading="Summary">
        {renderItem(content.summary, "summary")}
      </Section>

      <Section heading="Experience">
        {content.bullets.length === 0 ? (
          <p className="text-sm italic text-zinc-500">No bullets generated.</p>
        ) : (
          <ul className="space-y-3" data-testid="resume-bullets">
            {content.bullets.map((bullet) => (
              <li key={bullet.id}>{renderItem(bullet, "bullet")}</li>
            ))}
          </ul>
        )}
      </Section>

      {content.skills.length > 0 && (
        <Section heading="Skills">
          <ul className="space-y-2" data-testid="resume-skills">
            {content.skills.map((skill) => (
              <li key={skill.id}>{renderItem(skill, "skill")}</li>
            ))}
          </ul>
        </Section>
      )}

      {content.education !== undefined && content.education.length > 0 && (
        <Section heading="Education">
          <ul className="space-y-2" data-testid="resume-education">
            {content.education.map((edu) => (
              <li key={edu.id}>{renderItem(edu, "education")}</li>
            ))}
          </ul>
        </Section>
      )}
    </article>
  );
}

interface ExportButtonProps {
  readonly gate: ReturnType<typeof exportGateState>;
  readonly onExport?: () => void;
}

function ExportButton({ gate, onExport }: ExportButtonProps): ReactElement {
  // Always render the button, never hide it — the user needs to see
  // the gate's reason, not just an absent control. When disabled the
  // tooltip explains what's blocking; when enabled, the click handler
  // fires (or no-ops if the container hasn't wired one — actual
  // export is Phase 2).
  const enabled = gate.enabled;
  return (
    <div className="flex items-center justify-end gap-3 border-b border-zinc-200 dark:border-zinc-800 pb-3 -mt-1">
      {!enabled && (
        <p
          className="text-xs italic text-zinc-500"
          data-testid="export-disabled-reason"
        >
          {gate.disabledReason}
        </p>
      )}
      <button
        type="button"
        disabled={!enabled}
        onClick={enabled && onExport !== undefined ? onExport : undefined}
        title={enabled ? "Export this resume" : gate.disabledReason}
        data-testid="export-button"
        data-export-enabled={enabled ? "true" : "false"}
        className={
          enabled
            ? "rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            : "rounded-md bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-400 cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-600"
        }
      >
        Export
      </button>
    </div>
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
  /**
   * Validation flags on this item, if any. Caller pre-filters out
   * `traced` flags (they passed validation; no badge needed).
   * Undefined or empty means no badge renders.
   */
  readonly flags?: readonly ValidationFlag[];
  /**
   * True when "Remove" is a valid resolution path for this item.
   * Bullets/skills/education yes, summary no — a missing summary
   * would corrupt the asset shape. The badge hides Remove (rather
   * than disabling) when false, so the user isn't faced with a
   * non-functional control.
   */
  readonly canRemove: boolean;
  /** Pre-bound to this item's id by the parent. */
  readonly onRemove?: () => void;
  /** Opens the manual-add modal in the container. */
  readonly onAddSupportingUnit?: () => void;
}

function BulletItem({
  item,
  unitsById,
  flags,
  canRemove,
  onRemove,
  onAddSupportingUnit,
}: BulletItemProps): ReactElement {
  const hasFlags = flags !== undefined && flags.length > 0;
  return (
    <div
      className="space-y-1.5"
      data-bullet-id={item.id}
    >
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm text-zinc-900 dark:text-zinc-100">
          {item.text}
        </p>
        {hasFlags && (
          <FlagBadge
            flags={flags}
            canRemove={canRemove}
            onRemove={onRemove ?? (() => undefined)}
            onAddSupportingUnit={
              onAddSupportingUnit ?? (() => undefined)
            }
          />
        )}
      </div>
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
