/**
 * Reader for the calibration review sheets (`<cell>.md`) in a #636 packet.
 *
 * A sheet has five Markdown tables, in this order, under fixed headings:
 * extraction (`## a.`), unmatched extracted Units (`### Extracted Units …`,
 * one table per arm after a `**Arm A**:` / `**Arm B**:` line), requirements
 * (`## b.`), unmatched parsed Requirements (`### Parsed Requirements …`) and
 * matches (`## c.`). The résumé and JD follow under `## Source text` as
 * fenced `text` blocks. Columns are found by header text, not position, so a
 * reordered sheet still parses; a missing column is an error.
 *
 * Every data row gets a stable `key` (see `rowKey`) that the deck builder
 * puts in item ids and the importer uses to find the row again.
 */

export type Section = "extraction" | "unmatchedUnits" | "requirements" | "unmatchedRequirements" | "matches";

export interface TableRow {
  section: Section;
  /** Arm of the enclosing `**Arm X**` paragraph (unmatched Units only). */
  arm: string | null;
  /** Zero-based line index in the sheet. */
  line: number;
  headers: string[];
  cells: string[];
}

export interface ExtractionRow {
  key: string;
  line: number;
  labelId: string;
  labelText: string;
  arm: string;
  ref: string;
  rawText: string;
  summary: string;
}

export interface UnmatchedUnitRow {
  key: string;
  line: number;
  arm: string;
  ref: string;
  rawText: string;
  summary: string;
  skills: string;
  closestLabel: string;
}

export interface RequirementRow {
  key: string;
  line: number;
  labelId: string;
  labelText: string;
  labelMust: string;
  ref: string;
  parsedNormalized: string;
  parsedRaw: string;
  parsedMust: string;
}

export interface UnmatchedRequirementRow {
  key: string;
  line: number;
  ref: string;
  normalized: string;
  raw: string;
  category: string;
  must: string;
}

export interface MatchRow {
  key: string;
  line: number;
  pair: string;
  unitLabel: string;
  requirementLabel: string;
}

export interface Sheet {
  cell: string;
  resumeId: string;
  jdId: string;
  resumeText: string;
  jdText: string;
  extraction: ExtractionRow[];
  unmatchedUnits: UnmatchedUnitRow[];
  requirements: RequirementRow[];
  unmatchedRequirements: UnmatchedRequirementRow[];
  matches: MatchRow[];
}

/** Header prefixes of the owner columns the importer fills, per section. */
export const OWNER_COLUMNS = {
  extraction: { fact: "fact correct?", verbatim: "verbatim?", note: "note" },
  unmatchedUnits: { keep: "keep?", note: "note" },
  requirements: { equivalent: "correct?", mustHave: "must-have right?", note: "note" },
  unmatchedRequirements: { keep: "keep?", note: "note" },
  matches: { agree: "still agree?", note: "note" },
} as const;

/** Split one `| a | b |` row into trimmed cells, honouring `\|` escapes. */
export function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Inverse of `splitRow` for the sheet's `| a | b |` style (empty cell = two spaces). */
export function joinRow(cells: string[]): string {
  // Only "|" is escaped: splitRow unescapes "\|" and keeps every other
  // backslash literally, so escaping backslashes too would break the round
  // trip (tested over every fixture row).
  return `| ${cells.map((c) => c.split("|").join("\\|")).join(" | ")} |`;
}

/** Index of the first header starting with `prefix`; throws if absent. */
export function column(headers: string[], prefix: string): number {
  const index = headers.findIndex((h) => h.startsWith(prefix));
  if (index < 0) throw new Error(`sheet table is missing a "${prefix}" column (headers: ${headers.join(" / ")})`);
  return index;
}

const SEPARATOR = /^\|\s*:?-{3,}/;

/** Walk the sheet and return every data row of the five review tables. */
export function readTables(text: string): TableRow[] {
  const lines = text.split("\n");
  const rows: TableRow[] = [];
  let section: Section | null = null;
  let arm: string | null = null;
  let headers: string[] | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^## a\./.test(line)) section = "extraction";
    else if (/^### Extracted Units/.test(line)) section = "unmatchedUnits";
    else if (/^## b\./.test(line)) section = "requirements";
    else if (/^### Parsed Requirements/.test(line)) section = "unmatchedRequirements";
    else if (/^## c\./.test(line)) section = "matches";
    else if (/^## /.test(line)) section = null;

    const armMatch = /^\*\*Arm ([A-Z])\*\*/.exec(line);
    if (armMatch) arm = armMatch[1];

    if (!line.startsWith("|")) {
      headers = null;
      continue;
    }
    if (section === null) continue;
    if (headers === null) {
      if (SEPARATOR.test(lines[i + 1] ?? "")) {
        headers = splitRow(line);
        i += 1;
      }
      continue;
    }
    rows.push({ section, arm: section === "unmatchedUnits" ? arm : null, line: i, headers, cells: splitRow(line) });
  }
  return rows;
}

function fenced(text: string, heading: RegExp): { id: string; body: string } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return { id: "", body: "" };
  const id = /`([^`]+)`/.exec(lines[start])?.[1] ?? "";
  const open = lines.findIndex((l, i) => i > start && l.startsWith("```"));
  if (open < 0) return { id, body: "" };
  const close = lines.findIndex((l, i) => i > open && l.startsWith("```"));
  return { id, body: lines.slice(open + 1, close < 0 ? undefined : close).join("\n") };
}

const strip = (s: string) => s.replace(/\*\*/g, "").trim();

/** The stable row key the deck and the importer share. */
export function rowKey(row: TableRow, context: { labelId: string }): string | null {
  const c = row.cells;
  const h = row.headers;
  switch (row.section) {
    case "extraction":
      return `ext:${context.labelId}:${c[column(h, "arm")]}`;
    case "unmatchedUnits":
      return `unit:${/^([A-Z]\d+)/.exec(c[0])?.[1] ?? c[0]}`;
    case "requirements":
      return `req:${context.labelId}`;
    case "unmatchedRequirements":
      return `ureq:${/^([A-Z]\d+)/.exec(c[0])?.[1] ?? c[0]}`;
    case "matches":
      return `pair:${c[column(h, "expected pair")].replace(/`/g, "")}`;
  }
}

/**
 * Pair every table row with its key. Extraction rows whose first cell is `″`
 * inherit the label of the row above; rows with no extracted Unit or no
 * parsed Requirement get key `null` (nothing to judge).
 */
export function keyedRows(text: string): { row: TableRow; key: string | null }[] {
  let labelId = "";
  let section: Section | null = null;
  const firstLine = new Map<string, number>();
  return readTables(text).map((row) => {
    const c = row.cells;
    const h = row.headers;
    if (row.section !== section) {
      section = row.section;
      labelId = "";
    }
    if (row.section === "extraction") {
      const label = /^\*\*(.+?)\*\*:/.exec(c[column(h, "expected Unit")]);
      if (label) labelId = label[1];
      if (!/^[A-Z]\d+ \(/.test(c[column(h, "extracted `raw_text`")])) return { row, key: null };
    }
    if (row.section === "requirements") {
      const label = /^\*\*(.+?)\*\*/.exec(c[column(h, "expected requirement")]);
      if (label) labelId = label[1];
      if (!/^R\d+:/.test(c[column(h, "parsed `normalized_requirement`")])) return { row, key: null };
    }
    if ((row.section === "extraction" || row.section === "requirements") && !labelId) {
      throw new Error(`sheet line ${row.line + 1}: row has no expected label and none above it to inherit`);
    }
    const key = rowKey(row, { labelId });
    if (key !== null) {
      // A repeated key would make two cards share an item id and the importer write one label into two rows.
      const earlier = firstLine.get(key);
      if (earlier !== undefined) throw new Error(`sheet lines ${earlier + 1} and ${row.line + 1} share the row key ${key}`);
      firstLine.set(key, row.line);
    }
    return { row, key };
  });
}

export function parseSheet(text: string, cell: string): Sheet {
  const resume = fenced(text, /^### Résumé /);
  const jd = fenced(text, /^### JD /);
  const sheet: Sheet = {
    cell,
    resumeId: resume.id,
    jdId: jd.id,
    resumeText: resume.body,
    jdText: jd.body,
    extraction: [],
    unmatchedUnits: [],
    requirements: [],
    unmatchedRequirements: [],
    matches: [],
  };
  let labelText = "";
  let labelMust = "";

  for (const { row, key } of keyedRows(text)) {
    const c = row.cells;
    const h = row.headers;
    const get = (prefix: string) => c[column(h, prefix)] ?? "";
    if (row.section === "extraction") {
      const label = /^\*\*(.+?)\*\*:\s*(.*)$/.exec(get("expected Unit"));
      if (label) labelText = strip(label[2]);
      if (key === null) continue;
      const extracted = /^([A-Z]\d+) \([^)]*\):\s*(.*)$/s.exec(get("extracted `raw_text`"));
      sheet.extraction.push({
        key,
        line: row.line,
        labelId: key.split(":")[1],
        labelText,
        arm: get("arm"),
        ref: extracted?.[1] ?? "",
        rawText: extracted?.[2] ?? "",
        summary: get("extracted `normalized_summary`"),
      });
    } else if (row.section === "unmatchedUnits" && key) {
      sheet.unmatchedUnits.push({
        key,
        line: row.line,
        arm: row.arm ?? key.slice(5, 6),
        ref: key.slice(5),
        rawText: get("`raw_text`"),
        summary: get("`normalized_summary`"),
        skills: get("skills"),
        closestLabel: get("closest label").replace(/\s*\([\d.]+\)\s*$/, ""),
      });
    } else if (row.section === "requirements") {
      const label = /^\*\*(.+?)\*\* \((\w+)\):\s*(.*)$/.exec(get("expected requirement"));
      if (label) {
        labelMust = label[2];
        labelText = strip(label[3]);
      }
      if (key === null) continue;
      const parsed = /^(R\d+):\s*(.*)$/s.exec(get("parsed `normalized_requirement`"));
      sheet.requirements.push({
        key,
        line: row.line,
        labelId: key.slice(4),
        labelText,
        labelMust,
        ref: parsed?.[1] ?? "",
        parsedNormalized: parsed?.[2] ?? "",
        parsedRaw: get("parsed `raw_text`"),
        parsedMust: get("parsed must-have"),
      });
    } else if (row.section === "unmatchedRequirements" && key) {
      sheet.unmatchedRequirements.push({
        key,
        line: row.line,
        ref: key.slice(5),
        normalized: get("`normalized_requirement`"),
        raw: get("`raw_text`"),
        category: get("category"),
        must: get("must-have"),
      });
    } else if (row.section === "matches" && key) {
      sheet.matches.push({
        key,
        line: row.line,
        pair: key.slice(5),
        unitLabel: strip(get("Unit label")),
        requirementLabel: strip(get("Requirement label")),
      });
    }
  }
  return sheet;
}
