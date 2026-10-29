import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UnknownItemsError, importIntoPacket } from "./import-labels.mts";
import { assertOutsideRepo, parseArgs } from "./lib/cli.mts";
import { ImportConflictError, importLabels, type LabelItem, type LabelsFile } from "./lib/importer.mts";
import { column, keyedRows } from "./lib/sheet.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "packet");
const CELL = "riley-demo-2026__acme-widgets-pm-2026";

function item(item_id: string, label: LabelItem["label"], note = "", extra: Partial<LabelItem> = {}): LabelItem {
  const type = item_id.slice(item_id.lastIndexOf("/") + 1);
  return { item_id, type, label, note, ms: 1000, order: 1, undos: 0, catch: false, ...extra };
}

const LABELS: LabelsFile = {
  deck_id: CELL,
  seed: 12345,
  session_id: "session-a",
  items: [
    item("ext:u_gizmo_launch:A/fact-correct", "mixed", "wrong year"),
    item("ext:u_gizmo_launch:A/verbatim", "true"),
    item("ext:u_sprocket_api:A/fact-correct", "false", "invented metric"),
    item("ext:u_sprocket_api:A/verbatim", "false", "paraphrased"),
    item("ext:u_mentoring:B/fact-correct", "unsure"),
    item("unit:A3/keep-unmatched-unit", "true"),
    item("unit:B4/keep-unmatched-unit", "false", "not a fact"),
    item("req:r_5yr_pm/requirement-equivalent", "mixed", "drops consumer hardware"),
    item("req:r_5yr_pm/must-have-right", "true"),
    item("ureq:R3/keep-unmatched-requirement", "true"),
    item("pair:u_sprocket_api:r_api_design/match-pair-agree", "false", "API was internal"),
    item("catch:1/fact-correct", "true", "", { catch: true }),
  ],
};

/** Owner cell for a row key and column prefix in a sheet. */
function cell(sheet: string, key: string, prefix: string): string {
  const found = keyedRows(sheet).find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}`);
  return found.row.cells[column(found.row.headers, prefix)];
}

describe("importLabels", () => {
  const sheet = readFileSync(join(FIXTURE, `${CELL}.md`), "utf8");
  const scaffold = JSON.parse(readFileSync(join(FIXTURE, "corrections", `${CELL}.json`), "utf8"));

  it("writes Y / N / partial and notes into the owner columns", () => {
    const out = importLabels(sheet, scaffold, LABELS).sheet;
    expect(cell(out, "ext:u_gizmo_launch:A", "fact correct?")).toBe("partial");
    expect(cell(out, "ext:u_gizmo_launch:A", "verbatim?")).toBe("Y");
    expect(cell(out, "ext:u_gizmo_launch:A", "note")).toBe("wrong year");
    expect(cell(out, "ext:u_sprocket_api:A", "note")).toBe("fact: invented metric; verbatim: paraphrased");
    expect(cell(out, "ext:u_mentoring:B", "fact correct?")).toBe("");
    expect(cell(out, "ext:u_mentoring:B", "note")).toBe("can't tell");
    expect(cell(out, "unit:A3", "keep?")).toBe("Y");
    expect(cell(out, "unit:B4", "keep?")).toBe("N");
    expect(cell(out, "req:r_5yr_pm", "correct?")).toBe("partial");
    expect(cell(out, "req:r_5yr_pm", "must-have right?")).toBe("Y");
    expect(cell(out, "ureq:R3", "keep?")).toBe("Y");
    expect(cell(out, "pair:u_sprocket_api:r_api_design", "still agree?")).toBe("N");
    // Rows without labels and the escaped pipe in a label survive unchanged.
    expect(cell(out, "pair:u_gizmo_launch:r_5yr_pm", "still agree?")).toBe("");
    expect(out).toContain("used by 9 \\| teams");
    expect(out.split("\n").length).toBe(sheet.split("\n").length);
  });

  it("adds the arm A and requirement notes to the scaffold notes", () => {
    const notes = importLabels(sheet, scaffold, LABELS).scaffold?.notes ?? "";
    expect(notes.split("\n")).toEqual([
      "[label-swipe deck=riley-demo-2026__acme-widgets-pm-2026 session=session-a]",
      "A1 (aaaa0001) fact-correct: partial — wrong year",
      "A2 (aaaa0002) fact-correct: N — invented metric",
      "A2 (aaaa0002) verbatim: N — paraphrased",
      "R1 (cccc0001) requirement-equivalent: partial — drops consumer hardware",
      "[/label-swipe]",
    ]);
  });

  it("names a section-b requirement's id only when the scaffold text matches", () => {
    const other = { ...scaffold, requirements: [{ id: "zzzz9999", normalized_requirement: "Something else." }] };
    expect(importLabels(sheet, other, LABELS).scaffold?.notes).toContain("\nR1 requirement-equivalent: partial");
  });

  it("is idempotent", () => {
    const once = importLabels(sheet, scaffold, LABELS);
    const twice = importLabels(once.sheet, once.scaffold, LABELS);
    expect(twice.sheet).toBe(once.sheet);
    expect(twice.scaffold).toEqual(once.scaffold);
    expect(twice.written).toBe(0);
    expect(twice.scaffoldChanged).toBe(false);
    expect(once.scaffoldChanged).toBe(true);
  });

  it("refuses to overwrite a filled cell without force, and overwrites with it", () => {
    const once = importLabels(sheet, scaffold, LABELS);
    const changed: LabelsFile = {
      ...LABELS,
      session_id: "session-b",
      items: [item("ext:u_gizmo_launch:A/verbatim", "false", "")],
    };
    expect(() => importLabels(once.sheet, once.scaffold, changed)).toThrow(ImportConflictError);
    const forced = importLabels(once.sheet, once.scaffold, changed, { force: true });
    expect(cell(forced.sheet, "ext:u_gizmo_launch:A", "verbatim?")).toBe("N");
  });

  it("accepts a later, fuller download from the same session without --force", () => {
    const partial: LabelsFile = { ...LABELS, items: LABELS.items.filter((i) => i.item_id !== "ext:u_sprocket_api:A/verbatim") };
    const first = importLabels(sheet, scaffold, partial);
    expect(cell(first.sheet, "ext:u_sprocket_api:A", "note")).toBe("invented metric");
    const full = importLabels(first.sheet, first.scaffold, LABELS);
    expect(cell(full.sheet, "ext:u_sprocket_api:A", "note")).toBe("fact: invented metric; verbatim: paraphrased");
    expect(full.scaffold?.notes).toBe(importLabels(sheet, scaffold, LABELS).scaffold?.notes);
    // Re-importing the older, smaller download would drop block lines: a conflict.
    expect(() => importLabels(full.sheet, full.scaffold, partial)).toThrow(ImportConflictError);
    // A different session's block is still a conflict.
    expect(() => importLabels(first.sheet, first.scaffold, { ...LABELS, session_id: "session-b" })).toThrow(ImportConflictError);
  });

  it("treats Can't tell over an earlier answer as a conflict, and clears it with --force", () => {
    const once = importLabels(sheet, scaffold, LABELS);
    const unsure: LabelsFile = { ...LABELS, items: [item("ext:u_gizmo_launch:A/verbatim", "unsure")] };
    expect(() => importLabels(once.sheet, null, unsure)).toThrow(/ext:u_gizmo_launch:A verbatim/);
    const forced = importLabels(once.sheet, null, unsure, { force: true });
    expect(cell(forced.sheet, "ext:u_gizmo_launch:A", "verbatim?")).toBe("");
  });

  it("clears an imported note when a forced re-import judges the whole row without one", () => {
    const once = importLabels(sheet, scaffold, LABELS);
    expect(cell(once.sheet, "ext:u_sprocket_api:A", "note")).not.toBe("");
    const corrected: LabelsFile = {
      ...LABELS,
      items: [item("ext:u_sprocket_api:A/fact-correct", "true"), item("ext:u_sprocket_api:A/verbatim", "true")],
    };
    expect(() => importLabels(once.sheet, null, corrected)).toThrow(ImportConflictError);
    const forced = importLabels(once.sheet, null, corrected, { force: true });
    expect(cell(forced.sheet, "ext:u_sprocket_api:A", "fact correct?")).toBe("Y");
    expect(cell(forced.sheet, "ext:u_sprocket_api:A", "note")).toBe("");
    // Judging one card of a two-card row leaves the other card's note alone.
    const one = importLabels(once.sheet, null, { ...LABELS, items: [item("ext:u_sprocket_api:A/verbatim", "true")] }, { force: true });
    expect(cell(one.sheet, "ext:u_sprocket_api:A", "note")).toBe("fact: invented metric; verbatim: paraphrased");
  });

  it("keeps CRLF line endings on rewritten rows", () => {
    const crlf = sheet.replace(/\n/g, "\r\n");
    const out = importLabels(crlf, null, LABELS).sheet;
    expect(out.split("\n").slice(0, -1).every((l) => l.endsWith("\r"))).toBe(true);
  });

  it("keeps hand-written scaffold notes", () => {
    const out = importLabels(sheet, { ...scaffold, notes: "Reviewed the low-score rows only." }, LABELS);
    expect(out.scaffold?.notes.startsWith("Reviewed the low-score rows only.\n\n[label-swipe ")).toBe(true);
  });

  it("reports items that match no row", () => {
    const out = importLabels(sheet, scaffold, { ...LABELS, items: [item("ext:u_nope:A/verbatim", "true"), item("x/bogus", "true")] });
    expect(out.unknown.sort()).toEqual(["ext:u_nope:A", "x/bogus"]);
  });
});

describe("import-labels CLI core", () => {
  let packet: string;
  beforeEach(() => {
    packet = mkdtempSync(join(tmpdir(), "label-swipe-"));
    cpSync(FIXTURE, packet, { recursive: true });
  });
  afterEach(() => rmSync(packet, { recursive: true, force: true }));

  it("fills the packet files in place and keeps the scaffold layout", () => {
    const labelsPath = join(packet, "labels.json");
    writeFileSync(labelsPath, JSON.stringify(LABELS));
    importIntoPacket(labelsPath, packet);
    const sheet = readFileSync(join(packet, `${CELL}.md`), "utf8");
    expect(cell(sheet, "unit:B4", "note")).toBe("not a fact");
    const raw = readFileSync(join(packet, "corrections", `${CELL}.json`), "utf8");
    expect(raw.endsWith("}")).toBe(true);
    expect(JSON.parse(raw).notes).toContain("[label-swipe deck=");
    expect(() => importIntoPacket(labelsPath, packet)).not.toThrow();
  });

  it("refuses to write private output inside a git work tree, also through a symlink", () => {
    expect(() => assertOutsideRepo(join(HERE, "decks"))).toThrow(/git work tree/);
    expect(() => assertOutsideRepo(packet)).not.toThrow();
    symlinkSync(HERE, join(packet, "link-into-repo"));
    expect(() => assertOutsideRepo(join(packet, "link-into-repo", "new", "decks"))).toThrow(/git work tree/);
  });

  it("refuses labels that match no row unless allowed, writing nothing", () => {
    const labelsPath = join(packet, "labels.json");
    writeFileSync(labelsPath, JSON.stringify({ ...LABELS, items: [...LABELS.items, item("ext:u_gone:A/verbatim", "true")] }));
    const before = readFileSync(join(packet, `${CELL}.md`), "utf8");
    expect(() => importIntoPacket(labelsPath, packet)).toThrow(UnknownItemsError);
    expect(readFileSync(join(packet, `${CELL}.md`), "utf8")).toBe(before);
    expect(importIntoPacket(labelsPath, packet, { allowUnknown: true }).unknown).toEqual(["ext:u_gone:A"]);
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseArgs(["--out"])).toThrow(/--out needs a value/);
    expect(() => parseArgs(["--packet="])).toThrow(/--packet needs a value/);
    expect(parseArgs(["a.json", "--force"], ["force"])).toEqual({ flags: new Map([["force", true]]), positional: ["a.json"] });
  });
});
