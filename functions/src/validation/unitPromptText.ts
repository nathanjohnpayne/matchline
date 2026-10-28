/**
 * The one evidence text for an Experience Unit: exactly what a model
 * is shown about a Unit, wherever a model is shown one. It has three
 * consumers, and they must never see different text:
 *
 *   - generation (`../generation/resumeInput.ts`), which writes the
 *     resume from it;
 *   - traceability (`./traceability.ts`), which checks each claim
 *     against it;
 *   - the evidence version (`./unitEvidenceVersion.ts`), which hashes
 *     it so a verdict stops counting the moment the text changes.
 *
 * Before #485 generation and traceability each had their own
 * formatter, and they had drifted: generation showed tags and dates the
 * validator never saw, and the validator showed metrics and signals
 * generation never saw. Claims built from one side's fields could not
 * be traced by the other.
 *
 * **Any change to the output changes every Unit's evidence version,**
 * so it needs a new prefix in `./unitEvidenceVersion.ts`. The golden
 * tests (`./unitPromptText.test.ts`, `./unitEvidenceVersion.test.ts`)
 * fail until that happens.
 *
 * The formatter is not versioned with the prompts: an eval-harness
 * override to an older prompt version reads the current Unit text.
 *
 * Dependency-free at runtime so the app can import it across the
 * package boundary; the only import is type-only and erased.
 */

import type { ExperienceUnit, Metric } from "../types/capability.js";

/**
 * A metric as the prompt renders it. A numeric `value` is printed as
 * written (so `40`, `NaN` and `Infinity` stay distinct, #506); any
 * other value, and every other member, is JSON-encoded.
 */
export interface UnitPromptMetric {
  readonly claim: string;
  readonly value?: unknown;
  readonly unit?: string;
  readonly direction?: string;
}

/** A Unit's own dates, as the prompt renders them. */
export interface UnitPromptDateRange {
  readonly start?: string;
  readonly end?: string;
}

/** The Unit fields the prompt renders. */
export interface UnitPromptFields {
  readonly id: string;
  readonly raw_text: string;
  readonly normalized_summary: string;
  readonly metrics?: readonly UnitPromptMetric[];
  readonly seniority_signals?: readonly string[];
  readonly scope_signals?: readonly string[];
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly domains?: readonly string[];
  readonly date_range?: UnitPromptDateRange | null;
}

type FieldRole = "rendered" | `excluded: ${string}`;

/**
 * Every `ExperienceUnit` field, and whether the model sees it (#485).
 *
 * A compile-time drift guard: adding a field to `ExperienceUnit` fails
 * typecheck here until someone decides whether generation and the
 * validator read it. The reasons are the serialization-layer review's
 * losslessness answer (`docs/agents/operating-rules.md`). Tests check
 * that each `rendered` field changes the text and each excluded field
 * does not.
 */
export const UNIT_FIELD_ROLES = {
  id: "rendered",
  raw_text: "rendered",
  normalized_summary: "rendered",
  metrics: "rendered",
  seniority_signals: "rendered",
  scope_signals: "rendered",
  skills: "rendered",
  tools: "rendered",
  domains: "rendered",
  // Rendered as stored, with no reading added. A start-only range is
  // NOT rendered as "ongoing": the stored shape cannot tell a user's
  // "ongoing" (Unit Review's end-date field left blank) from an end
  // extraction never found, so neither model may read it as current
  // work (see `dateRangeLine`). An end later than the run date is
  // likewise shown as stored; the prompts, which see the run date
  // (`promptDate`), treat it as no end.
  date_range: "rendered",
  // User-editable (Unit Review inline edit and manual add), not just an
  // extraction output. Excluded because the 2026-10-28 #485 evidence
  // decision admits only the tags and date_range as structured
  // evidence. Whether user-written outcomes should count (literal
  // wording only, like tags) is a separate decision for a follow-up
  // issue; adding it then needs a new evidence-version prefix.
  business_outcomes:
    "excluded: user-editable outcome tags, but the #485 evidence decision admits only skills, tools, domains and date_range as structured evidence; counting them is a separate decision",
  unit_type: "excluded: classification metadata about the record, not a fact about the candidate",
  evidence_type: "excluded: classification metadata",
  confidence_score: "excluded: extraction-model confidence; approval already gates use",
  source_ref:
    "excluded: provenance pointer (storage paths, hashes); not evidence, and a privacy risk in prompts",
  source_type: "excluded: provenance",
  owner_uid: "excluded: tenancy",
  user_approved: "excluded: gated structurally by the loaders and the export gate",
  rejected: "excluded: gated structurally",
  flagged: "excluded: gated structurally",
  reembed_pending: "excluded: plumbing",
  embedding: "excluded: plumbing",
  created_at: "excluded: timestamp",
  updated_at: "excluded: timestamp",
} as const satisfies Record<keyof ExperienceUnit, FieldRole>;

/** Every `Metric` field, and whether the model sees it. See `UNIT_FIELD_ROLES`. */
export const METRIC_FIELD_ROLES = {
  claim: "rendered",
  value: "rendered",
  unit: "rendered",
  direction: "rendered",
  confidence: "excluded: extraction confidence, not a fact about the candidate",
} as const satisfies Record<keyof Metric, FieldRole>;

/**
 * Safely embed an arbitrary user-controlled string as a quoted
 * literal in the prompt body. `JSON.stringify` escapes embedded
 * `"`, backslashes, newlines, and control chars — the same shape
 * the few-shot examples already use.
 *
 * Codex P1 round 2 on PR #111: the prior version interpolated raw
 * strings inside `"..."` quotes, so any `"` inside the input
 * (legitimate — e.g. a quoted project name, a metric claim with
 * a quoted phrase) broke the format. A claim text `The user led
 * "Project Alpha"` would render as `Claim: "The user led "Project
 * Alpha"."` — malformed, and the prompt-friendly structure the
 * downstream model depends on was lost.
 *
 * `JSON.stringify` for short strings is identical to a hand-
 * written escape function but is part of the runtime, well-
 * tested, and unambiguous to readers.
 */
export function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * An entity id as the prompt prints it: bare when it is safe (every
 * UUID and every fixture id), JSON-quoted otherwise, so no id can
 * break a line or forge a section delimiter.
 */
export function renderEntityId(id: string): string {
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)
    ? id
    : (JSON.stringify(id) ?? "null");
}

/**
 * The id a model meant when it cites one. `renderEntityId` prints an
 * unsafe id JSON-quoted (`[Unit "a b"]`), and both prompts say to cite
 * an id exactly as written, so a model may echo the quotes. Both
 * consumers compare cited ids with the raw ids, so without this a
 * correct citation of a quoted id would fail closed (#485 review).
 *
 * Undoes exactly that quoting and nothing else: a cited value that is
 * `renderEntityId`'s quoted rendering of some id maps back to that id;
 * any other value, including every safe id, is returned unchanged.
 */
export function citedEntityId(cited: string): string {
  if (cited.length < 2 || !cited.startsWith('"') || !cited.endsWith('"')) return cited;
  let decoded: unknown;
  try {
    decoded = JSON.parse(cited);
  } catch {
    return cited;
  }
  return typeof decoded === "string" && renderEntityId(decoded) === cited ? decoded : cited;
}

/**
 * Any value as one line of JSON. `undefined`, functions and symbols
 * (which `JSON.stringify` drops) and anything it cannot encode render
 * as `null`, so neither the word `undefined` nor a raw newline ever
 * reaches the text.
 */
function jsonValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

/** A list field's line, or `null` when the field is absent, empty or malformed. */
function listLine(name: string, field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  return `${name}: [${field.map(jsonValue).join(", ")}]`;
}

/**
 * The `date_range` line, or `null` when there is no string date to show.
 *
 * Lossy on purpose, and fail-safe: a range with a `start` and no `end`
 * renders as `date_range: { start: "…" }`, with nothing saying whether
 * the work is ongoing. The app writes that shape in two cases it cannot
 * tell apart afterwards: the user cleared the end date in Unit Review,
 * meaning "ongoing", and extraction found a start but no end. The
 * second is not evidence that the work is current, so the text does
 * not claim it, and both prompts say a range with no `end` supports
 * neither an end date nor "present" (traceability.v2 rule 3, resume.v2
 * rule 7). A user's "ongoing" therefore cannot yet support "present";
 * making it evidence needs an explicit stored marker that only the
 * editor sets, a new rendered member, and a new evidence-version
 * prefix. Until then the editor labels the blank end as "no end date",
 * not "ongoing".
 */
function dateRangeLine(dr: unknown): string | null {
  if (typeof dr !== "object" || dr === null) return null;
  const { start, end } = dr as { start?: unknown; end?: unknown };
  const members: string[] = [];
  if (typeof start === "string") members.push(`start: ${quote(start)}`);
  if (typeof end === "string") members.push(`end: ${quote(end)}`);
  if (members.length === 0) return null;
  return `date_range: { ${members.join(", ")} }`;
}

/**
 * One Unit's evidence text. Deterministic, never throws on
 * Firestore-shaped data (including wrongly typed fields and metric
 * entries), and every value is either JSON-encoded on a labelled line
 * (a numeric metric value as written, which has no line break) or an
 * id through `renderEntityId`, so no value can start a line of its own.
 *
 * The Unit `id` is critical: both models answer with it
 * (`source_unit_ids`, `supporting_unit_id`), and both callers check
 * set membership on what comes back.
 *
 * Optional lists are emitted only when non-empty, and an absent list
 * renders exactly like an empty one, which keeps the text tight on the
 * common case.
 */
export function formatUnit(unit: UnitPromptFields): string {
  // A metric entry that is not an object (`null`, a string) carries no
  // claim, so it is skipped rather than rendered as an empty record.
  const metrics = Array.isArray(unit.metrics) ? unit.metrics.filter(isMetricRecord) : [];
  const metricsBlock =
    metrics.length > 0 ? metrics.map((m) => formatMetric(m)).join(",\n") : "  (no metrics)";
  const lines: string[] = [
    `[Unit ${renderEntityId(unit.id)}]`,
    `raw_text: ${jsonValue(unit.raw_text)}`,
    `normalized_summary: ${jsonValue(unit.normalized_summary)}`,
    `metrics: [`,
    metricsBlock,
    `]`,
  ];
  for (const line of [
    listLine("seniority_signals", unit.seniority_signals),
    listLine("scope_signals", unit.scope_signals),
    listLine("skills", unit.skills),
    listLine("tools", unit.tools),
    listLine("domains", unit.domains),
    dateRangeLine(unit.date_range),
  ]) {
    if (line !== null) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * The run date both prompts show beside the Unit block, as
 * `YYYY-MM-DD` in UTC, so a model can tell a past `date_range` end
 * from one in the future. Extraction has defaulted some ends into the
 * future, and an end later than this date supports no claim
 * (traceability.v2 rule 3, resume.v2 rule 7).
 *
 * Deliberately not part of `formatUnit`'s text: the date changes every
 * day and the Unit does not, so putting it in the Unit text would make
 * every evidence version change daily. Passing time only turns future
 * ends into past ones, so a verdict reached under an earlier date is
 * never less conservative than one reached today.
 */
export function promptDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The Unit block both prompts embed: `formatUnit` per Unit, separated by one blank line. */
export function formatUnitBlock(units: readonly UnitPromptFields[]): string {
  return units.map(formatUnit).join("\n\n");
}

function isMetricRecord(m: unknown): m is UnitPromptMetric {
  return typeof m === "object" && m !== null && !Array.isArray(m);
}

/**
 * One metric line. A numeric value prints as written, so `NaN`,
 * `Infinity` and `40` keep #506's distinctions (and `null` still prints
 * `null`); any other value is JSON-encoded, so a string value can
 * neither break the line nor forge a delimiter, and an object value
 * shows its contents instead of `[object Object]`. `firestore.rules`
 * checks the metric keys a client writes, not their types (#485 review).
 */
function formatMetric(m: UnitPromptMetric): string {
  const parts: string[] = [`claim: ${jsonValue(m.claim)}`];
  if (m.value !== undefined) {
    parts.push(`value: ${typeof m.value === "number" ? String(m.value) : jsonValue(m.value)}`);
  }
  if (m.unit !== undefined) parts.push(`unit: ${jsonValue(m.unit)}`);
  if (m.direction !== undefined) parts.push(`direction: ${jsonValue(m.direction)}`);
  return `  { ${parts.join(", ")} }`;
}
