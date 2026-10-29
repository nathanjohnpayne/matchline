/**
 * Export dropdown for a generated resume (#523, parent #33).
 *
 * Self-contained so any surface can mount it: the Application Editor
 * today, the Application Package's résumé view later (#628). Everything
 * it needs comes in through props: the export gate (structurally the
 * editor's `ExportGateState`, without importing it), the format list and
 * the export call. It imports nothing from `src/routes/`.
 *
 * Behaviour:
 * - Closed gate, or no `onExport` wired: the trigger is disabled and the
 *   gate's reason shows next to it, with the "Re-run validation" action
 *   when the gate says re-validating is the fix. The menu cannot open, so
 *   nothing can reach `onExport`.
 * - Open gate: the trigger opens a menu of formats in the fixed order
 *   PDF, DOCX, Text (only Text is registered today). Choosing one closes
 *   the menu and awaits `onExport(format)`; the trigger reads
 *   "Exporting…" and is disabled until it settles.
 * - Failure: the error shows inline under the control (UI guidance rule
 *   10: never a toast), including the server's `failed-precondition`
 *   sentence when the server-side gate refuses. An `ExportRefusal` (the
 *   app's own guards: no ids to export, an unsafe download link) shows
 *   its own sentence verbatim; any other unmarked error shows the generic
 *   copy. The control is usable again straight away, and the error clears
 *   on the next attempt or when the gate changes.
 * - Keyboard (rule 5): Enter, Space or ArrowDown on the trigger opens the
 *   menu on the first item, ArrowUp opens it on the last; ArrowUp/Down
 *   (wrapping), Home and End move; Enter or Space chooses; Escape closes
 *   and returns focus to the trigger; Tab closes and moves on from the
 *   trigger. A click outside closes too.
 *
 * Hand-built menu: the repo has no `Popover` primitive yet (UI guidance
 * rule 9), so this follows the WAI-ARIA menu-button pattern directly.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";

import { friendlyCallableError } from "../lib/callable-errors.ts";
import { ExportRefusal } from "../lib/exportRefusal.ts";
import {
  EXPORT_FORMAT_ORDER,
  type ExportFormat,
} from "../../functions/src/export/types.ts";

/**
 * The gate the menu obeys. Structural so this component never imports
 * the editor's `exportGate.ts`; `ExportGateState` is assignable to it.
 */
export interface ExportMenuGate {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly canRevalidate?: boolean;
}

export interface ExportFormatOption {
  readonly format: ExportFormat;
  readonly label: string;
}

/** Formats the server registers today (#521). PDF (#527) and DOCX (#525) join later. */
export const EXPORT_FORMAT_OPTIONS: readonly ExportFormatOption[] = [
  { format: "txt", label: "Text" },
];

/** Shown when the gate is open but the surface wired no export call. */
export const EXPORT_NOT_WIRED_REASON = "Export is not available yet.";

export interface ExportMenuProps {
  readonly gate: ExportMenuGate;
  /**
   * Export the asset in `format`. Resolves once the download has started;
   * rejects with the callable error or an `ExportRefusal`, which is shown
   * inline. Absent means the surface has no export wired: the trigger
   * stays disabled.
   */
  readonly onExport?: (format: ExportFormat) => void | Promise<unknown>;
  /** Defaults to {@link EXPORT_FORMAT_OPTIONS}; always shown in PDF, DOCX, Text order. */
  readonly formats?: readonly ExportFormatOption[];
  /** Offered next to the disabled trigger when `gate.canRevalidate` is true. */
  readonly onRevalidate?: () => void;
  readonly revalidating?: boolean;
  readonly revalidateError?: string | null;
  /** Extra classes for the outer row (the host surface's spacing and borders). */
  readonly className?: string;
}

const FOCUS_RING =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-900";

function orderFormats(formats: readonly ExportFormatOption[]): readonly ExportFormatOption[] {
  return [...formats].sort(
    (a, b) => EXPORT_FORMAT_ORDER.indexOf(a.format) - EXPORT_FORMAT_ORDER.indexOf(b.format),
  );
}

export default function ExportMenu({
  gate,
  onExport,
  formats = EXPORT_FORMAT_OPTIONS,
  onRevalidate,
  revalidating = false,
  revalidateError = null,
  className,
}: ExportMenuProps): ReactElement {
  const options = orderFormats(formats);
  // Enabled iff the gate passes AND an export call is wired AND there is
  // something to choose: an enabled-looking control with nothing behind
  // it is a broken primary action (CodeRabbit Major on PR #182).
  const enabled = gate.enabled && onExport !== undefined && options.length > 0;
  const disabledReason =
    gate.enabled && !enabled ? EXPORT_NOT_WIRED_REASON : gate.disabledReason;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ref mirror of `busy` so a second activation in the same tick (before
  // React re-renders the disabled trigger) cannot start a second export.
  const busyRef = useRef(false);
  const refocusTrigger = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const menuId = `${baseId}-menu`;

  // An error describes one attempt against one gate state; once the gate
  // moves (re-validated, edited) it no longer applies.
  useEffect(() => {
    setError(null);
  }, [gate.enabled, gate.disabledReason]);

  // A gate that closes while the menu is open must not leave it open.
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  // Roving focus: the active item holds focus while the menu is open.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // Focus goes back to the trigger once it is focusable again (it is
  // disabled while an export runs).
  useEffect(() => {
    if (busy === null && refocusTrigger.current) {
      refocusTrigger.current = false;
      triggerRef.current?.focus();
    }
  }, [busy]);

  // Click outside closes.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const openAt = useCallback(
    (index: number) => {
      if (!enabled || busyRef.current) return;
      setActiveIndex(index);
      setOpen(true);
    },
    [enabled],
  );

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    async (format: ExportFormat) => {
      if (!enabled || onExport === undefined || busyRef.current) return;
      busyRef.current = true;
      refocusTrigger.current = true;
      setOpen(false);
      setError(null);
      setBusy(format);
      try {
        await onExport(format);
      } catch (err) {
        console.warn("export failed", err);
        setError(
          err instanceof ExportRefusal
            ? err.message
            : friendlyCallableError(err, { operation: "exporting this resume" }),
        );
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [enabled, onExport],
  );

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case "Enter":
      case " ":
      case "ArrowDown":
        event.preventDefault();
        openAt(0);
        break;
      case "ArrowUp":
        event.preventDefault();
        openAt(options.length - 1);
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          close(true);
        }
        break;
      default:
        break;
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = options.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (i >= last ? 0 : i + 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => (i <= 0 ? last : i - 1));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(last);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        // Hand focus to the trigger now, without preventDefault: the
        // browser's Tab then moves on from the trigger (Shift+Tab back
        // from it). Left on the item, focus would fall to <body> when the
        // menu unmounts.
        triggerRef.current?.focus();
        setOpen(false);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const option = options[activeIndex];
        if (option !== undefined) void choose(option.format);
        break;
      }
      default:
        break;
    }
  };

  // Firefox activates a button on Space keyup even when keydown was
  // prevented; swallow it so Space never toggles the menu twice.
  const swallowSpaceKeyUp = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === " ") event.preventDefault();
  };

  const isBusy = busy !== null;
  const triggerDisabled = !enabled || isBusy;

  return (
    <div
      ref={rootRef}
      className={`flex flex-wrap items-center justify-end gap-3${className === undefined ? "" : ` ${className}`}`}
      data-testid="export-menu-root"
    >
      {!enabled && disabledReason !== null && (
        <p className="text-xs italic text-zinc-500" data-testid="export-disabled-reason">
          {disabledReason}
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          className="text-xs text-red-600 dark:text-red-400"
          data-testid="export-error"
        >
          {error}
        </p>
      )}
      {revalidateError !== null && (
        <p
          role="alert"
          className="text-xs text-red-600 dark:text-red-400"
          data-testid="revalidate-error"
        >
          {revalidateError}
        </p>
      )}
      {!gate.enabled && gate.canRevalidate === true && onRevalidate !== undefined && (
        <button
          type="button"
          disabled={revalidating}
          onClick={revalidating ? undefined : onRevalidate}
          data-testid="revalidate-button"
          className={
            revalidating
              ? "rounded-md border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-400 cursor-wait dark:border-zinc-700 dark:text-zinc-500"
              : `rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`
          }
        >
          {revalidating ? "Re-running validation…" : "Re-run validation"}
        </button>
      )}
      <div className="relative inline-block">
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          disabled={triggerDisabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-busy={isBusy ? true : undefined}
          onClick={() => (open ? close(false) : openAt(0))}
          onKeyDown={onTriggerKeyDown}
          onKeyUp={swallowSpaceKeyUp}
          title={enabled ? "Export this resume" : (disabledReason ?? undefined)}
          data-testid="export-button"
          data-export-enabled={enabled ? "true" : "false"}
          data-export-busy={isBusy ? "true" : "false"}
          className={
            !enabled
              ? "rounded-md bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-400 cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-600"
              : isBusy
                ? "rounded-md bg-zinc-700 px-3 py-1 text-xs font-medium text-zinc-100 cursor-wait dark:bg-zinc-300 dark:text-zinc-800"
                : `rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`
          }
        >
          {isBusy ? (
            "Exporting…"
          ) : (
            <>
              Export
              <span aria-hidden="true" className="ml-1">
                ▾
              </span>
            </>
          )}
        </button>
        {open && (
          <div
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            onKeyDown={onMenuKeyDown}
            onKeyUp={swallowSpaceKeyUp}
            data-testid="export-menu"
            className="absolute right-0 top-full z-10 mt-1 min-w-[8rem] rounded-md border border-zinc-200 bg-white py-1 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {options.map((option, index) => (
              <button
                key={option.format}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => void choose(option.format)}
                onMouseEnter={() => setActiveIndex(index)}
                data-testid={`export-format-${option.format}`}
                className={`block w-full px-3 py-1.5 text-left text-xs text-zinc-800 hover:bg-zinc-100 focus:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800 motion-safe:transition-colors motion-safe:duration-150 ${FOCUS_RING}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
