import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importIntoPacket } from "./import-labels.mts";
import { assertOutsideRepo } from "./lib/cli.mts";
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
      "A1 fact-correct: partial — wrong year",
      "A2 fact-correct: N — invented metric",
      "A2 verbatim: N — paraphrased",
      "R1 requirement-equivalent: partial — drops consumer hardware",
      "[/label-swipe]",
    ]);
  });

  it("is idempotent", () => {
    const once = importLabels(sheet, scaffold, LABELS);
    const twice = importLabels(once.sheet, once.scaffold, LABELS);
    expect(twice.sheet).toBe(once.sheet);
    expect(twice.scaffold).toEqual(once.scaffold);
    expect(twice.written).toBe(0);
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

  it("refuses to write private output inside a git work tree", () => {
    expect(() => assertOutsideRepo(join(HERE, "decks"))).toThrow(/git work tree/);
    expect(() => assertOutsideRepo(packet)).not.toThrow();
  });
});
