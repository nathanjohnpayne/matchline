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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import type { ExperienceUnit } from "../../types/capability.ts";
import type {
  Application,
  AssetRef,
  GeneratedItem,
  ValidationFlag,
} from "../../types/crm.ts";
import type { AddableSection } from "../../services/applications.ts";

import BulletEditor from "./BulletEditor.tsx";
import ClaimAnnotation from "./ClaimAnnotation.tsx";
import { exportGateState } from "./exportGate.ts";
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
  /**
   * Save handler for an inline bullet edit (#24, sub-issue #188).
   * Receives the GeneratedItem id (same shape as `onRemoveBullet`)
   * + the new text. Container runs `editBulletInAsset` +
   * `invokeValidateAsset` + refetch. Optional so the inline-edit
   * affordance hides cleanly in read-only contexts (the
   * ClaimAnnotation popover hides Edit when this prop is absent).
   */
  readonly onSaveBulletEdit?: (
    bulletId: string,
    newText: string,
  ) => Promise<void>;
  /**
   * Add-bullet handler (#24, sub-issue #193). Receives the section
   * to append to; resolves with the new bullet's id (or null if
   * the add failed). The pane uses the returned id to auto-enter
   * edit mode for the fresh bullet. Optional — Add CTAs hide
   * when absent (read-only contexts).
   */
  readonly onAddBullet?: (
    section: AddableSection,
  ) => Promise<string | null>;
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
  onSaveBulletEdit,
  onAddBullet,
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

      <TwoPaneLayout
        asset={asset}
        unitsById={unitsById}
        applicationUnits={applicationUnits}
        onRemoveBullet={onRemoveBullet}
        onAddSupportingUnit={onAddSupportingUnit}
        onExport={onExport}
        onSaveBulletEdit={onSaveBulletEdit}
        onAddBullet={onAddBullet}
      />
    </section>
  );
}

interface TwoPaneLayoutProps {
  readonly asset: AssetRef | null;
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
  readonly applicationUnits: readonly ExperienceUnit[];
  readonly onRemoveBullet?: (bulletId: string) => void;
  readonly onAddSupportingUnit?: () => void;
  readonly onExport?: () => void;
  readonly onSaveBulletEdit?: (
    bulletId: string,
    newText: string,
  ) => Promise<void>;
  readonly onAddBullet?: (
    section: AddableSection,
  ) => Promise<string | null>;
}

/**
 * Wraps ResumePane + UnitsPane and owns the shared state that
 * makes the bidirectional hover-highlight work (#24, sub-issue
 * #185):
 *
 *   - `hoveredUnitIds`: which Units the user is currently hovering
 *     a relationship with. Populated from EITHER pane:
 *       • Hover a left-pane claim → set to that claim's
 *         `source_unit_ids`. The right pane highlights matching
 *         Unit rows.
 *       • Hover a right-pane Unit row → set to `[unit.id]`. The
 *         left pane highlights bullets that reference it.
 *     Mouse leave / blur clears to `[]`.
 *   - `scrollToUnitId`: when a user clicks a Unit summary inside
 *     the ClaimAnnotation popover, the right pane scrolls that
 *     row into view + briefly highlights it. The state is set,
 *     consumed by UnitsPane's useEffect (which calls
 *     `scrollIntoView`), and cleared after a short window so
 *     repeat clicks re-fire.
 *
 * Lifting these to a wrapper rather than putting them on
 * ApplicationEditorView keeps the load-state branches above clean
 * and means `useState` only runs in the ready branch.
 */
/**
 * Window during which a click-to-scroll Unit stays "pinned" as
 * highlighted in the right pane, even though the user's hover may
 * have moved elsewhere. Long enough for the eye to land + read,
 * short enough that the highlight doesn't feel sticky.
 */
export const SCROLL_PIN_MS = 2000;

function TwoPaneLayout({
  asset,
  unitsById,
  applicationUnits,
  onRemoveBullet,
  onAddSupportingUnit,
  onExport,
  onSaveBulletEdit,
  onAddBullet,
}: TwoPaneLayoutProps): ReactElement {
  const [hoveredUnitIds, setHoveredUnitIds] = useState<readonly string[]>([]);
  const [scrollToUnitId, setScrollToUnitId] = useState<string | null>(null);
  // Separate pinned-id state from hovered: clicking a source Unit in
  // the ClaimAnnotation popover scrolls the right pane to that row,
  // but in the common path the popover-close blurs the underline
  // trigger which would clear `hoveredUnitIds` before the user even
  // sees the destination. The pinned id keeps the destination
  // highlighted for `SCROLL_PIN_MS`. Codex P2 on PR #190.
  const [pinnedUnitId, setPinnedUnitId] = useState<string | null>(null);

  const onHoverUnits = useCallback(
    (next: readonly string[]) => setHoveredUnitIds(next),
    [],
  );
  const onScrollToUnit = useCallback((unitId: string) => {
    setScrollToUnitId(unitId);
    setPinnedUnitId(unitId);
  }, []);
  const onScrollHandled = useCallback(() => setScrollToUnitId(null), []);

  // Auto-clear the pin after the window. If the user clicks a
  // different Unit during the window the pin updates to the new id
  // and the timer restarts (effect re-runs on `pinnedUnitId`
  // change). Cleanup clears the timer on unmount or new click.
  useEffect(() => {
    if (pinnedUnitId === null) return;
    const handle = setTimeout(() => setPinnedUnitId(null), SCROLL_PIN_MS);
    return () => clearTimeout(handle);
  }, [pinnedUnitId]);

  // The visible-highlight set is the union of hover-driven and
  // pin-driven ids. Both panes read this combined set.
  const highlightedUnitIds: readonly string[] =
    pinnedUnitId === null
      ? hoveredUnitIds
      : hoveredUnitIds.includes(pinnedUnitId)
        ? hoveredUnitIds
        : [...hoveredUnitIds, pinnedUnitId];

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
      <ResumePane
        asset={asset}
        unitsById={unitsById}
        hoveredUnitIds={highlightedUnitIds}
        onHoverUnits={onHoverUnits}
        onScrollToUnit={onScrollToUnit}
        onRemoveBullet={onRemoveBullet}
        onAddSupportingUnit={onAddSupportingUnit}
        onExport={onExport}
        onSaveBulletEdit={onSaveBulletEdit}
        onAddBullet={onAddBullet}
      />
      <UnitsPane
        units={applicationUnits}
        hoveredUnitIds={highlightedUnitIds}
        onHoverUnits={onHoverUnits}
        scrollToUnitId={scrollToUnitId}
        onScrollHandled={onScrollHandled}
      />
    </div>
  );
}

interface ResumePaneProps {
  readonly asset: AssetRef | null;
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
  /**
   * Currently-hovered Unit ids (from either pane). When non-empty,
   * bullets whose `source_unit_ids` intersect this set get a
   * highlight tint. This is the right-pane → left-pane direction
   * of the bidirectional hover.
   */
  readonly hoveredUnitIds: readonly string[];
  /**
   * Set the hover state when a left-pane claim is hovered/focused.
   * Called with the claim's `source_unit_ids` on enter/focus and
   * `[]` on leave/blur. The right pane reads this to highlight.
   */
  readonly onHoverUnits: (unitIds: readonly string[]) => void;
  /**
   * Triggered when a Unit summary in a ClaimAnnotation popover is
   * clicked. The right pane scrolls + highlights that row.
   */
  readonly onScrollToUnit: (unitId: string) => void;
  readonly onRemoveBullet?: (bulletId: string) => void;
  readonly onAddSupportingUnit?: () => void;
  readonly onExport?: () => void;
  /**
   * Sub-issue #188 inline edit handler. Threaded to BulletItem;
   * when wired, the ClaimAnnotation popover's Edit button becomes
   * available, and clicking it switches the row to BulletEditor.
   */
  readonly onSaveBulletEdit?: (
    bulletId: string,
    newText: string,
  ) => Promise<void>;
  /**
   * Sub-issue #193 add-bullet handler. Returns the new bullet's
   * id so the pane can auto-enter edit mode. Optional: Add CTAs
   * hide when absent.
   */
  readonly onAddBullet?: (
    section: AddableSection,
  ) => Promise<string | null>;
}

function ResumePane({
  asset,
  unitsById,
  hoveredUnitIds,
  onHoverUnits,
  onScrollToUnit,
  onRemoveBullet,
  onAddSupportingUnit,
  onExport,
  onSaveBulletEdit,
  onAddBullet,
}: ResumePaneProps): ReactElement {
  // Single-bullet edit mode at the pane level: at most one
  // GeneratedItem is in edit mode at a time. Storing the editing
  // id here (rather than per-row) ensures clicking Edit on a
  // second row dismisses the first cleanly. `null` means no
  // row is editing.
  const [editingBulletId, setEditingBulletId] = useState<string | null>(null);
  // Mirror the state into a ref so switchToEditMode can read the
  // LATEST committed value when it runs after an await — closures
  // capture the value at handler-creation time, which would be
  // stale across rapid back-to-back Add clicks. Codex P2 round 2
  // on PR #194: without this, two quick Adds resolve in sequence
  // and the second's switchToEditMode reads `editingBulletId =
  // null` from a stale closure, skipping cleanup of the first
  // empty bullet.
  const editingBulletIdRef = useRef<string | null>(null);
  editingBulletIdRef.current = editingBulletId;
  // Track ids that were just added via the Add CTA. If the user
  // cancels an edit on one of these without saving, we remove the
  // empty bullet so the asset doesn't accumulate orphan empty
  // items. Sub-issue #193.
  const newlyAddedRef = useRef(new Set<string>());

  // Switch the pane's edit target. Before changing, if the
  // currently-editing bullet is one we just added (still empty,
  // never saved), remove it. This single helper covers all
  // transition shapes:
  //   - Add → Add (clicking + Add bullet twice)
  //   - Add → Edit on a different row
  //   - Add → Cancel (target=null)
  //   - Edit → Edit on a different row (no cleanup if previous
  //     wasn't newly-added)
  //   - Edit → Cancel (no cleanup)
  // Without this, transitions other than the explicit Cancel path
  // would leave orphan empty bullets persisted in Firestore.
  // Codex P2 round 1 on PR #194.
  const switchToEditMode = (next: string | null): void => {
    // Read the ref, NOT the closure-captured state — the ref
    // reflects the latest commit even when this handler fires
    // after an await.
    const previous = editingBulletIdRef.current;
    if (
      previous !== null &&
      newlyAddedRef.current.has(previous) &&
      onRemoveBullet !== undefined
    ) {
      newlyAddedRef.current.delete(previous);
      onRemoveBullet(previous);
    }
    // Update ref synchronously so back-to-back calls within the
    // same tick (before re-render commits the setState) see the
    // updated value too.
    editingBulletIdRef.current = next;
    setEditingBulletId(next);
  };

  const onAddBulletClick = async (section: AddableSection): Promise<void> => {
    if (onAddBullet === undefined) return;
    const newId = await onAddBullet(section);
    if (newId === null) return;
    newlyAddedRef.current.add(newId);
    switchToEditMode(newId);
  };

  // When a save lands successfully, the bullet is no longer
  // "empty / pending" — drop it from the newly-added set so
  // future cancels / switches don't trigger removal.
  const onAfterSaveSuccess = (bulletId: string): void => {
    newlyAddedRef.current.delete(bulletId);
  };
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
      hoveredUnitIds={hoveredUnitIds}
      onHoverUnits={onHoverUnits}
      onScrollToUnit={onScrollToUnit}
      flags={flags.get(item.id)}
      // Gate Remove on BOTH item type AND handler presence — a
      // bullet/skill/education could be flagged but the container
      // hasn't wired `onRemoveBullet` (e.g. legacy view callers).
      // Without the handler check, the popover would render a
      // functional-looking Remove button that no-ops on click.
      // CodeRabbit Major on PR #182.
      canRemove={bulletIds.has(item.id) && onRemoveBullet !== undefined}
      onRemove={
        onRemoveBullet === undefined
          ? undefined
          : () => onRemoveBullet(item.id)
      }
      onAddSupportingUnit={onAddSupportingUnit}
      isEditing={editingBulletId === item.id}
      onEnterEdit={
        onSaveBulletEdit === undefined
          ? undefined
          : () => switchToEditMode(item.id)
      }
      onCancelEdit={() => switchToEditMode(null)}
      onSaveEdit={
        onSaveBulletEdit === undefined
          ? undefined
          : async (newText) => {
              await onSaveBulletEdit(item.id, newText);
              onAfterSaveSuccess(item.id);
            }
      }
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
        <AddBulletCTA
          section="bullets"
          onAddBullet={onAddBullet}
          onClick={onAddBulletClick}
        />
      </Section>

      {(content.skills.length > 0 || onAddBullet !== undefined) && (
        <Section heading="Skills">
          {content.skills.length > 0 && (
            <ul className="space-y-2" data-testid="resume-skills">
              {content.skills.map((skill) => (
                <li key={skill.id}>{renderItem(skill, "skill")}</li>
              ))}
            </ul>
          )}
          <AddBulletCTA
            section="skills"
            onAddBullet={onAddBullet}
            onClick={onAddBulletClick}
          />
        </Section>
      )}

      {((content.education !== undefined && content.education.length > 0) ||
        onAddBullet !== undefined) && (
        <Section heading="Education">
          {content.education !== undefined && content.education.length > 0 && (
            <ul className="space-y-2" data-testid="resume-education">
              {content.education.map((edu) => (
                <li key={edu.id}>{renderItem(edu, "education")}</li>
              ))}
            </ul>
          )}
          <AddBulletCTA
            section="education"
            onAddBullet={onAddBullet}
            onClick={onAddBulletClick}
          />
        </Section>
      )}
    </article>
  );
}

interface AddBulletCTAProps {
  readonly section: AddableSection;
  readonly onAddBullet?: (
    section: AddableSection,
  ) => Promise<string | null>;
  /**
   * Wrapped click handler from ResumePane (handles edit-mode +
   * newly-added tracking). Receives the section so a single
   * shared click handler can serve all three CTAs.
   */
  readonly onClick: (section: AddableSection) => Promise<void>;
}

/**
 * "+ Add bullet" CTA at the end of an editable section.
 *
 * Hides when `onAddBullet` is absent (read-only contexts) — same
 * shape as the resolution-path buttons in ClaimAnnotation.
 *
 * Per the UI guidance § Application Editor + the section's
 * "Standard editing" item in #24: the CTA is a small ghost
 * button, neutral tone, no over-emphasis. Click → service helper
 * appends + the pane auto-enters edit mode.
 */
function AddBulletCTA({
  section,
  onAddBullet,
  onClick,
}: AddBulletCTAProps): ReactElement | null {
  if (onAddBullet === undefined) return null;
  const label =
    section === "bullets"
      ? "+ Add bullet"
      : section === "skills"
        ? "+ Add skill"
        : "+ Add education entry";
  return (
    <button
      type="button"
      onClick={() => {
        void onClick(section);
      }}
      data-action="add-bullet"
      data-add-bullet-section={section}
      className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors duration-150 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900"
    >
      {label}
    </button>
  );
}

interface ExportButtonProps {
  readonly gate: ReturnType<typeof exportGateState>;
  readonly onExport?: () => void;
}

function ExportButton({ gate, onExport }: ExportButtonProps): ReactElement {
  // Always render the button, never hide it — the user needs to see
  // the gate's reason, not just an absent control. Gate enables iff
  // BOTH the validation gate passes AND a click handler is wired —
  // an enabled-looking button with no onClick is a broken primary
  // action. CodeRabbit Major on PR #182. The "no handler wired"
  // disabled reason is distinct from the validation reasons so the
  // user (and tests) can tell them apart.
  const enabled = gate.enabled && onExport !== undefined;
  const disabledReason =
    gate.enabled && onExport === undefined
      ? "Export is not available yet."
      : gate.disabledReason;
  return (
    <div className="flex items-center justify-end gap-3 border-b border-zinc-200 dark:border-zinc-800 pb-3 -mt-1">
      {!enabled && disabledReason !== null && (
        <p
          className="text-xs italic text-zinc-500"
          data-testid="export-disabled-reason"
        >
          {disabledReason}
        </p>
      )}
      <button
        type="button"
        disabled={!enabled}
        onClick={enabled ? onExport : undefined}
        title={enabled ? "Export this resume" : disabledReason ?? undefined}
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
  // ReactNode rather than ReactElement to allow conditional
  // children (`{cond && <X/>}` short-circuits to `false`,
  // which is a valid ReactNode but not a ReactElement).
  readonly children: ReactNode;
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
   * Currently-hovered Unit ids (from either pane). Bullets whose
   * `source_unit_ids` intersect this set get a highlight tint —
   * the right-pane → left-pane direction of the bidirectional
   * hover.
   */
  readonly hoveredUnitIds: readonly string[];
  /**
   * Set the hover state when this bullet's claim is hovered/
   * focused. Threaded down to ClaimAnnotation. The left-pane →
   * right-pane direction.
   */
  readonly onHoverUnits: (unitIds: readonly string[]) => void;
  /**
   * Trigger right-pane scroll-to-Unit when a Unit summary is
   * clicked inside the ClaimAnnotation popover.
   */
  readonly onScrollToUnit: (unitId: string) => void;
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
  /**
   * Sub-issue #188 inline-edit row state. `isEditing` flips this
   * row from static ClaimAnnotation rendering to BulletEditor.
   * The pane component (ResumePane) tracks single-bullet edit
   * state and threads this boolean per-row.
   */
  readonly isEditing: boolean;
  /**
   * Switch this row into edit mode. Wired through
   * `ClaimAnnotation`'s `onEdit` (the popover's Edit button).
   * Optional: when undefined (read-only context), the popover
   * hides the Edit affordance.
   */
  readonly onEnterEdit?: () => void;
  /** Exit edit mode without saving. Wired to BulletEditor's onCancel. */
  readonly onCancelEdit: () => void;
  /**
   * Save handler for an inline edit. Async because the underlying
   * service write + validation re-run callable round-trips. The
   * editor surfaces the in-flight + error states inline. Optional
   * matching `onEnterEdit`'s read-only-context contract.
   */
  readonly onSaveEdit?: (newText: string) => Promise<void>;
}

function BulletItem({
  item,
  unitsById,
  hoveredUnitIds,
  onHoverUnits,
  onScrollToUnit,
  flags,
  canRemove,
  onRemove,
  onAddSupportingUnit,
  isEditing,
  onEnterEdit,
  onCancelEdit,
  onSaveEdit,
}: BulletItemProps): ReactElement {
  // Highlight this bullet when the right pane is hovering one of
  // its source Units. Empty source_unit_ids → never highlights
  // (the bullet has no traceability link to surface). The class
  // is a subtle background tint matching the right pane's
  // mirror class for consistent feel across the bidirectional
  // hover.
  const isHighlighted =
    hoveredUnitIds.length > 0 &&
    item.source_unit_ids.some((id) => hoveredUnitIds.includes(id));

  // Edit mode: swap the static ClaimAnnotation for BulletEditor.
  // Edit-mode highlight is suppressed (the textarea has its own
  // focus styling) so the row doesn't look "active" in two
  // overlapping ways.
  if (isEditing && onSaveEdit !== undefined) {
    return (
      <div
        className="space-y-1.5 rounded px-2 -mx-2 py-1 -my-1"
        data-bullet-id={item.id}
        data-bullet-editing="true"
      >
        <BulletEditor
          initialText={item.text}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      </div>
    );
  }

  return (
    <div
      className={
        "space-y-1.5 rounded px-2 -mx-2 py-1 -my-1 transition-colors duration-150 " +
        (isHighlighted ? "bg-zinc-100 dark:bg-zinc-800/60" : "")
      }
      data-bullet-id={item.id}
      data-bullet-highlighted={isHighlighted ? "true" : "false"}
    >
      <ClaimAnnotation
        text={item.text}
        sourceUnitIds={item.source_unit_ids}
        unitsById={unitsById}
        flags={flags}
        canRemove={canRemove}
        onRemove={onRemove}
        onAddSupportingUnit={onAddSupportingUnit}
        onEdit={onEnterEdit}
        onHoverUnits={onHoverUnits}
        onScrollToUnit={onScrollToUnit}
      />
    </div>
  );
}

interface UnitsPaneProps {
  readonly units: readonly ExperienceUnit[];
  /**
   * Currently-hovered Unit ids from EITHER pane. Right-pane rows
   * whose id appears here get a highlight tint. Empty → no
   * highlight.
   */
  readonly hoveredUnitIds: readonly string[];
  /**
   * Set the hover state when a right-pane Unit row is hovered/
   * focused. This is the right-pane → left-pane direction of the
   * bidirectional hover.
   */
  readonly onHoverUnits: (unitIds: readonly string[]) => void;
  /**
   * When non-null, the matching Unit row is scrolled into view
   * and briefly highlighted. The pane fires `onScrollHandled`
   * after the scroll lands so the parent can clear the trigger
   * (allowing a repeat click on the same Unit to re-fire).
   */
  readonly scrollToUnitId: string | null;
  /** Called once the scroll has been dispatched. */
  readonly onScrollHandled: () => void;
}

function UnitsPane({
  units,
  hoveredUnitIds,
  onHoverUnits,
  scrollToUnitId,
  onScrollHandled,
}: UnitsPaneProps): ReactElement {
  // Per-Unit row refs for scroll-into-view. Built fresh per render
  // (cheap — typical Application has <30 Units in the right pane);
  // kept in a ref so the useEffect's dependency array can stay
  // narrow (just the trigger id).
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());

  useEffect(() => {
    if (scrollToUnitId === null) return;
    const el = rowRefs.current.get(scrollToUnitId);
    if (el !== null && el !== undefined) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    onScrollHandled();
  }, [scrollToUnitId, onScrollHandled]);

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
          {units.map((unit) => {
            const isHighlighted = hoveredUnitIds.includes(unit.id);
            return (
              <li
                key={unit.id}
                ref={(el) => {
                  // Track each row's element so the
                  // scroll-to-Unit useEffect above can call
                  // scrollIntoView on the matching id. Setting
                  // null on unmount cleans the entry.
                  if (el === null) {
                    rowRefs.current.delete(unit.id);
                  } else {
                    rowRefs.current.set(unit.id, el);
                  }
                }}
                onMouseEnter={() => onHoverUnits([unit.id])}
                onMouseLeave={() => onHoverUnits([])}
                onFocus={() => onHoverUnits([unit.id])}
                onBlur={() => onHoverUnits([])}
                tabIndex={0}
                className={
                  "rounded border px-2 py-1.5 text-xs transition-colors duration-150 " +
                  (isHighlighted
                    ? "border-zinc-400 bg-zinc-100 text-zinc-900 dark:border-zinc-500 dark:bg-zinc-800 dark:text-zinc-100"
                    : "border-zinc-200 text-zinc-700 dark:border-zinc-800 dark:text-zinc-300")
                }
                data-unit-id={unit.id}
                data-unit-highlighted={isHighlighted ? "true" : "false"}
              >
                <p
                  className="truncate"
                  title={unit.normalized_summary}
                >
                  {unit.normalized_summary}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
