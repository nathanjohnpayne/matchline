/**
 * ClaimAnnotation — the Application Editor's workhorse primitive
 * for inline traceability + validation rendering (#24, sub-issues
 * #185 + #186).
 *
 * Per `docs/design/ui-guidance.md` § Application Editor + the
 * component-primitives list (`ClaimAnnotation` is item 7), claims
 * carrying `source_unit_ids` or validation flags are rendered with
 * a subtle 1px underline rather than chip pills / pill badges.
 * Clicking the underlined region opens a popover with:
 *
 *   - The source Unit summaries (each clickable to scroll the right
 *     pane to that Unit + briefly highlight it).
 *   - Validation flag rationale + the three resolution paths
 *     (Edit / Remove / Add a supporting Unit) when flags are
 *     present.
 *
 * Underline color encodes the worst signal:
 *   - Red    → at least one `specificity` flag (vague claim).
 *   - Amber  → at least one `untraceable` flag (no source Unit).
 *   - Neutral (zinc) → claim is grounded with no flags.
 *
 * Hovering the underlined region highlights the source Units in
 * the right pane bidirectionally (via the parent's hover state).
 *
 * **Click-to-popover, not hover-to-popover.** The design spec
 * explicitly says "the underline opens a popover on click."
 * Hover/focus shows affordance via the underline color saturation
 * + the right-pane highlight; popover proper is click-triggered,
 * with click-outside and Escape close behaviors.
 *
 * Accessibility:
 *   - The underlined region is a `<button>` with `aria-haspopup`
 *     + `aria-expanded` + `aria-controls`. Tab in, Enter/Space
 *     toggle the popover.
 *   - Visible focus ring per the UI guidance baseline (`focus-
 *     visible:ring-2`).
 *   - Popover uses `role="dialog"` + `aria-modal="false"` (the
 *     tooltip role forbids interactive content per WAI-ARIA APG;
 *     popover content has clickable Unit summaries + resolution
 *     buttons).
 *   - Escape closes; click outside closes (document mousedown
 *     listener attached only while open).
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";

import type { ExperienceUnit } from "../../types/capability.ts";
import type { ValidationFlag } from "../../types/crm.ts";

export interface ClaimAnnotationProps {
  /** The text to render (the GeneratedItem's text). */
  readonly text: string;
  /**
   * Source-Unit ids the generator grounded this claim on.
   */
  readonly sourceUnitIds: readonly string[];
  /**
   * Owner-scoped Unit lookup. Used to render the popover's Unit
   * summaries + decide which entries are missing (for the
   * "(missing Unit)" fallback).
   */
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
  /**
   * Validation flags on this claim. Caller pre-filters out
   * `traced` flags (those passed and need no surfacing). Empty
   * or undefined means no flag annotation; the underline (if any)
   * renders neutral.
   */
  readonly flags?: readonly ValidationFlag[];
  /**
   * True when "Remove this bullet" is a valid resolution path on
   * the surrounding item — bullets/skills/education yes, summary
   * no. Hidden rather than disabled when false (a missing
   * summary would corrupt the asset shape; visible-but-broken
   * controls are worse than absent ones).
   */
  readonly canRemove?: boolean;
  /** Click handler for "Remove this bullet". Optional — button hides when absent. */
  readonly onRemove?: () => void;
  /** Click handler for "Add a supporting Unit" (opens manual-add modal). */
  readonly onAddSupportingUnit?: () => void;
  /**
   * Click handler for "Edit this bullet" — switches the row into
   * inline edit mode. Wired by sub-issue #188 (the inline edit
   * + autosave + claim re-extraction sub-issue). Optional;
   * button hides when absent.
   */
  readonly onEdit?: () => void;
  /**
   * Fires when the mouse enters or focus enters the underlined
   * region. Receives the source Unit ids the right pane should
   * highlight. Receives an empty array on leave/blur.
   */
  readonly onHoverUnits: (unitIds: readonly string[]) => void;
  /**
   * Click handler for a Unit summary in the popover. The right
   * pane scrolls the matching Unit row into view + highlights it.
   */
  readonly onScrollToUnit: (unitId: string) => void;
}

/**
 * Worst-severity classifier for the underline color. Specificity
 * (red, the harder problem) beats untraceable (amber); only
 * source_unit_ids → neutral (no flags); no source_unit_ids and
 * no flags → "none" (no underline at all).
 *
 * Pure helper, exported so the unit tests can pin the precedence
 * directly without rendering.
 */
export type AnnotationSeverity =
  | "none"
  | "neutral"
  | "untraceable"
  | "specificity";

export function annotationSeverity(
  sourceUnitIds: readonly string[],
  flags: readonly ValidationFlag[] | undefined,
): AnnotationSeverity {
  const activeFlags = (flags ?? []).filter(
    (f) => f.status === "untraceable" || f.status === "specificity",
  );
  if (activeFlags.some((f) => f.status === "specificity")) {
    return "specificity";
  }
  if (activeFlags.length > 0) return "untraceable";
  if (sourceUnitIds.length > 0) return "neutral";
  return "none";
}

/**
 * Underline color classes per severity. Red/amber match the
 * `red-600`/`amber-500` semantic tokens from the UI guidance.
 * Neutral uses zinc at lower opacity for the subtle source-Unit
 * underline. Each carries a saturated hover/focus variant so the
 * affordance announces itself.
 */
const UNDERLINE_BY_SEVERITY: Record<
  Exclude<AnnotationSeverity, "none">,
  string
> = {
  specificity:
    "border-b border-red-500/70 hover:border-red-600 focus:border-red-600 dark:border-red-400/70 dark:hover:border-red-300 dark:focus:border-red-300",
  untraceable:
    "border-b border-amber-500/70 hover:border-amber-600 focus:border-amber-600 dark:border-amber-400/70 dark:hover:border-amber-300 dark:focus:border-amber-300",
  neutral:
    "border-b border-zinc-300/60 hover:border-zinc-500 focus:border-zinc-500 dark:border-zinc-600/60 dark:hover:border-zinc-400 dark:focus:border-zinc-400",
};

const FLAG_LABEL_BY_STATUS = {
  specificity: "vague claim",
  untraceable: "no source Unit",
} as const;

export default function ClaimAnnotation({
  text,
  sourceUnitIds,
  unitsById,
  flags,
  canRemove,
  onRemove,
  onAddSupportingUnit,
  onEdit,
  onHoverUnits,
  onScrollToUnit,
}: ClaimAnnotationProps): ReactElement {
  const popoverId = useId();
  const containerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  // Click-outside + Escape close. Listeners attach only while the
  // popover is open so we don't pay the cost on every render.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current === null) return;
      if (containerRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const severity = annotationSeverity(sourceUnitIds, flags);

  // No annotation → plain text. The container <p> in BulletItem
  // already handles typography; we just emit the text directly so
  // the layout stays identical.
  if (severity === "none") {
    return (
      <span className="text-sm text-zinc-900 dark:text-zinc-100">{text}</span>
    );
  }

  // Flag list filtered to surface-able statuses (untraceable +
  // specificity). `traced` flags pre-filtered upstream by
  // flagsByBullet, but defend here too in case future callers
  // pass them through.
  const surfaceFlags = (flags ?? []).filter(
    (f) => f.status === "untraceable" || f.status === "specificity",
  );
  const hasFlags = surfaceFlags.length > 0;

  // Aria label conveys severity to assistive tech without
  // requiring the popover to open.
  const ariaSummary =
    severity === "specificity"
      ? `Vague claim flagged. ${sourceUnitIds.length > 0 ? "Has source Units. " : ""}Click for details and resolution options.`
      : severity === "untraceable"
        ? `Claim has no traceable source Unit. Click for details and resolution options.`
        : `Claim grounded on ${sourceUnitIds.length} source Unit${sourceUnitIds.length === 1 ? "" : "s"}. Click for details.`;

  return (
    <span
      ref={containerRef}
      className="relative inline-block"
      data-testid="claim-annotation"
      data-annotation-severity={severity}
      data-source-unit-count={sourceUnitIds.length}
      data-flag-count={surfaceFlags.length}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => onHoverUnits(sourceUnitIds)}
        onMouseLeave={() => onHoverUnits([])}
        onFocus={() => onHoverUnits(sourceUnitIds)}
        onBlur={() => onHoverUnits([])}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={ariaSummary}
        // Severity-driven underline color. Saturates on hover/focus
        // per the design's "earn the user's attention" rule. Visible
        // focus ring per the UI guidance accessibility baseline
        // ("Every interactive element has a visible focus ring");
        // focus-visible (not focus) so click users don't get a
        // sticky ring.
        className={
          UNDERLINE_BY_SEVERITY[severity] +
          " transition-colors duration-150 text-sm text-zinc-900 dark:text-zinc-100 text-left rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900"
        }
      >
        {text}
      </button>
      <span
        id={popoverId}
        role="dialog"
        aria-modal="false"
        aria-hidden={!open}
        aria-label={
          hasFlags
            ? "Validation flag details and resolution paths"
            : "Source Units for this claim"
        }
        data-testid="claim-popover"
        data-popover-open={open ? "true" : "false"}
        // Always rendered in the DOM (matches the FlagBadge pattern
        // from PR #182 and lets `renderToStaticMarkup` tests see
        // popover content without simulating clicks). Visibility
        // flipped via class tied to React state, NOT CSS hover —
        // the design spec explicitly says click-to-open.
        // `pointer-events-none` when hidden so a hidden popover
        // doesn't intercept clicks bleeding through from below.
        className={
          (open ? "visible" : "invisible pointer-events-none ") +
          " absolute z-10 left-0 top-full mt-1 w-80 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 shadow-lg text-xs space-y-2"
        }
      >
        {hasFlags && (
          <ul
            className="space-y-1.5"
            aria-label="Validation flag rationale"
          >
            {surfaceFlags.map((f) => (
              <li
                key={f.id}
                className="space-y-0.5"
                data-flag-id={f.id}
                data-flag-status={f.status}
              >
                <p
                  className={
                    f.status === "specificity"
                      ? "font-semibold text-red-700 dark:text-red-300"
                      : "font-semibold text-amber-700 dark:text-amber-300"
                  }
                >
                  {FLAG_LABEL_BY_STATUS[
                    f.status === "specificity" ? "specificity" : "untraceable"
                  ]}
                </p>
                <p className="text-zinc-700 dark:text-zinc-300">
                  {f.rationale}
                </p>
              </li>
            ))}
          </ul>
        )}

        {sourceUnitIds.length > 0 && (
          <div
            className={
              hasFlags
                ? "border-t border-zinc-200 dark:border-zinc-700 pt-2 space-y-1"
                : "space-y-1"
            }
          >
            <p className="text-xs font-medium text-zinc-500 px-1">
              Source Units
            </p>
            <ul className="space-y-0.5" aria-label="Source Units">
              {sourceUnitIds.map((unitId, index) => {
                const unit = unitsById.get(unitId);
                const resolved = unit !== undefined;
                const label = unit?.normalized_summary ?? "(missing Unit)";
                return (
                  <li key={`${unitId}:${index}`}>
                    <button
                      type="button"
                      onClick={() => {
                        onScrollToUnit(unitId);
                        setOpen(false);
                      }}
                      data-source-unit-id={unitId}
                      data-source-resolved={resolved ? "true" : "false"}
                      title={label}
                      className={
                        resolved
                          ? "block w-full text-left truncate rounded px-1.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          : "block w-full text-left truncate rounded px-1.5 py-1 text-xs text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950"
                      }
                    >
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {hasFlags && (
          <div
            className="border-t border-zinc-200 dark:border-zinc-700 pt-2 space-y-1"
            aria-label="Resolution paths"
          >
            {onEdit !== undefined && (
              <button
                type="button"
                onClick={() => {
                  onEdit();
                  setOpen(false);
                }}
                data-action="edit-bullet"
                className="block w-full text-left px-2 py-1 rounded text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Edit this bullet&hellip;
              </button>
            )}
            {canRemove === true && onRemove !== undefined && (
              <button
                type="button"
                onClick={() => {
                  onRemove();
                  setOpen(false);
                }}
                data-action="remove-bullet"
                className="block w-full text-left px-2 py-1 rounded text-xs text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950"
              >
                Remove this bullet
              </button>
            )}
            {onAddSupportingUnit !== undefined && (
              <button
                type="button"
                onClick={() => {
                  onAddSupportingUnit();
                  setOpen(false);
                }}
                data-action="add-supporting-unit"
                className="block w-full text-left px-2 py-1 rounded text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Add a supporting Unit&hellip;
              </button>
            )}
          </div>
        )}
      </span>
    </span>
  );
}
