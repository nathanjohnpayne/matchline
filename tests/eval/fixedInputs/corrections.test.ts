import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyRequirementCorrections,
  applyUnitCorrections,
  CORRECTIONS_MANIFEST_PATH,
  isReviewField,
  loadCorrections,
  loadManifest,
  resolveSourceFlow,
  sha256File,
} from "./corrections.ts";
import { recordRequirements, recordUnits } from "./inputs.ts";
import { CELL, flowFor, JD, RESUME, savedItems } from "./testSupport.ts";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "matchline-corrections-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A scaffold built from `items`, every verdict "keep" unless overridden. */
function scaffold(items: ReturnType<typeof savedItems>): {
  resumeId: string;
  jdId: string;
  units: Record<string, unknown>[];
  requirements: Record<string, unknown>[];
  notes: string;
} {
  return {
    resumeId: RESUME,
    jdId: JD,
    units: items.units.map((u) => ({ ...u, owner_verdict: "keep", owner_corrected_raw_text: null })),
    requirements: items.requirements.map((q) => ({ ...q, owner_verdict: "keep", owner_corrected_text: null, owner_must_have: null })),
    notes: "",
  };
}

function write(name: string, body: unknown): string {
  const path = join(base, name);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

function manifestFor(path: string, cell = CELL): ReturnType<typeof loadManifest> {
  return { version: 1, entries: [{ sha256: sha256File(path), name: "test set v1", cell }] };
}

describe("manifest", () => {
  it("the committed manifest is valid and ships empty", () => {
    expect(loadManifest(CORRECTIONS_MANIFEST_PATH)).toEqual({ version: 1, entries: [] });
    expect(JSON.parse(readFileSync(CORRECTIONS_MANIFEST_PATH, "utf8"))).toEqual({ version: 1, entries: [] });
  });

  it("refuses an unlisted hash and prints it; accepts a listed one with its name", () => {
    const path = write("c.json", scaffold(savedItems(0)));
    const hash = sha256File(path);
    expect(() => loadCorrections(path, { version: 1, entries: [] })).toThrow(new RegExp(`sha256 ${hash} is not listed`));
    const loaded = loadCorrections(path, manifestFor(path));
    expect(loaded).toMatchObject({ sha256: hash, name: "test set v1", cell: CELL });
  });

  it("refuses a listed hash recorded for another cell, and a duplicate listing", () => {
    const path = write("c.json", scaffold(savedItems(0)));
    expect(() => loadCorrections(path, manifestFor(path, "other__cell"))).toThrow(/lists .* for cell other__cell/);
    const m = write("m.json", { version: 1, entries: [manifestFor(path).entries[0], manifestFor(path).entries[0]] });
    expect(() => loadManifest(m)).toThrow(/listed twice/);
  });
});

describe("applyUnitCorrections", () => {
  const items = savedItems(0);
  const source = recordUnits(flowFor("a", "inv", 0, items));

  it("keeps, fixes, drops and adds, stripping owner-review fields", () => {
    expect(isReviewField("owner_verdict")).toBe(true);
    expect(isReviewField("owner_uid")).toBe(false);
    const s = scaffold(items);
    s.units[1] = { ...s.units[1]!, owner_verdict: "fix", owner_corrected_raw_text: "Corrected raw text.", normalized_summary: "Corrected summary of the work", skills: ["new skill"] };
    s.units[2] = { ...s.units[2]!, owner_verdict: "drop" };
    s.units.push({ owner_verdict: "add", raw_text: "A missed fact.", normalized_summary: "A missed fact about launches", skills: ["launch"] });
    const { items: out, provenance } = applyUnitCorrections(s.units, source, "c.json");
    expect(out).toHaveLength(source.length);
    expect(out.every((u) => Object.keys(u).every((k) => !isReviewField(k)))).toBe(true);
    expect(out[0]).toEqual(source[0]);
    expect(out[1]).toMatchObject({ id: source[1]!.id, raw_text: "Corrected raw text.", normalized_summary: "Corrected summary of the work", skills: ["new skill"] });
    expect(out.at(-1)).toMatchObject({ id: "added_1", confidence_score: 1, seniority_signals: [], metrics: [], normalized_summary: "A missed fact about launches" });
    expect(out.at(-1)).not.toHaveProperty("date_range");
    expect(provenance.kept).toEqual(source.filter((_, i) => i !== 1 && i !== 2).map((u) => u.id));
    expect(provenance.fixed).toEqual([{ id: source[1]!.id, fields: ["normalized_summary", "raw_text", "skills"] }]);
    expect(provenance.dropped).toEqual([source[2]!.id]);
    expect(provenance.added).toEqual([{ id: "added_1", normalized_summary: "A missed fact about launches" }]);
  });

  it("refuses null verdicts, silent edits, empty fixes, bad adds and omissions", () => {
    const base0 = scaffold(items);
    const nullVerdict = structuredClone(base0);
    nullVerdict.units[0]!.owner_verdict = null;
    expect(() => applyUnitCorrections(nullVerdict.units, source, "c")).toThrow(/units\[0\]: owner_verdict is null/);
    const silent = structuredClone(base0);
    silent.units[0]!.normalized_summary = "edited without saying";
    expect(() => applyUnitCorrections(silent.units, source, "c")).toThrow(/marked keep but differs .* normalized_summary; mark it fix/);
    const noRaw = structuredClone(base0);
    noRaw.units[0]!.owner_verdict = "fix";
    expect(() => applyUnitCorrections(noRaw.units, source, "c")).toThrow(/needs owner_corrected_raw_text/);
    const same = structuredClone(base0);
    same.units[0] = { ...same.units[0]!, owner_verdict: "fix", owner_corrected_raw_text: source[0]!.raw_text };
    expect(() => applyUnitCorrections(same.units, source, "c")).toThrow(/changes nothing/);
    const badAdd = structuredClone(base0);
    badAdd.units.push({ owner_verdict: "add", raw_text: "x" });
    expect(() => applyUnitCorrections(badAdd.units, source, "c")).toThrow(/an added Unit needs/);
    const omitted = structuredClone(base0);
    omitted.units.pop();
    expect(() => applyUnitCorrections(omitted.units, source, "c")).toThrow(/omits saved item/);
    const stray = structuredClone(base0);
    stray.units[0]!.owner_corrected_raw_text = "x";
    expect(() => applyUnitCorrections(stray.units, source, "c")).toThrow(/set on a "keep" Unit/);
    const unknown = structuredClone(base0);
    unknown.units[0]!.owner_verdict = "maybe";
    expect(() => applyUnitCorrections(unknown.units, source, "c")).toThrow(/keep\|fix\|drop\|add/);
  });
});

describe("applyRequirementCorrections", () => {
  const items = savedItems(0);
  const source = recordRequirements(flowFor("a", "inv", 0, items));

  it("applies text and must-have overrides", () => {
    const s = scaffold(items);
    s.requirements[0] = { ...s.requirements[0]!, owner_verdict: "fix", owner_corrected_text: "Rewritten requirement text" };
    s.requirements[1] = { ...s.requirements[1]!, owner_verdict: "fix", owner_must_have: !source[1]!.must_have };
    s.requirements[2] = { ...s.requirements[2]!, owner_verdict: "drop" };
    const { items: out, provenance } = applyRequirementCorrections(s.requirements, source, "c");
    expect(out).toHaveLength(source.length - 1);
    expect(out[0]).toMatchObject({ id: source[0]!.id, normalized_requirement: "Rewritten requirement text", raw_text: source[0]!.raw_text });
    expect(out[1]!.must_have).toBe(!source[1]!.must_have);
    expect(out.every((q) => Object.keys(q).every((k) => !isReviewField(k)))).toBe(true);
    expect(provenance.fixed).toEqual([
      { id: source[0]!.id, fields: ["normalized_requirement"] },
      { id: source[1]!.id, fields: ["must_have"] },
    ]);
    expect(provenance.dropped).toEqual([source[2]!.id]);
  });

  it("refuses add, overrides on keep, and bad values", () => {
    const s = scaffold(items);
    const add = structuredClone(s);
    add.requirements.push({ owner_verdict: "add", normalized_requirement: "x" });
    expect(() => applyRequirementCorrections(add.requirements, source, "c")).toThrow(/Units only/);
    const keepOverride = structuredClone(s);
    keepOverride.requirements[0]!.owner_must_have = true;
    expect(() => applyRequirementCorrections(keepOverride.requirements, source, "c")).toThrow(/use "fix"/);
    const badMust = structuredClone(s);
    badMust.requirements[0] = { ...badMust.requirements[0]!, owner_verdict: "fix", owner_must_have: "yes" };
    expect(() => applyRequirementCorrections(badMust.requirements, source, "c")).toThrow(/true or false/);
  });
});

describe("resolveSourceFlow", () => {
  it("finds the one flow holding the file's ids, and refuses zero or several", () => {
    const a = flowFor("arm", "inv", 0, savedItems(0));
    const b = flowFor("arm", "inv", 1, savedItems(1));
    const path = write("c.json", scaffold(savedItems(1)));
    const loaded = loadCorrections(path, manifestFor(path));
    expect(resolveSourceFlow([a, b], loaded, "units")).toBe(b);
    expect(resolveSourceFlow([a, b], loaded, "requirements")).toBe(b);
    expect(() => resolveSourceFlow([a], loaded, "units")).toThrow(/no flow in --records/);
    const copy = flowFor("other", "inv2", 0, savedItems(1));
    expect(() => resolveSourceFlow([a, b, copy], loaded, "units")).toThrow(/ambiguous/);
  });
});
