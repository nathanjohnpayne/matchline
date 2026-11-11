import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256.ts";
import {
  UNIT_EVIDENCE_VERSION_PREFIX,
  unitEvidenceVersion,
  type UnitEvidenceFields,
} from "./unitEvidenceVersion.ts";
import { formatUnit } from "./unitPromptText.ts";

const base: UnitEvidenceFields = {
  id: "u1",
  raw_text: "Led a team of five.",
  normalized_summary: "Team lead.",
  metrics: [{ claim: "Grew revenue", value: 40, unit: "%", direction: "up" }],
  seniority_signals: ["lead"],
  scope_signals: ["team of 5"],
};

describe("unitEvidenceVersion", () => {
  it("is deterministic and prefixed with its encoding version", () => {
    expect(unitEvidenceVersion(base)).toBe(unitEvidenceVersion({ ...base }));
    expect(unitEvidenceVersion(base)).toMatch(/^ev3:[0-9a-f]{64}$/);
  });

  it("distinguishes an absent metric value from an explicit null, NaN and ±Infinity", () => {
    const withValue = (value: number | null | undefined) =>
      unitEvidenceVersion({ ...base, metrics: [{ claim: "Grew revenue", value, unit: "%", direction: "up" }] });
    const versions = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(
      withValue,
    );
    expect(new Set(versions).size).toBe(5);
  });

  it("changes when any field the validator reads changes", () => {
    const v = unitEvidenceVersion(base);
    const edits: Partial<UnitEvidenceFields>[] = [
      { id: "u2" },
      { raw_text: "Led a team of six." },
      { normalized_summary: "Team lead!" },
      { metrics: [{ claim: "Grew revenue", value: 41, unit: "%", direction: "up" }] },
      { metrics: [{ claim: "Grew revenue", value: 40, unit: "pp", direction: "up" }] },
      { metrics: [{ claim: "Grew revenue", value: 40, unit: "%", direction: "down" }] },
      { metrics: [{ claim: "Grew profit", value: 40, unit: "%", direction: "up" }] },
      { metrics: [] },
      { seniority_signals: ["principal"] },
      { scope_signals: [] },
      { skills: ["go"] },
      { tools: ["Go"] },
      { domains: ["payments"] },
      { date_range: { start: "2020-01-01" } },
    ];
    for (const edit of edits) {
      expect(unitEvidenceVersion({ ...base, ...edit }), JSON.stringify(edit)).not.toBe(v);
    }
  });

  it("changes when a date_range's end moves, and when a date_range appears", () => {
    const dated = { ...base, date_range: { start: "2020-01-01", end: "2022-06-30" } };
    expect(unitEvidenceVersion(dated)).not.toBe(
      unitEvidenceVersion({ ...base, date_range: { start: "2020-01-01", end: "2022-07-31" } }),
    );
    expect(unitEvidenceVersion(dated)).not.toBe(unitEvidenceVersion(base));
  });

  it("ignores fields the validator does not read", () => {
    const withExtras = {
      ...base,
      updated_at: "2026-05-01T00:00:00.000Z",
      user_approved: false,
      business_outcomes: ["x"],
      unit_type: "leadership",
      source_ref: "artifact://x",
      metrics: [{ ...base.metrics![0]!, confidence: "low" }],
    };
    expect(unitEvidenceVersion(withExtras)).toBe(unitEvidenceVersion(base));
  });

  it("does not collide across field boundaries", () => {
    expect(unitEvidenceVersion({ ...base, raw_text: "ab", normalized_summary: "c" })).not.toBe(
      unitEvidenceVersion({ ...base, raw_text: "a", normalized_summary: "bc" }),
    );
  });

  it("treats absent optional arrays like empty ones", () => {
    const { metrics: _m, seniority_signals: _s, scope_signals: _c, ...bare } = base;
    expect(unitEvidenceVersion(bare)).toBe(
      unitEvidenceVersion({ ...bare, metrics: [], seniority_signals: [], scope_signals: [] }),
    );
  });

  it("treats absent and empty tag arrays alike", () => {
    expect(unitEvidenceVersion(base)).toBe(
      unitEvidenceVersion({ ...base, skills: [], tools: [], domains: [] }),
    );
  });
});

describe("the ev3 golden (#485)", () => {
  const RICH = {
    id: "u-rich",
    raw_text: 'Led the "Atlas" migration; cut p95 latency 40%.',
    normalized_summary: "Led the Atlas migration, cutting p95 latency 40%.",
    metrics: [
      { claim: "Cut p95 latency 40%", value: 40, unit: "%", direction: "down", confidence: "high" },
    ],
    seniority_signals: ["led"],
    scope_signals: ["3 teams"],
    skills: ["latency tuning"],
    tools: ["Go", "Kafka"],
    domains: ["payments"],
    date_range: { start: "2020-01-01", end: "2022-06-30" },
    business_outcomes: ["faster checkout"],
  };

  it("pins the prefix", () => {
    expect(UNIT_EVIDENCE_VERSION_PREFIX).toBe("ev3:");
  });

  it("pins the digest of a Unit with every rendered field", () => {
    // Changing this golden requires a new UNIT_EVIDENCE_VERSION_PREFIX (#485).
    expect(unitEvidenceVersion(RICH)).toBe(
      "ev3:c4fd7c3731cdd463b41ed58913cab7d627f59cb041066f11b6944fe80afa837f",
    );
  });
});

describe("unitEvidenceVersion is the hash of the traceability prompt text", () => {
  it("equals SHA-256 of exactly what formatUnit renders, so it moves iff the validator's input moves", () => {
    expect(unitEvidenceVersion(base)).toBe(`ev3:${sha256Hex(formatUnit(base))}`);
  });
});
