/**
 * Modal form for manually creating an `ExperienceUnit`. Used for
 * wins the extractor missed — side projects, undocumented
 * accomplishments, pre-LinkedIn work, anything the resume/parse
 * pipeline doesn't capture.
 *
 * Stamping is delegated to the service's `manualInsert`, which in
 * turn delegates to the pure `buildManualUnit` from
 * `experienceUnits-state.ts` (#78). That keeps every default in
 * one place — `source_type: "manual"`, `evidence_type:
 * "user_confirmed"`, `confidence_score: 1.0`, `user_approved:
 * true`. The form supplies user-typed content; the service
 * supplies the rest.
 *
 * **Why a separate component (not InlineEditForm reuse):**
 * `InlineEditForm` is a row-level inline expansion with
 * editing/saving/error status; this is a page-level modal with
 * a single submit. Field semantics are similar but composition
 * differs. A future ticket can extract the shared field-render
 * primitives into a `<UnitFieldsForm>` consumed by both forms;
 * not worth the abstraction at V1.
 */

import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";

import type {
  Metric,
  MetricConfidence,
  MetricDirection,
  UnitType,
} from "../../types/capability.ts";

import type { ManualUnitInput } from "../../services/experienceUnits-state.ts";
import { beginUnsavedWork } from "../../lib/appBusy.ts";

export interface ManualAddFormProps {
  /**
   * Submit handler. Receives a fully-typed `ManualUnitInput`
   * with the fields the user filled in. Returns a Promise so
   * the form can show a "saving" state and surface errors
   * inline. On resolve, the form closes (handled by the parent
   * via `onClose`).
   */
  readonly onSubmit: (input: ManualUnitInput) => Promise<void>;
  readonly onClose: () => void;
}

const UNIT_TYPES: readonly UnitType[] = [
  "project",
  "achievement",
  "ownership",
  "skill_demo",
  "leadership",
  "technical_decision",
];
const METRIC_DIRECTIONS: readonly MetricDirection[] = ["up", "down"];
const METRIC_CONFIDENCES: readonly MetricConfidence[] = [
  "high",
  "medium",
  "low",
];

const TEXT_INPUT_CLS =
  "w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100";
const LABEL_CLS =
  "mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400";

/**
 * Newline-delimited tag parsing. Same convention as
 * `InlineEditForm` (Codex P1 on #90 caught that comma was lossy
 * for tag values like "Sales, Marketing"; we standardize on
 * newlines).
 */
function parseTags(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseDateOrUndefined(value: string): string | undefined {
  return value.length === 0 ? undefined : value;
}

interface FormState {
  readonly raw_text: string;
  readonly normalized_summary: string;
  readonly unit_type: UnitType;
  readonly source_ref: string;
  readonly skills: string;
  readonly tools: string;
  readonly domains: string;
  readonly seniority_signals: string;
  readonly scope_signals: string;
  readonly business_outcomes: string;
  readonly date_start: string;
  readonly date_end: string;
  readonly confidence_score: string;
  readonly metrics: readonly Metric[];
}

const EMPTY_FORM: FormState = {
  raw_text: "",
  normalized_summary: "",
  unit_type: "achievement",
  source_ref: "",
  skills: "",
  tools: "",
  domains: "",
  seniority_signals: "",
  scope_signals: "",
  business_outcomes: "",
  date_start: "",
  date_end: "",
  confidence_score: "1",
  metrics: [],
};

interface ValidationErrors {
  readonly raw_text?: string;
  readonly normalized_summary?: string;
  readonly unit_type?: string;
  readonly date_range?: string;
  readonly confidence_score?: string;
}

/**
 * Pure validation: returns an error map keyed by field. Empty
 * map means valid.
 *
 * Required fields: `raw_text`, `normalized_summary`, `unit_type`
 * per the parent ticket. Date range: if `end` is set, `start`
 * must be set too (matches `InlineEditForm`'s invariant). Other
 * fields are either always-valid (selects with default values)
 * or optional.
 */
export function validateForm(state: FormState): ValidationErrors {
  const errors: ValidationErrors = {};
  const out: { -readonly [K in keyof ValidationErrors]: ValidationErrors[K] } =
    { ...errors };
  if (state.raw_text.trim().length === 0) {
    out.raw_text = "Raw text is required.";
  }
  if (state.normalized_summary.trim().length === 0) {
    out.normalized_summary = "Normalized summary is required.";
  }
  if (!UNIT_TYPES.includes(state.unit_type)) {
    out.unit_type = "Unit type must be one of the listed options.";
  }
  if (state.date_end.length > 0 && state.date_start.length === 0) {
    out.date_range = "End date requires a start date.";
  }
  // Empty confidence is NOT a valid 0 — `Number("")` coerces to
  // 0, which would silently write `confidence_score: 0` to
  // Firestore. Reject explicit-empty so the user is forced to
  // put a number back in (default is "1"; clearing was almost
  // certainly accidental). CodeRabbit Major on #94.
  const trimmedConf = state.confidence_score.trim();
  if (trimmedConf.length === 0) {
    out.confidence_score = "Confidence is required (0–1).";
  } else {
    const conf = Number(trimmedConf);
    if (Number.isNaN(conf) || conf < 0 || conf > 1) {
      out.confidence_score = "Confidence must be between 0 and 1.";
    }
  }
  return out;
}

/**
 * Apply a start-date change to the form state. When start is
 * cleared, end is cleared too — leaving an end-only state would
 * be an invalid DateRange shape that triggers the validation
 * error on submit and is awkward to recover from (the end input
 * is disabled when start is empty). Codex P2 on #94.
 *
 * Pure so the date-clear cascade is unit-tested without React.
 */
export function applyDateStartChange(
  state: FormState,
  next: string,
): FormState {
  if (next === "") {
    return { ...state, date_start: "", date_end: "" };
  }
  return { ...state, date_start: next };
}

/**
 * Build the `ManualUnitInput` payload from the form state.
 *
 * **Assumes validation passed.** `validateForm` is the gate; if
 * it succeeded, `confidence_score` is a non-empty numeric string
 * in [0, 1]. CodeRabbit Major on #94 caught that an empty
 * `confidence_score` coerces to 0 via `Number("")` — that's
 * specifically why `validateForm` rejects empty.
 *
 * Optional fields convert empty strings / empty arrays /
 * undefined dates into absent keys (matches the natural
 * `ManualUnitInput` shape and lets `buildManualUnit` apply its
 * defaults uniformly).
 */
export function toManualUnitInput(state: FormState): ManualUnitInput {
  const skills = parseTags(state.skills);
  const tools = parseTags(state.tools);
  const domains = parseTags(state.domains);
  const seniority_signals = parseTags(state.seniority_signals);
  const scope_signals = parseTags(state.scope_signals);
  const business_outcomes = parseTags(state.business_outcomes);
  const dateStart = parseDateOrUndefined(state.date_start);
  const dateEnd = parseDateOrUndefined(state.date_end);
  const confidence_score = Number(state.confidence_score);
  const source_ref = state.source_ref.trim();

  const input: ManualUnitInput = {
    raw_text: state.raw_text.trim(),
    normalized_summary: state.normalized_summary.trim(),
    unit_type: state.unit_type,
    confidence_score,
    ...(skills.length > 0 ? { skills } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(domains.length > 0 ? { domains } : {}),
    ...(seniority_signals.length > 0 ? { seniority_signals } : {}),
    ...(scope_signals.length > 0 ? { scope_signals } : {}),
    ...(business_outcomes.length > 0 ? { business_outcomes } : {}),
    ...(state.metrics.length > 0 ? { metrics: [...state.metrics] } : {}),
    ...(source_ref.length > 0 ? { source_ref } : {}),
    ...(dateStart !== undefined
      ? { date_range: dateEnd !== undefined ? { start: dateStart, end: dateEnd } : { start: dateStart } }
      : {}),
  };
  return input;
}

export default function ManualAddForm({
  onSubmit,
  onClose,
}: ManualAddFormProps): ReactElement {
  const [state, setState] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const [touched, setTouched] = useState(false);

  // Draft content here lives only in React state, so the update banner
  // must confirm before a reload discards it (Codex P2, #434). Dirty
  // means any field diverges from the pristine form — comparing against
  // EMPTY_FORM rather than tracking a flag keeps it correct when the
  // user edits a field back to its original value.
  useEffect(() => {
    // Value comparison, not reference: `metrics` is an array, so adding
    // and then removing the last one yields a NEW empty array that is
    // `!==` the pristine one — leaving the form permanently dirty and
    // demanding a confirmation to protect nothing (CodeRabbit P2, #434).
    const dirty = (Object.keys(EMPTY_FORM) as Array<keyof FormState>).some(
      (k) => {
        const current = state[k];
        const pristine = EMPTY_FORM[k];
        if (Array.isArray(current) && Array.isArray(pristine)) {
          return (
            current.length !== pristine.length ||
            JSON.stringify(current) !== JSON.stringify(pristine)
          );
        }
        return current !== pristine;
      },
    );
    if (!dirty) return;
    return beginUnsavedWork("unitReview.manualAdd");
  }, [state]);

  const errors = validateForm(state);
  const hasErrors = Object.keys(errors).length > 0;
  const showErrors = touched;

  const setField = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ) => {
    setState((s) => ({ ...s, [key]: value }));
  };

  /**
   * Start-date input handler — delegates to the pure
   * `applyDateStartChange` helper which handles the cascade
   * clear of end-date when start is wiped (Codex P2 on #94).
   */
  const setDateStart = (value: string) => {
    setState((s) => applyDateStartChange(s, value));
  };

  /**
   * Escape-to-close handler. Standard modal accessibility — the
   * Escape key closes the dialog same as the Cancel button.
   * Skipped while submitting so a stray keypress mid-save
   * doesn't lose draft state. CodeRabbit Minor on #94 also
   * suggested a focus trap; deferring that to a follow-up
   * (would need a new dep or a non-trivial custom hook; not
   * worth it for V1 single-user).
   */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, submitting]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTouched(true);
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(toManualUnitInput(state));
      // Parent closes the form on resolve via onClose; we don't
      // call it here to avoid double-close races.
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setSubmitting(false);
    }
  };

  // -- Metrics editor -----------------------------------------

  const updateMetricAt = (index: number, partial: Partial<Metric>) => {
    setState((s) => {
      const next = s.metrics.map((m, i) =>
        i === index ? stripUndefined({ ...m, ...partial }) : m,
      );
      return { ...s, metrics: next };
    });
  };
  const removeMetricAt = (index: number) => {
    setState((s) => ({
      ...s,
      metrics: s.metrics.filter((_, i) => i !== index),
    }));
  };
  const addMetric = () => {
    setState((s) => ({
      ...s,
      metrics: [
        ...s.metrics,
        { claim: "", confidence: "high" as MetricConfidence },
      ],
    }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add Unit manually"
      className="fixed inset-0 z-10 flex items-center justify-center bg-zinc-900/50 px-4"
      data-modal="manual-add"
    >
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
      >
        <header className="mb-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Add Unit manually
          </h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            For experiences that didn&rsquo;t make it into your resume
            or LinkedIn — side projects, undocumented wins, pre-LinkedIn
            work. Stamped as <code>source_type: &quot;manual&quot;</code> with
            <code> user_approved: true</code>.
          </p>
        </header>

        {error !== null && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            Couldn&rsquo;t save: {error.message}
          </div>
        )}

        <div className="space-y-3">
          <label className="block">
            <span className={LABEL_CLS}>Raw text *</span>
            <textarea
              className={`${TEXT_INPUT_CLS} min-h-[3rem]`}
              value={state.raw_text}
              onChange={(e) => setField("raw_text", e.target.value)}
              disabled={submitting}
              rows={3}
              data-field="raw_text"
              placeholder="The original phrasing, as you'd describe it informally."
            />
            {showErrors && errors.raw_text !== undefined && (
              <p
                className="mt-1 text-xs text-red-700 dark:text-red-300"
                data-error-for="raw_text"
              >
                {errors.raw_text}
              </p>
            )}
          </label>

          <label className="block">
            <span className={LABEL_CLS}>Normalized summary *</span>
            <textarea
              className={`${TEXT_INPUT_CLS} min-h-[2.5rem]`}
              value={state.normalized_summary}
              onChange={(e) =>
                setField("normalized_summary", e.target.value)
              }
              disabled={submitting}
              rows={2}
              data-field="normalized_summary"
              placeholder="A concise, resume-ready phrasing of the same content."
            />
            {showErrors && errors.normalized_summary !== undefined && (
              <p
                className="mt-1 text-xs text-red-700 dark:text-red-300"
                data-error-for="normalized_summary"
              >
                {errors.normalized_summary}
              </p>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={LABEL_CLS}>Unit type *</span>
              <select
                className={TEXT_INPUT_CLS}
                value={state.unit_type}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setField("unit_type", e.target.value as UnitType)
                }
                disabled={submitting}
                data-field="unit_type"
              >
                {UNIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {showErrors && errors.unit_type !== undefined && (
                <p
                  className="mt-1 text-xs text-red-700 dark:text-red-300"
                  data-error-for="unit_type"
                >
                  {errors.unit_type}
                </p>
              )}
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Source ref</span>
              <input
                type="text"
                className={TEXT_INPUT_CLS}
                value={state.source_ref}
                onChange={(e) => setField("source_ref", e.target.value)}
                disabled={submitting}
                placeholder="manual entry"
                data-field="source_ref"
              />
            </label>
          </div>

          {(
            [
              ["skills", "Skills"],
              ["tools", "Tools"],
              ["domains", "Domains"],
              ["seniority_signals", "Seniority signals"],
              ["scope_signals", "Scope signals"],
              ["business_outcomes", "Business outcomes"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              <span className={LABEL_CLS}>{label}</span>
              <textarea
                rows={2}
                className={`${TEXT_INPUT_CLS} font-mono`}
                placeholder="one per line"
                value={state[key]}
                onChange={(e) => setField(key, e.target.value)}
                disabled={submitting}
                data-field={key}
              />
            </label>
          ))}

          <div className="grid grid-cols-3 gap-3">
            <label className="block">
              <span className={LABEL_CLS}>Start date</span>
              <input
                type="date"
                className={TEXT_INPUT_CLS}
                value={state.date_start}
                onChange={(e) => setDateStart(e.target.value)}
                disabled={submitting}
                data-field="date_start"
              />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>End date</span>
              <input
                type="date"
                className={TEXT_INPUT_CLS}
                value={state.date_end}
                onChange={(e) => setField("date_end", e.target.value)}
                disabled={submitting || state.date_start.length === 0}
                data-field="date_end"
              />
            </label>
            <label className="block">
              <span className={LABEL_CLS}>Confidence (0-1)</span>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                className={TEXT_INPUT_CLS}
                value={state.confidence_score}
                onChange={(e) => setField("confidence_score", e.target.value)}
                disabled={submitting}
                data-field="confidence_score"
              />
            </label>
          </div>

          {showErrors && errors.date_range !== undefined && (
            <p
              className="text-xs text-red-700 dark:text-red-300"
              data-error-for="date_range"
            >
              {errors.date_range}
            </p>
          )}
          {showErrors && errors.confidence_score !== undefined && (
            <p
              className="text-xs text-red-700 dark:text-red-300"
              data-error-for="confidence_score"
            >
              {errors.confidence_score}
            </p>
          )}

          <div>
            <span className={LABEL_CLS}>Metrics</span>
            {state.metrics.length === 0 ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500">
                No metrics yet.
              </p>
            ) : (
              <ul className="space-y-2" data-field="metrics">
                {state.metrics.map((metric, index) => (
                  <li
                    key={index}
                    className="grid grid-cols-[1fr_6rem_5rem_5rem_6rem_auto] items-end gap-2"
                  >
                    <input
                      type="text"
                      placeholder="claim"
                      className={TEXT_INPUT_CLS}
                      value={metric.claim}
                      onChange={(e) =>
                        updateMetricAt(index, { claim: e.target.value })
                      }
                      disabled={submitting}
                    />
                    <input
                      type="number"
                      placeholder="value"
                      step="0.01"
                      className={TEXT_INPUT_CLS}
                      value={metric.value ?? ""}
                      onChange={(e) =>
                        updateMetricAt(index, {
                          value:
                            e.target.value === ""
                              ? undefined
                              : Number(e.target.value),
                        })
                      }
                      disabled={submitting}
                    />
                    <input
                      type="text"
                      placeholder="unit"
                      className={TEXT_INPUT_CLS}
                      value={metric.unit ?? ""}
                      onChange={(e) =>
                        updateMetricAt(index, {
                          unit:
                            e.target.value === ""
                              ? undefined
                              : e.target.value,
                        })
                      }
                      disabled={submitting}
                    />
                    <select
                      className={TEXT_INPUT_CLS}
                      value={metric.direction ?? ""}
                      onChange={(e) =>
                        updateMetricAt(index, {
                          direction:
                            e.target.value === ""
                              ? undefined
                              : (e.target.value as MetricDirection),
                        })
                      }
                      disabled={submitting}
                    >
                      <option value="">—</option>
                      {METRIC_DIRECTIONS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <select
                      className={TEXT_INPUT_CLS}
                      value={metric.confidence}
                      onChange={(e) =>
                        updateMetricAt(index, {
                          confidence: e.target.value as MetricConfidence,
                        })
                      }
                      disabled={submitting}
                    >
                      {METRIC_CONFIDENCES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeMetricAt(index)}
                      disabled={submitting}
                      aria-label={`Remove metric ${index + 1}`}
                      className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={addMetric}
              disabled={submitting}
              className="mt-2 rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
            >
              + Add metric
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md px-3 py-1 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            data-action="cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            data-action="submit"
          >
            {submitting ? "Saving…" : "Add Unit"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Strip undefined keys from a metric object — same convention as
 * `applyMetricUpdate` in `inlineEditState.ts`. Defensive against
 * future Firestore writes via `manualInsert` (the build step
 * already strips, but keeping the form's in-memory state clean
 * makes the local debug experience match what gets persisted).
 */
function stripUndefined(metric: Metric): Metric {
  const out: Record<string, unknown> = { ...metric };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) delete out[key];
  }
  return out as unknown as Metric;
}
