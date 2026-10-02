import { describe, expect, it } from "vitest";

import { unitEvidenceVersion, type UnitEvidenceFields } from "./unitEvidenceVersion.ts";

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
    expect(unitEvidenceVersion(base)).toMatch(/^ev2:[0-9a-f]{64}$/);
  });

  it("distinguishes an absent metric value from NaN and ±Infinity", () => {
    const withValue = (value: number | undefined) =>
      unitEvidenceVersion({ ...base, metrics: [{ claim: "Grew revenue", value, unit: "%", direction: "up" }] });
    const versions = [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(withValue);
    expect(new Set(versions).size).toBe(4);
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
    ];
    for (const edit of edits) {
      expect(unitEvidenceVersion({ ...base, ...edit }), JSON.stringify(edit)).not.toBe(v);
    }
  });

  it("ignores fields the validator does not read", () => {
    const withExtras = {
      ...base,
      updated_at: "2026-05-01T00:00:00.000Z",
      skills: ["go"],
      user_approved: false,
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
});
