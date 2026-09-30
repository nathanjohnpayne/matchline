import { describe, expect, it } from "vitest";

import {
  fnv1a64,
  unitEvidenceVersion,
  type UnitEvidenceFields,
} from "./unitEvidenceVersion.ts";

/** Straightforward BigInt FNV-1a 64, the reference the limb version must match. */
function referenceFnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

describe("fnv1a64", () => {
  it("matches the published FNV-1a 64 test vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });

  it("matches a BigInt reference on long, non-ASCII input", () => {
    for (const text of ["Led a team — 40% ↑", "x".repeat(5000), JSON.stringify(["ab", "c"])]) {
      expect(fnv1a64(text)).toBe(referenceFnv1a64(text));
    }
  });
});

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
    expect(unitEvidenceVersion(base)).toMatch(/^ev1:[0-9a-f]{16}$/);
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
