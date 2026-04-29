/**
 * ClaimAnnotation — the Application Editor's workhorse primitive
 * for inline traceability rendering (#24, sub-issue #185).
 *
 * Per `docs/design/ui-guidance.md` § Application Editor + the
 * component-primitives list (`ClaimAnnotation` is item 7), claims
 * carrying `source_unit_ids` are rendered with a subtle 1px
 * underline at lower opacity rather than chip pills below the
 * bullet text. Clicking the underlined region opens a popover
 * with the source Unit summaries; clicking a summary scrolls the
 * right pane to that Unit and highlights it. Hovering the
 * underlined region highlights the same Units in the right pane
 * bidirectionally.
 *
 * Sub-issue #186 will extend this primitive to also overlay
 * red/amber underlines for validation flags. PR 1's chip pill
 * surface (in `BulletItem`) is replaced by this component.
 *
 * **Click-to-popover, not hover-to-popover.** The design spec
 * explicitly says "the underline opens a popover on click."
 * Hover/focus shows affordance via the underline color shift +
 * the right-pane highlight; popover proper is click-triggered,
 * with click-outside and Escape close behaviors.
 *
 * Accessibility:
 *   - The underlined region is a `<button>` with `aria-haspopup`
 *     + `aria-expanded`. Tab into it, Enter / Space toggle the
 *     popover.
 *   - Popover uses `role="dialog"` + `aria-modal="false"` (the
 *     tooltip role forbids interactive content per WAI-ARIA APG;
 *     popover content has clickable Unit summaries).
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

export interface ClaimAnnotationProps {
  /** The text to render (the GeneratedItem's text). */
  readonly text: string;
  /**
   * Source-Unit ids the generator grounded this claim on. Empty
   * means no annotation; the component renders plain text.
   */
  readonly sourceUnitIds: readonly string[];
  /**
   * Owner-scoped Unit lookup. Used to render the popover's Unit
   * summaries + decide which entries are missing (for the "(missing
   * Unit)" fallback).
   */
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
  /**
   * Fires when the mouse enters or focus enters the underlined
   * region. Receives the source Unit ids the right pane should
   * highlight. Receives an empty array on leave/blur.
   */
  readonly onHoverUnits: (unitIds: readonly string[]) => void;
  /**
   * Click handler for a Unit summary in the popover. The right
   * pane scrolls the matching Unit row into view + highlights it.
   * Receives the Unit id (resolved or missing — the right pane
   * decides whether to highlight or render the missing-state).
   */
  readonly onScrollToUnit: (unitId: string) => void;
}

export default function ClaimAnnotation({
  text,
  sourceUnitIds,
  unitsById,
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

  // No annotation → plain text. The container <p> in BulletItem
  // already handles typography; we just emit the text directly so
  // the layout stays identical.
  if (sourceUnitIds.length === 0) {
    return (
      <span className="text-sm text-zinc-900 dark:text-zinc-100">{text}</span>
    );
  }

  return (
    <span
      ref={containerRef}
      className="relative inline-block"
      data-testid="claim-annotation"
      data-source-unit-count={sourceUnitIds.length}
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
        // Subtle 1px underline at lower opacity; saturates on
        // hover/focus to surface the affordance. Per UI guidance:
        // "subtly underlined (a 1px underline with a lower
        // opacity)." Border-b is 1px by default in Tailwind.
        // `decoration-1 underline-offset-2` would be the more
        // semantic choice but border-b composes more cleanly with
        // the hover saturation.
        className="border-b border-zinc-300/60 hover:border-zinc-500 focus:border-zinc-500 dark:border-zinc-600/60 dark:hover:border-zinc-400 dark:focus:border-zinc-400 transition-colors duration-150 text-sm text-zinc-900 dark:text-zinc-100 text-left focus:outline-none"
      >
        {text}
      </button>
      <span
        id={popoverId}
        role="dialog"
        aria-modal="false"
        aria-hidden={!open}
        aria-label="Source Units for this claim"
        data-testid="claim-popover"
        data-popover-open={open ? "true" : "false"}
        // Always rendered in the DOM (matches the FlagBadge pattern
        // and lets `renderToStaticMarkup` tests see popover content
        // without simulating clicks). Visibility flipped via class
        // tied to React state, NOT CSS hover — the design spec
        // explicitly says click-to-open. `pointer-events-none`
        // when hidden so a hidden popover doesn't intercept clicks
        // bleeding through from below.
        className={
          (open ? "visible" : "invisible pointer-events-none ") +
          " absolute z-10 left-0 top-full mt-1 w-72 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-2 shadow-lg text-xs space-y-1"
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
      </span>
    </span>
  );
}
