import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildDecks } from "./build-deck.mts";
import { buildCatchCards, cellOrder, closestLines, falsifyNumber, sectionHeading } from "./lib/deck.mts";
import { joinRow, keyedRows, parseSheet, splitRow } from "./lib/sheet.mts";

const PACKET = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "packet");
const CELL = "riley-demo-2026__acme-widgets-pm-2026";
const SHEET = readFileSync(join(PACKET, `${CELL}.md`), "utf8");

describe("sheet parser", () => {
  it("round-trips table rows, including escaped pipes", () => {
    expect(splitRow("| a | b \\| c |  |")).toEqual(["a", "b | c", ""]);
    for (const { row } of keyedRows(SHEET)) {
      expect(joinRow(row.cells)).toBe(SHEET.split("\n")[row.line]);
    }
  });

  it("reads every section and the source text", () => {
    const sheet = parseSheet(SHEET, CELL);
    expect(sheet.resumeId).toBe("riley-demo-2026");
    expect(sheet.jdId).toBe("acme-widgets-pm-2026");
    expect(sheet.resumeText).toContain("Gizmo 3");
    expect(sheet.jdText).toContain("Minimum qualifications");
    // The ditto row inherits its label; the row with no extracted Unit is skipped.
    expect(sheet.extraction.map((r) => r.key)).toEqual([
      "ext:u_gizmo_launch:A",
      "ext:u_gizmo_launch:B",
      "ext:u_sprocket_api:A",
      "ext:u_sprocket_api:B",
      "ext:u_mentoring:B",
    ]);
    expect(sheet.extraction[2]).toMatchObject({ ref: "A2", labelText: "Built the Sprocket partner API used by 9 | teams" });
    expect(sheet.unmatchedUnits.map((r) => [r.key, r.arm, r.closestLabel])).toEqual([
      ["unit:A3", "A", "u_gizmo_launch"],
      ["unit:B4", "B", "u_mentoring"],
    ]);
    expect(sheet.requirements.map((r) => [r.key, r.ref, r.parsedMust, r.labelMust])).toEqual([
      ["req:r_5yr_pm", "R1", "must", "must"],
      ["req:r_api_design", "R2", "nice", "nice"],
    ]);
    expect(sheet.unmatchedRequirements.map((r) => r.key)).toEqual(["ureq:R3"]);
    expect(sheet.matches.map((r) => r.pair)).toEqual(["u_gizmo_launch:r_5yr_pm", "u_sprocket_api:r_api_design"]);
  });

  it("fails loudly when an owner column is missing", () => {
    expect(() => keyedRows(SHEET.replace("| arm |", "| side |"))).toThrow(/arm/);
  });
});

describe("deck converter", () => {
  const [deck] = buildDecks(PACKET, join(PACKET, "no-fixtures"));
  const real = deck.cards.filter((c) => !c.catch);

  it("builds one deck per sheet, skipping README and SUMMARY", () => {
    expect(buildDecks(PACKET).map((d) => d.deck_id)).toEqual([CELL]);
    expect(deck.format).toBe("matchline-label-deck/1");
  });

  it("emits one card per owner judgment with the documented types", () => {
    const count = (type: string) => real.filter((c) => c.type === type).length;
    expect(count("fact-correct")).toBe(5);
    expect(count("verbatim")).toBe(5);
    expect(count("keep-unmatched-unit")).toBe(2);
    expect(count("requirement-equivalent")).toBe(2);
    expect(count("must-have-right")).toBe(2);
    expect(count("keep-unmatched-requirement")).toBe(1);
    expect(count("match-pair-agree")).toBe(2);
    expect(new Set(deck.cards.map((c) => c.item_id)).size).toBe(deck.cards.length);
    expect(real[0].item_id).toBe("ext:u_gizmo_launch:A/fact-correct");
  });

  it("puts the closest résumé line beside an extracted Unit", () => {
    const card = real.find((c) => c.item_id === "ext:u_sprocket_api:A/fact-correct");
    expect(card?.evidence[0].text).toBe("Built the Sprocket partner API, adopted by 9 internal teams across three business units.");
    expect(card?.highlight.resume).toHaveLength(1);
  });

  it("never shows scores, arm-mapping columns or refs on a card", () => {
    const visible = JSON.stringify(deck.cards.map((c) => [c.claim, c.evidence]));
    expect(visible).not.toMatch(/0\.\d{3}|U✓|U✗|≥0\.|\bA\d+ \(|aaaa000/);
  });

  it("mixes in catch cards with known answers", () => {
    const catches = deck.cards.filter((c) => c.catch);
    expect(catches.length).toBeGreaterThanOrEqual(3);
    for (const c of catches) expect(["true", "false"]).toContain(c.expected);
    expect(real.every((c) => c.expected === undefined)).toBe(true);
  });
});

describe("deck helpers", () => {
  it("orders cells nathan first, then alphabetically", () => {
    expect(cellOrder(["zoe-x", "bo-y", "nathan-z", "cy-w"])).toEqual(["nathan-z", "bo-y", "cy-w", "zoe-x"]);
  });

  it("finds the closest lines and the section heading", () => {
    const text = "Header\n\nMinimum qualifications\n- 5 years of widget management.\n- Unrelated line about cats.";
    expect(closestLines(text, "five years widget management", 2)).toEqual([3]);
    expect(closestLines(text, "quantum astrophysics")).toEqual([]);
    expect(sectionHeading(text, 3)).toBe("Minimum qualifications");
  });

  it("falsifies the first number", () => {
    expect(falsifyNumber("Grew revenue 12% in 2024")).toBe("Grew revenue 27% in 2024");
    expect(falsifyNumber("Shipped in 2024 to 40 stores")).toBe("Shipped in 2021 to 40 stores");
    expect(falsifyNumber("No digits here")).toBeNull();
  });

  it("builds catch cards deterministically per deck id", () => {
    const resume = parseSheet(SHEET, CELL).resumeText;
    const jd = parseSheet(SHEET, CELL).jdText;
    expect(buildCatchCards("x", resume, jd)).toEqual(buildCatchCards("x", resume, jd));
    const falsified = buildCatchCards("x", resume, jd).find((c) => c.expected === "false" && c.type === "fact-correct");
    expect(falsified?.claim[0].text).not.toBe(falsified?.evidence[0].text);
  });
});
