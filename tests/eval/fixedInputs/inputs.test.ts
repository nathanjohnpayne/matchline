import { describe, expect, it } from "vitest";

import { loadExpectedMatches, loadExpectedUnits } from "../loadFixtures.ts";
import { mapRequirementIds, mapUnitIds } from "../mapping.ts";

import {
  buildConditions,
  goldRequirements,
  goldUnits,
  identityMap,
  recordRequirements,
  recordUnits,
  textsToEmbed,
} from "./inputs.ts";
import { flowFor, JD, RESUME, savedItems } from "./testSupport.ts";

const eu = loadExpectedUnits(RESUME).expected_units;
const em = loadExpectedMatches(RESUME, JD);

describe("gold inputs", () => {
  it("gold Units carry the label fields and the diagnostic's constants", () => {
    const g = goldUnits(eu);
    expect(g).toHaveLength(eu.length);
    const first = g[0]!;
    expect(first).toEqual({
      id: eu[0]!.id,
      owner_uid: "eval-user",
      source_type: "resume",
      source_ref: "gold",
      raw_text: eu[0]!.normalized_summary,
      normalized_summary: eu[0]!.normalized_summary,
      unit_type: "achievement",
      skills: [...eu[0]!.skills],
      tools: [...(eu[0]!.tools ?? [])],
      domains: [...(eu[0]!.domains ?? [])],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified",
      confidence_score: 1,
      user_approved: true,
      created_at: "",
      updated_at: "",
    });
    expect(first).not.toHaveProperty("date_range");
    expect(first).not.toHaveProperty("embedding");
  });

  it("gold Requirements carry no structure", () => {
    const g = goldRequirements(em.expected_requirements);
    const q = em.expected_requirements[0]!;
    expect(g[0]).toEqual({
      id: q.id,
      owner_uid: "eval-user",
      role_id: "eval-role",
      raw_text: q.text,
      normalized_requirement: q.text,
      category: q.category,
      keywords: [],
      tools: [],
      domains: [],
      priority: q.must_have ? "high" : "medium",
      must_have: q.must_have,
      extracted_from: "gold",
    });
    for (const r of g) {
      expect(r.keywords).toEqual([]);
      expect(r.tools).toEqual([]);
      expect(r.domains).toEqual([]);
      expect(r).not.toHaveProperty("seniority_level");
    }
  });
});

describe("record inputs", () => {
  it("pass the saved Units and Requirements through unchanged", () => {
    const items = savedItems(0);
    const flow = flowFor("a", "inv", 0, items);
    expect(recordUnits(flow)).toEqual(items.units);
    expect(recordRequirements(flow)).toEqual(items.requirements);
  });

  it("refuse a flow that saved nothing", () => {
    const flow = flowFor("a", "inv", 0, null);
    expect(() => recordUnits(flow)).toThrow(/saved no Units/);
    expect(() => recordRequirements(flow)).toThrow(/saved no Requirements/);
  });
});

describe("buildConditions", () => {
  const items = savedItems(0, { dropUnits: 2 });
  const flow = flowFor("a", "inv", 0, items);
  const record = { units: recordUnits(flow), requirements: recordRequirements(flow) };
  const labels = { expectedUnits: eu, expectedMatches: em };

  it("builds the 2×2 in order, with label maps per side", () => {
    const cs = buildConditions(record, { units: { kind: "gold" }, requirements: { kind: "gold" } }, labels);
    expect(cs.map((c) => c.name)).toEqual(["record/record", "gold/record", "record/gold", "gold/gold"]);
    const [rr, gr, rg, gg] = cs;
    expect(rr!.unitMap).toEqual(mapUnitIds(eu, record.units));
    expect(rr!.requirementMap).toEqual(mapRequirementIds(em.expected_requirements, record.requirements));
    expect(gr!.unitMap).toEqual(identityMap(goldUnits(eu)));
    expect(gr!.requirementMap).toEqual(rr!.requirementMap);
    expect(rg!.requirementMap).toEqual(identityMap(goldRequirements(em.expected_requirements)));
    expect(gg!.units).toEqual(goldUnits(eu));
    expect(gg!.requirements).toEqual(goldRequirements(em.expected_requirements));
  });

  it("collapses when a side is record", () => {
    expect(buildConditions(record, { units: { kind: "record" }, requirements: { kind: "record" } }, labels).map((c) => c.name)).toEqual([
      "record/record",
    ]);
    expect(buildConditions(record, { units: { kind: "gold" }, requirements: { kind: "record" } }, labels).map((c) => c.name)).toEqual([
      "record/record",
      "gold/record",
    ]);
    expect(buildConditions(record, { units: { kind: "record" }, requirements: { kind: "gold" } }, labels).map((c) => c.name)).toEqual([
      "record/record",
      "record/gold",
    ]);
  });

  it("maps a corrected side like a record side", () => {
    const corrected = record.units.slice(1);
    const [, cr] = buildConditions(record, { units: { kind: "corrected", units: corrected }, requirements: { kind: "record" } }, labels);
    expect(cr!.name).toBe("corrected/record");
    expect(cr!.unitMap).toEqual(mapUnitIds(eu, corrected));
  });

  it("embeds Unit summaries and Requirement texts", () => {
    const cs = buildConditions(record, { units: { kind: "gold" }, requirements: { kind: "record" } }, labels);
    const texts = textsToEmbed(cs);
    expect(texts).toContain(record.units[0]!.normalized_summary);
    expect(texts).toContain(eu[0]!.normalized_summary);
    expect(texts).toContain(record.requirements[0]!.normalized_requirement);
  });
});
