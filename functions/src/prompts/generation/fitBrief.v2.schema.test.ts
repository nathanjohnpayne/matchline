import { describe, expect, it } from "vitest";

import { zodToToolSchema } from "../../llm/zodToolSchema.ts";

import * as schemaModule from "./fitBrief.v2.schema.ts";
import { FitBriefResponseV2Schema } from "./fitBrief.v2.schema.ts";

const KNOWN_GOOD = {
  bottom_line: "Strong platform fit; the years minimum is the risk.",
  strengths: [
    {
      jd_clause: "platform products other teams build on",
      evidence: ["Owned the checkout API used by four storefront teams."],
      argument: "Internal teams were the customers.",
    },
  ],
  exposures: [
    {
      jd_clause: "6+ years of PM",
      evidence: ["Product Manager, 2021–2025"],
      gap: "Titled PM years are fewer.",
      handling: "Argue scope.",
    },
  ],
  positioning: "Lead with the API.",
  homework: ["Draft an intake plan."],
  questions_to_ask: ["Who arbitrates conflicts?"],
  does_not_claim: ["Twelve-team scale."],
  verdict: "referral_needed",
  rule_audit: [
    { check: 1, outcome: "obeyed" },
    { check: 2, outcome: "not_applicable" },
  ],
  dropped_points: [
    {
      kind: "strength",
      jd_clause: "strong written communication",
      point: "Clear writer.",
      evidence: ["Shipped the returns flow."],
      reason: "span_does_not_support",
    },
    { kind: "exposure", jd_clause: "PCI", point: "Certified.", evidence: [], reason: "claim_rule", check: 1 },
  ],
};

const parses = (value: unknown) => FitBriefResponseV2Schema.safeParse(value).success;

describe("FitBriefResponseV2Schema", () => {
  it("accepts a well-formed brief, with or without level_strategy, and with an empty audit", () => {
    expect(parses(KNOWN_GOOD)).toBe(true);
    expect(parses({ ...KNOWN_GOOD, level_strategy: "Senior as posted." })).toBe(true);
    expect(parses({ ...KNOWN_GOOD, rule_audit: [], dropped_points: [] })).toBe(true);
  });

  it("requires a cited span for every strength, and allows an exposure with none (an absence has no span)", () => {
    expect(parses({ ...KNOWN_GOOD, strengths: [{ ...KNOWN_GOOD.strengths[0], evidence: [] }] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, exposures: [{ ...KNOWN_GOOD.exposures[0], evidence: [] }] })).toBe(true);
    // The field itself is required on an exposure: the span is cited or explicitly absent.
    const { evidence: _omitted, ...noEvidence } = KNOWN_GOOD.exposures[0]!;
    expect(parses({ ...KNOWN_GOOD, exposures: [noEvidence] })).toBe(false);
  });

  it("rejects a blank span anywhere", () => {
    expect(parses({ ...KNOWN_GOOD, strengths: [{ ...KNOWN_GOOD.strengths[0], evidence: ["  "] }] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, exposures: [{ ...KNOWN_GOOD.exposures[0], evidence: [""] }] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, dropped_points: [{ ...KNOWN_GOOD.dropped_points[0], evidence: [" "] }] })).toBe(false);
  });

  it("keeps v1's rule: no strengths only with verdict skip", () => {
    expect(parses({ ...KNOWN_GOOD, strengths: [] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, strengths: [], verdict: "skip" })).toBe(true);
  });

  it("requires the self-audit fields", () => {
    const { rule_audit: _a, ...noAudit } = KNOWN_GOOD;
    const { dropped_points: _d, ...noDropped } = KNOWN_GOOD;
    expect(parses(noAudit)).toBe(false);
    expect(parses(noDropped)).toBe(false);
  });

  it("rejects a rule_audit check below 1 or not an integer, an unknown outcome, or an extra field", () => {
    for (const check of [0, -1, 1.5]) {
      expect(parses({ ...KNOWN_GOOD, rule_audit: [{ check, outcome: "obeyed" }] })).toBe(false);
    }
    expect(parses({ ...KNOWN_GOOD, rule_audit: [{ check: 1, outcome: "violated" }] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, rule_audit: [{ check: 1, outcome: "obeyed", note: "x" }] })).toBe(false);
  });

  it("rejects an unknown dropped reason or kind, and ties check to reason claim_rule both ways", () => {
    const d = KNOWN_GOOD.dropped_points[0]!;
    expect(parses({ ...KNOWN_GOOD, dropped_points: [{ ...d, reason: "too_long" }] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, dropped_points: [{ ...d, kind: "homework" }] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, dropped_points: [{ ...d, reason: "claim_rule" }] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, dropped_points: [{ ...d, check: 1 }] })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, dropped_points: [{ ...d, reason: "claim_rule", check: 0 }] })).toBe(false);
  });

  it("rejects fields outside the contract, blank strings and an unknown verdict", () => {
    expect(parses({ ...KNOWN_GOOD, score: 0.9 })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, bottom_line: "   " })).toBe(false);
    expect(parses({ ...KNOWN_GOOD, verdict: "maybe" })).toBe(false);
  });

  it("asks for the span before the point, and ends the tool schema with the self-audit", () => {
    const schema = zodToToolSchema(FitBriefResponseV2Schema) as {
      properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
    };
    const top = Object.keys(schema.properties);
    expect(top.slice(-2)).toEqual(["rule_audit", "dropped_points"]);
    const strength = Object.keys(schema.properties.strengths!.items!.properties!);
    expect(strength.indexOf("evidence")).toBeLessThan(strength.indexOf("argument"));
    const exposure = Object.keys(schema.properties.exposures!.items!.properties!);
    expect(exposure.indexOf("evidence")).toBeLessThan(exposure.indexOf("gap"));
  });

  it("exports exactly one response schema", () => {
    expect(Object.keys(schemaModule).filter((k) => /ResponseV\d+Schema$/.test(k))).toEqual(["FitBriefResponseV2Schema"]);
  });
});
