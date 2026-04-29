/**
 * Validation flag badge + resolution popover for the Application
 * Editor (#24, PR 2).
 *
 * Mirrors the badge-with-popover pattern from `MatchScoreBadge`
 * (#21 / sub-issue #131): a positioned `<span class="group">`
 * wraps both the trigger and the popover; CSS toggles popover
 * visibility via `group-hover:visible` + `group-focus-within:
 * visible` so the popover is always present in the DOM (screen
 * readers find it via `aria-describedby`) and shows on either
 * pointer or keyboard focus.
 *
 * Badge color encodes flag-type: amber for `untraceable` (the
 * generator grounded a claim on a Unit the validator couldn't
 * confirm), red for `specificity` (the claim hit the deny-list
 * for vague metrics). When a single item carries multiple flags
 * of mixed types, the badge surfaces the "worst" one (red beats
 * amber) so the user's attention goes to the harder problem
 * first.
 *
 * The popover surfaces three resolution paths per the issue
 * spec:
 *   1. Edit the bullet (PR 3 will wire inline edit; the button
 *      surfaces here as disabled with a "lands in PR 3"
 *      tooltip — keeping the entry-point visible avoids a
 *      mental discontinuity when PR 3 ships).
 *   2. Remove this bullet (calls up to the container, which
 *      runs `removeBulletFromAsset` and refetches).
 *   3. Add a supporting Unit (opens the existing UnitReview
 *      ManualAddForm in a modal; PR 3 will wire the new
 *      Unit's id back into `source_unit_ids[]`. PR 2 just
 *      gets the user out of the no-Unit deadlock).
 */

import { useId, type ReactElement } from "react";

import type { ValidationFlag } from "../../types/crm.ts";

export interface FlagBadgeProps {
  /**
   * Non-empty list of flags on this item. Caller (the view's
   * BulletItem) only renders this component when there's at
   * least one flag; this contract lets us index `flags[0]`
   * safely in the rendering code.
   */
  readonly flags: readonly ValidationFlag[];
  /**
   * True when "Remove this bullet" is a valid action on the
   * surrounding item — bullets/skills/education yes, summary no.
   * The Remove button is hidden when false rather than disabled,
   * since "remove the summary" is structurally meaningless and
   * would confuse the user. The view computes this per-item
   * based on which array the item came from.
   */
  readonly canRemove: boolean;
  /**
   * Click handler for "Remove this bullet". Async because the
   * service-layer mutation talks to Firestore; the badge surfaces
   * a brief "Removing…" pending state inline if needed (deferred
   * — V1 latency is low enough that no spinner shows in practice).
   * Optional so callers can opt out of the resolution path entirely
   * (e.g. read-only contexts) — the button hides when undefined,
   * never renders as a no-op control. CodeRabbit Major on PR #182
   * (caught the same shape on `onAddSupportingUnit`).
   */
  readonly onRemove?: () => void;
  /**
   * Click handler for "Add a supporting Unit". Opens the manual-
   * add modal in the container. The new Unit's id is NOT yet
   * wired back into the bullet's `source_unit_ids[]` — PR 3 owns
   * that bridge; PR 2 just gets the user past the "I don't have
   * a Unit yet" deadlock. Optional: button hides when absent.
   */
  readonly onAddSupportingUnit?: () => void;
  /**
   * Click handler for "Edit this bullet" — switches the row to
   * inline-edit mode. PR 3 wires this to `BulletEditor`; before
   * PR 3 the button rendered disabled with a "lands in PR 3"
   * tooltip. Optional so callers can omit edit affordance (and
   * the button hides) for read-only contexts.
   */
  readonly onEdit?: () => void;
}

/**
 * Returns the worst (highest-attention) status among the flags.
 * Specificity (red) beats untraceable (amber) beats traced
 * (which shouldn't appear here — the view filters to non-traced
 * before rendering). Pure so the test suite can pin the
 * precedence directly.
 */
export function worstFlagStatus(
  flags: readonly ValidationFlag[],
): "specificity" | "untraceable" {
  for (const f of flags) {
    if (f.status === "specificity") return "specificity";
  }
  return "untraceable";
}

const BADGE_CLS_BY_STATUS = {
  specificity:
    "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  untraceable:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
} as const;

const BADGE_LABEL_BY_STATUS = {
  specificity: "vague claim",
  untraceable: "no source Unit",
} as const;

export default function FlagBadge({
  flags,
  canRemove,
  onRemove,
  onAddSupportingUnit,
  onEdit,
}: FlagBadgeProps): ReactElement {
  const popoverId = useId();
  const worst = worstFlagStatus(flags);
  const count = flags.length;
  const ariaLabel =
    count === 1
      ? `1 validation flag — ${BADGE_LABEL_BY_STATUS[worst]}. Hover or focus for details and resolution options.`
      : `${count} validation flags — worst severity ${BADGE_LABEL_BY_STATUS[worst]}. Hover or focus for details and resolution options.`;

  return (
    <span className="relative inline-block group" data-testid="flag-badge">
      <button
        type="button"
        aria-describedby={popoverId}
        aria-label={ariaLabel}
        data-flag-status={worst}
        data-flag-count={count}
        className={
          "shrink-0 rounded px-1.5 py-0.5 text-xs font-medium cursor-help focus:outline-none focus:ring-2 focus:ring-zinc-500 " +
          BADGE_CLS_BY_STATUS[worst]
        }
      >
        ⚠ {BADGE_LABEL_BY_STATUS[worst]}
        {count > 1 ? ` (+${count - 1})` : ""}
      </button>
      <span
        id={popoverId}
        // role="dialog" + aria-modal="false" rather than role="tooltip":
        // WAI-ARIA APG forbids interactive controls inside a tooltip
        // (tooltips don't take focus and are for non-interactive
        // contextual info). Our popover surfaces the three resolution
        // path BUTTONS, so it has to be a non-modal dialog.
        // CodeRabbit Major on PR #182. (MatchScoreBadge legitimately
        // uses role="tooltip" because its popover is text-only.)
        role="dialog"
        aria-modal="false"
        aria-label="Validation flag details and resolution paths"
        data-testid="flag-popover"
        className="invisible group-hover:visible group-focus-within:visible absolute z-10 left-0 top-full mt-1 w-80 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 shadow-lg text-xs space-y-2"
      >
        <ul className="space-y-1.5" aria-label="Validation flag rationale">
          {flags.map((f) => (
            <li
              key={f.id}
              className="space-y-0.5"
              data-flag-id={f.id}
            >
              <p
                className={
                  f.status === "specificity"
                    ? "font-semibold text-red-700 dark:text-red-300"
                    : "font-semibold text-amber-700 dark:text-amber-300"
                }
              >
                {BADGE_LABEL_BY_STATUS[
                  f.status === "specificity" ? "specificity" : "untraceable"
                ]}
              </p>
              <p className="text-zinc-700 dark:text-zinc-300">{f.rationale}</p>
            </li>
          ))}
        </ul>
        <div
          className="border-t border-zinc-200 dark:border-zinc-700 pt-2 space-y-1"
          aria-label="Resolution paths"
        >
          {onEdit !== undefined && (
            <button
              type="button"
              onClick={onEdit}
              data-action="edit-bullet"
              className="block w-full text-left px-2 py-1 rounded text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Edit this bullet&hellip;
            </button>
          )}
          {canRemove && onRemove !== undefined && (
            <button
              type="button"
              onClick={onRemove}
              data-action="remove-bullet"
              className="block w-full text-left px-2 py-1 rounded text-xs text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950"
            >
              Remove this bullet
            </button>
          )}
          {onAddSupportingUnit !== undefined && (
            <button
              type="button"
              onClick={onAddSupportingUnit}
              data-action="add-supporting-unit"
              className="block w-full text-left px-2 py-1 rounded text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Add a supporting Unit&hellip;
            </button>
          )}
        </div>
      </span>
    </span>
  );
}
