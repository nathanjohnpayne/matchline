/**
 * Write a labels file (from the swipe page) back into a review sheet's owner
 * columns and into the corrections scaffold's `notes`.
 *
 * Idempotent: re-importing the same labels changes nothing. A target cell
 * that already holds a different value is a conflict, and the import refuses
 * (writing nothing) unless `force` is set.
 */

import { OWNER_COLUMNS, column, joinRow, keyedRows } from "./sheet.mts";

export type Label = "true" | "false" | "mixed" | "unsure";

export interface LabelItem {
  item_id: string;
  type: string;
  label: Label;
  note: string;
  ms: number;
  order: number;
  undos: number;
  catch: boolean;
}

export interface LabelsFile {
  deck_id: string;
  seed: number;
  session_id: string;
  items: LabelItem[];
}

export interface Scaffold {
  notes: string;
  [key: string]: unknown;
}

/** Sheet value for a label: Y / N / partial; `unsure` leaves the cell blank. */
export function sheetValue(label: Label): string {
  return { true: "Y", false: "N", mixed: "partial", unsure: "" }[label];
}

/** Which owner column each card type fills. */
const TYPE_COLUMN: Record<string, { section: keyof typeof OWNER_COLUMNS; column: string; short: string }> = {
  "fact-correct": { section: "extraction", column: OWNER_COLUMNS.extraction.fact, short: "fact" },
  verbatim: { section: "extraction", column: OWNER_COLUMNS.extraction.verbatim, short: "verbatim" },
  "keep-unmatched-unit": { section: "unmatchedUnits", column: OWNER_COLUMNS.unmatchedUnits.keep, short: "keep" },
  "requirement-equivalent": { section: "requirements", column: OWNER_COLUMNS.requirements.equivalent, short: "same" },
  "must-have-right": { section: "requirements", column: OWNER_COLUMNS.requirements.mustHave, short: "must-have" },
  "keep-unmatched-requirement": { section: "unmatchedRequirements", column: OWNER_COLUMNS.unmatchedRequirements.keep, short: "keep" },
  "match-pair-agree": { section: "matches", column: OWNER_COLUMNS.matches.agree, short: "agree" },
};

export class ImportConflictError extends Error {
  constructor(public readonly conflicts: string[]) {
    super(`refusing to overwrite ${conflicts.length} filled cell(s) without --force: ${conflicts.join(", ")}`);
  }
}

export interface ImportResult {
  sheet: string;
  scaffold: Scaffold | null;
  written: number;
  unchanged: number;
  unknown: string[];
  /** Whether the corrections scaffold's notes changed. */
  scaffoldChanged: boolean;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function noteText(item: LabelItem): string {
  if (item.label === "unsure") return "can't tell";
  return clean(item.note ?? "");
}

type Note = { item: LabelItem; text: string };

/** One row's note: the bare note, or `fact: …; verbatim: …` when two cards have one. */
function formatNotes(notes: Note[]): string {
  return notes.length === 1 ? notes[0].text : notes.map((n) => `${TYPE_COLUMN[n.item.type].short}: ${n.text}`).join("; ");
}

/** Proper non-empty subsets (a row has at most two cards, so this stays tiny). */
function subsets<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 1; mask < (1 << xs.length) - 1; mask += 1) out.push(xs.filter((_, i) => mask & (1 << i)));
  return out;
}

/**
 * ` (<id>)` for a scaffold note line, read from the sheet row itself: the
 * extraction and unmatched cells carry it as `A1 (aaaa0001)`. A section-b
 * requirement row carries none, so its id is taken from the scaffold entry
 * whose `normalized_requirement` equals the parsed text, or left out.
 */
function rowId(section: string, cells: string[], headers: string[], scaffold: Scaffold | null): string {
  const cell =
    section === "extraction" ? cells[column(headers, "extracted `raw_text`")] : section === "requirements" ? "" : section === "matches" ? "" : cells[0];
  const inCell = /^[A-Z]\d+ \(([^)]+)\)/.exec(cell ?? "")?.[1];
  if (inCell) return ` (${inCell})`;
  if (section !== "requirements" || !Array.isArray(scaffold?.requirements)) return "";
  const parsed = cells[column(headers, "parsed `normalized_requirement`")].replace(/^R\d+:\s*/, "");
  const match = (scaffold.requirements as { id?: unknown; normalized_requirement?: unknown }[]).find((r) => r.normalized_requirement === parsed);
  return typeof match?.id === "string" ? ` (${match.id.slice(0, 8)})` : "";
}

/** The packet's item ref (A3, B12, R2) a row is about, if any. */
function rowRef(section: string, cells: string[], headers: string[]): string | null {
  const cell =
    section === "extraction"
      ? cells[column(headers, "extracted `raw_text`")]
      : section === "requirements"
        ? cells[column(headers, "parsed `normalized_requirement`")]
        : section === "matches"
          ? ""
          : cells[0];
  return /^([A-Z]\d+)\b/.exec(cell ?? "")?.[1] ?? null;
}

export function importLabels(sheetText: string, scaffold: Scaffold | null, labels: LabelsFile, options: { force?: boolean } = {}): ImportResult {
  const byRow = new Map<string, LabelItem[]>();
  const unknown: string[] = [];
  for (const item of labels.items) {
    if (item.catch) continue;
    const slash = item.item_id.lastIndexOf("/");
    const key = item.item_id.slice(0, slash);
    if (!TYPE_COLUMN[item.type] || item.item_id.slice(slash + 1) !== item.type) {
      unknown.push(item.item_id);
      continue;
    }
    byRow.set(key, [...(byRow.get(key) ?? []), item]);
  }

  const lines = sheetText.split("\n");
  const conflicts: string[] = [];
  const seen = new Set<string>();
  const scaffoldLines: string[] = [];
  let written = 0;
  let unchanged = 0;

  for (const { row, key } of keyedRows(sheetText)) {
    if (key === null) continue;
    const items = byRow.get(key);
    if (!items) continue;
    seen.add(key);
    const cells = [...row.cells];
    // `accept` lists other values that already mean this import's value,
    // such as the note an earlier, partial download of this session wrote.
    const set = (prefix: string, value: string, what: string, accept: string[] = []) => {
      const index = column(row.headers, prefix);
      const current = cells[index] ?? "";
      if (current === value) {
        unchanged += 1;
        return;
      }
      if (current !== "" && !accept.includes(current) && !options.force) conflicts.push(`${key} ${what}`);
      cells[index] = value;
      written += 1;
    };

    for (const item of items) {
      const value = sheetValue(item.label);
      const index = column(row.headers, TYPE_COLUMN[item.type].column);
      if (value) set(TYPE_COLUMN[item.type].column, value, item.type);
      else if (cells[index] !== "") {
        // Can't tell over an earlier answer: the two disagree.
        if (!options.force) conflicts.push(`${key} ${item.type}`);
        cells[index] = "";
        written += 1;
      }
    }
    const notes = items.map((item) => ({ item, text: noteText(item) })).filter((n) => n.text);
    if (notes.length) set("note", formatNotes(notes), "note", subsets(notes).map(formatNotes));
    // Keep the line ending of a CRLF sheet.
    lines[row.line] = joinRow(cells) + (lines[row.line].endsWith("\r") ? "\r" : "");

    // Arm A Units and the (arm A) requirements are what the scaffold holds.
    const ref = rowRef(row.section, row.cells, row.headers);
    if (ref && (ref.startsWith("A") || ref.startsWith("R"))) {
      for (const item of items) {
        if (item.label === "true") continue;
        const note = noteText(item);
        scaffoldLines.push(`${ref}${rowId(row.section, row.cells, row.headers, scaffold)} ${item.type}: ${sheetValue(item.label) || "can't tell"}${note && item.label !== "unsure" ? ` — ${note}` : ""}`);
      }
    }
  }
  for (const key of byRow.keys()) if (!seen.has(key)) unknown.push(key);

  let nextScaffold = scaffold;
  if (scaffold) {
    const block = scaffoldLines.length ? `[label-swipe deck=${labels.deck_id} session=${labels.session_id}]\n${scaffoldLines.join("\n")}\n[/label-swipe]` : "";
    const existing = /\[label-swipe [^\]]*\][\s\S]*?\[\/label-swipe\]/.exec(scaffold.notes ?? "");
    let notes = scaffold.notes ?? "";
    if (existing) {
      if (existing[0] !== block) {
        // A block from this same session is this import's own earlier,
        // partial write; replacing it is not a conflict.
        // Only a superset counts: an older, smaller download of the same
        // session, or a hand edit inside the block, would lose lines.
        const sameSession = existing[0].startsWith(`[label-swipe deck=${labels.deck_id} session=${labels.session_id}]`);
        const kept = new Set(block.split("\n"));
        const superset = existing[0].split("\n").every((line) => kept.has(line));
        if (!(sameSession && superset) && !options.force) conflicts.push("corrections notes");
        notes = (notes.slice(0, existing.index) + block + notes.slice(existing.index + existing[0].length)).trim();
      }
    } else if (block) {
      notes = notes ? `${notes.trimEnd()}\n\n${block}` : block;
    }
    nextScaffold = { ...scaffold, notes };
  }

  if (conflicts.length) throw new ImportConflictError(conflicts);
  return { sheet: lines.join("\n"), scaffold: nextScaffold, written, unchanged, unknown, scaffoldChanged: (nextScaffold?.notes ?? "") !== (scaffold?.notes ?? "") };
}
