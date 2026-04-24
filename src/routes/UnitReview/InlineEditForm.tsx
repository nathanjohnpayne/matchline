/**
 * The inline-edit form for an ExperienceUnit row. Renders every
 * editable field per the #81 contract:
 *
 *   - text: raw_text, normalized_summary, source_ref
 *   - select: source_type, unit_type, evidence_type
 *   - multi-value tag: skills, tools, domains, seniority_signals,
 *     scope_signals, business_outcomes
 *   - date range: date_range.start, date_range.end
 *   - numeric: confidence_score (0-1 slider)
 *   - nested list: metrics (claim/value/unit/direction/confidence)
 *
 * Presentational — receives the current `draft` and an `onChange`
 * that replaces the draft entirely. The row component owns the
 * `useState` for the draft and the save/cancel/error flow.
 */

import type { ChangeEvent, ReactElement } from "react";

import type {
  EvidenceType,
  Metric,
  MetricConfidence,
  MetricDirection,
  UnitSourceType,
  UnitType,
} from "../../types/capability.ts";

import type { EditableUnitFields } from "./inlineEditState.ts";

export interface InlineEditFormProps {
  readonly draft: EditableUnitFields;
  readonly onChange: (next: EditableUnitFields) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly status: "editing" | "saving" | "error";
  readonly error?: Error | null;
}

// -- Option lists -----------------------------------------------------------

const SOURCE_TYPES: readonly UnitSourceType[] = [
  "resume",
  "linkedin",
  "long_form",
  "manual",
];
const UNIT_TYPES: readonly UnitType[] = [
  "project",
  "achievement",
  "ownership",
  "skill_demo",
  "leadership",
  "technical_decision",
];
const EVIDENCE_TYPES: readonly EvidenceType[] = [
  "verified",
  "inferred",
  "user_confirmed",
];
const METRIC_DIRECTIONS: readonly MetricDirection[] = ["up", "down"];
const METRIC_CONFIDENCES: readonly MetricConfidence[] = [
  "high",
  "medium",
  "low",
];

// -- Small-helper types -----------------------------------------------------

const TEXT_INPUT_CLS =
  "w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100";
const LABEL_CLS =
  "mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400";

/**
 * Parse the CSV-ish tag input used for string-array fields. We
 * render the stored array as comma-joined text (since that's the
 * simplest single-line input) and split on commit. Entries are
 * trimmed; empty entries dropped.
 */
function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function joinTags(values: readonly string[]): string {
  return values.join(", ");
}

export default function InlineEditForm({
  draft,
  onChange,
  onSave,
  onCancel,
  status,
  error,
}: InlineEditFormProps): ReactElement {
  const setField = <K extends keyof EditableUnitFields>(
    key: K,
    value: EditableUnitFields[K],
  ) => {
    onChange({ ...draft, [key]: value });
  };

  const setTags =
    (
      key:
        | "skills"
        | "tools"
        | "domains"
        | "seniority_signals"
        | "scope_signals"
        | "business_outcomes",
    ) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      setField(key, parseTags(event.target.value));
    };

  const setDateStart = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (value === "") {
      // Clearing the start when end is also empty removes the range;
      // otherwise leave end in place (caller can clear it separately).
      const next = { ...draft };
      if (draft.date_range?.end === undefined) {
        delete next.date_range;
      } else {
        next.date_range = { start: "", end: draft.date_range.end };
      }
      onChange(next);
      return;
    }
    onChange({
      ...draft,
      date_range: {
        start: value,
        ...(draft.date_range?.end !== undefined
          ? { end: draft.date_range.end }
          : {}),
      },
    });
  };

  const setDateEnd = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (value === "") {
      // Clearing end when start is set means "ongoing"
      if (draft.date_range?.start !== undefined && draft.date_range.start !== "") {
        onChange({
          ...draft,
          date_range: { start: draft.date_range.start },
        });
      } else {
        const next = { ...draft };
        delete next.date_range;
        onChange(next);
      }
      return;
    }
    onChange({
      ...draft,
      date_range: {
        start: draft.date_range?.start ?? "",
        end: value,
      },
    });
  };

  const saving = status === "saving";

  return (
    <form
      data-edit-state={status}
      aria-label="Edit Unit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      className="space-y-3 bg-zinc-50 px-4 py-3 dark:bg-zinc-950"
    >
      {error && status === "error" && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          Save failed: {error.message}
        </div>
      )}

      <label className="block">
        <span className={LABEL_CLS}>Raw text</span>
        <textarea
          className={`${TEXT_INPUT_CLS} min-h-[3rem]`}
          value={draft.raw_text}
          onChange={(e) => setField("raw_text", e.target.value)}
          disabled={saving}
          rows={3}
        />
      </label>

      <label className="block">
        <span className={LABEL_CLS}>Normalized summary</span>
        <textarea
          className={`${TEXT_INPUT_CLS} min-h-[2.5rem]`}
          value={draft.normalized_summary}
          onChange={(e) => setField("normalized_summary", e.target.value)}
          disabled={saving}
          rows={2}
        />
      </label>

      <div className="grid grid-cols-3 gap-3">
        <label className="block">
          <span className={LABEL_CLS}>Source type</span>
          <select
            className={TEXT_INPUT_CLS}
            value={draft.source_type}
            onChange={(e) =>
              setField("source_type", e.target.value as UnitSourceType)
            }
            disabled={saving}
          >
            {SOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL_CLS}>Unit type</span>
          <select
            className={TEXT_INPUT_CLS}
            value={draft.unit_type}
            onChange={(e) => setField("unit_type", e.target.value as UnitType)}
            disabled={saving}
          >
            {UNIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL_CLS}>Evidence type</span>
          <select
            className={TEXT_INPUT_CLS}
            value={draft.evidence_type}
            onChange={(e) =>
              setField("evidence_type", e.target.value as EvidenceType)
            }
            disabled={saving}
          >
            {EVIDENCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className={LABEL_CLS}>Source ref</span>
        <input
          type="text"
          className={TEXT_INPUT_CLS}
          value={draft.source_ref}
          onChange={(e) => setField("source_ref", e.target.value)}
          disabled={saving}
        />
      </label>

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
          <input
            type="text"
            placeholder="comma-separated"
            className={TEXT_INPUT_CLS}
            value={joinTags(draft[key])}
            onChange={setTags(key)}
            disabled={saving}
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
            value={draft.date_range?.start ?? ""}
            onChange={setDateStart}
            disabled={saving}
          />
        </label>
        <label className="block">
          <span className={LABEL_CLS}>End date (blank = ongoing)</span>
          <input
            type="date"
            className={TEXT_INPUT_CLS}
            value={draft.date_range?.end ?? ""}
            onChange={setDateEnd}
            disabled={saving}
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
            value={draft.confidence_score}
            onChange={(e) =>
              setField(
                "confidence_score",
                Math.max(0, Math.min(1, Number(e.target.value) || 0)),
              )
            }
            disabled={saving}
          />
        </label>
      </div>

      <MetricsEditor
        metrics={draft.metrics}
        disabled={saving}
        onChange={(next) => setField("metrics", next)}
      />

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md px-3 py-1 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          data-action="save"
        >
          {saving
            ? "Saving…"
            : status === "error"
              ? "Retry save"
              : "Save"}
        </button>
      </div>
    </form>
  );
}

// --- MetricsEditor ---------------------------------------------------------

interface MetricsEditorProps {
  readonly metrics: readonly Metric[];
  readonly disabled: boolean;
  readonly onChange: (next: Metric[]) => void;
}

/**
 * Nested-list editor for the `metrics` array. Each row has claim,
 * value, unit, direction, confidence. The `claim` is required; the
 * rest are optional per the `Metric` type. "Remove" deletes a row;
 * "Add metric" appends an empty scaffold (claim="", confidence="high").
 */
function MetricsEditor({
  metrics,
  disabled,
  onChange,
}: MetricsEditorProps): ReactElement {
  const updateAt = (index: number, partial: Partial<Metric>) => {
    const next = metrics.map((m, i) =>
      i === index ? { ...m, ...partial } : m,
    );
    onChange(next);
  };
  const removeAt = (index: number) => {
    onChange(metrics.filter((_, i) => i !== index));
  };
  const add = () => {
    onChange([
      ...metrics,
      { claim: "", confidence: "high" as MetricConfidence },
    ]);
  };

  return (
    <div>
      <span className={LABEL_CLS}>Metrics</span>
      {metrics.length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          No metrics on this Unit.
        </p>
      ) : (
        <ul className="space-y-2" data-field="metrics">
          {metrics.map((metric, index) => (
            <li
              key={index}
              className="grid grid-cols-[1fr_6rem_5rem_5rem_6rem_auto] items-end gap-2"
            >
              <input
                type="text"
                placeholder="claim"
                className={TEXT_INPUT_CLS}
                value={metric.claim}
                onChange={(e) => updateAt(index, { claim: e.target.value })}
                disabled={disabled}
              />
              <input
                type="number"
                placeholder="value"
                step="0.01"
                className={TEXT_INPUT_CLS}
                value={metric.value ?? ""}
                onChange={(e) =>
                  updateAt(index, {
                    value:
                      e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
                disabled={disabled}
              />
              <input
                type="text"
                placeholder="unit"
                className={TEXT_INPUT_CLS}
                value={metric.unit ?? ""}
                onChange={(e) =>
                  updateAt(index, {
                    unit: e.target.value === "" ? undefined : e.target.value,
                  })
                }
                disabled={disabled}
              />
              <select
                className={TEXT_INPUT_CLS}
                value={metric.direction ?? ""}
                onChange={(e) =>
                  updateAt(index, {
                    direction:
                      e.target.value === ""
                        ? undefined
                        : (e.target.value as MetricDirection),
                  })
                }
                disabled={disabled}
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
                  updateAt(index, {
                    confidence: e.target.value as MetricConfidence,
                  })
                }
                disabled={disabled}
              >
                {METRIC_CONFIDENCES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeAt(index)}
                disabled={disabled}
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
        onClick={add}
        disabled={disabled}
        className="mt-2 rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-100"
      >
        + Add metric
      </button>
    </div>
  );
}
