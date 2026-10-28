import { describe, expect, it } from "vitest";

import type { FlowRecord } from "../flowRecord.ts";
import { unitSetAccuracy } from "../scoring.ts";

import {
  extractionMetrics,
  groundingShare,
  jdMetrics,
  mustHaveAgreement,
  requirementAssignment,
  requirementMapping,
  requirementPrecision,
  summaryTokenLength,
  unitAssignment,
  unitMapping,
  unitPrecision,
} from "./metrics.ts";
import { mulberry32 } from "./stats.ts";

const WORDS = ["led", "platform", "launch", "streaming", "partner", "billing", "migration", "kepler", "android", "ai", "ml", "revenue"];
const SKILLS = ["platform launch", "roadmapping", "pricing", "ml ops", "partnerships"];

function randomUnits(rng: () => number, n: number): { normalizedSummary: string; skills: string[] }[] {
  return Array.from({ length: n }, () => ({
    normalizedSummary: Array.from({ length: 1 + Math.floor(rng() * 6) }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(" "),
    skills: SKILLS.filter(() => rng() < 0.35),
  }));
}

describe("unitAssignment", () => {
  it("equals unitSetAccuracy on randomized inputs (seeded)", () => {
    const rng = mulberry32(99);
    for (let trial = 0; trial < 300; trial++) {
      const expected = randomUnits(rng, Math.floor(rng() * 6));
      const actual = randomUnits(rng, Math.floor(rng() * 7));
      expect(unitAssignment(expected, actual).mean).toBe(unitSetAccuracy(expected, actual));
    }
  });

  it("pairs one-to-one, ties to the lowest index", () => {
    const e = [{ normalizedSummary: "led kepler launch", skills: [] }];
    const a = [
      { normalizedSummary: "led kepler launch", skills: [] },
      { normalizedSummary: "led kepler launch", skills: [] },
    ];
    expect(unitAssignment(e, a).pairs).toEqual([{ expectedIndex: 0, actualIndex: 0, score: 1 }]);
  });

  it("precision counts extracted Units claimed at >= 0.5", () => {
    const e = [
      { normalizedSummary: "led kepler launch", skills: ["a"] },
      { normalizedSummary: "grew billing revenue", skills: ["b"] },
    ];
    const a = [
      { normalizedSummary: "led kepler launch", skills: ["a"] }, // 1.0
      { normalizedSummary: "billing", skills: ["z"] }, // 0.6 × 1 + 0.4 × 0 = 0.6
      { normalizedSummary: "unrelated thing entirely", skills: [] },
    ];
    const asg = unitMapping(e, a);
    expect(unitPrecision(asg, a.length)).toBeCloseTo(2 / 3, 12);
    const weak = unitMapping([{ normalizedSummary: "billing", skills: ["b"] }], [{ normalizedSummary: "billing other words here", skills: [] }]);
    // 0.6 × 1 (overlap coefficient) + 0.4 × 0 = 0.6 ≥ 0.5.
    expect(unitPrecision(weak, 1)).toBe(1);
    const below = unitMapping([{ normalizedSummary: "billing revenue growth", skills: ["b"] }], [{ normalizedSummary: "billing other words", skills: [] }]);
    // overlap 1/3 → 0.2 < 0.5.
    expect(unitPrecision(below, 1)).toBe(0);
    expect(unitPrecision(asg, 0)).toBeNull();
  });
});

describe("threshold-first mapping", () => {
  it("lets a later expected Unit at >= 0.5 keep an extracted Unit an earlier one scores below it", () => {
    const e = [
      { normalizedSummary: "alpha beta gamma delta", skills: [] }, // vs a: 0.6 × 1/3 = 0.2
      { normalizedSummary: "kepler launch", skills: ["x"] }, // vs a: 0.6 × 1 + 0.4 × 1 = 1
    ];
    const a = [{ normalizedSummary: "alpha kepler launch", skills: ["x"] }];
    // The expected-order assignment gives `a` to e[0] at 0.2, so nothing clears 0.5.
    expect(unitAssignment(e, a).pairs).toEqual([{ expectedIndex: 0, actualIndex: 0, score: expect.closeTo(0.2, 12) }]);
    expect(unitPrecision(unitAssignment(e, a), 1)).toBe(0);
    expect(unitMapping(e, a).pairs).toEqual([{ expectedIndex: 1, actualIndex: 0, score: 1 }]);
    expect(unitPrecision(unitMapping(e, a), 1)).toBe(1);
  });

  it("maps e2 to a1 at 0.5 when e1 scores a1 at 0.25 (requirements)", () => {
    const expected = [
      { text: "docker alpha beta gamma", must_have: true }, // vs a1: 1/4
      { text: "kubernetes cloud", must_have: false }, // vs a1: 1/2
    ];
    const actual = [{ normalizedRequirement: "kubernetes experience docker operations", mustHave: false }];
    const ordered = requirementAssignment(expected, actual);
    expect(ordered.pairs.map((p) => [p.expectedIndex, p.actualIndex, p.score])).toEqual([[0, 0, 0.25]]);
    expect(requirementPrecision(ordered, 1)).toBe(0);
    expect(mustHaveAgreement(expected, actual, ordered)).toBeNull();
    const mapped = requirementMapping(expected, actual);
    expect(mapped.pairs.map((p) => [p.expectedIndex, p.actualIndex, p.score])).toEqual([[1, 0, 0.5]]);
    expect(requirementPrecision(mapped, 1)).toBe(1);
    expect(mustHaveAgreement(expected, actual, mapped)).toBe(1);
  });

  it("breaks score ties by expected index, then actual index", () => {
    const expected = [{ text: "kubernetes" }, { text: "kubernetes" }];
    const actual = [{ normalizedRequirement: "kubernetes" }, { normalizedRequirement: "kubernetes" }];
    expect(requirementMapping(expected, actual).pairs.map((p) => [p.expectedIndex, p.actualIndex])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("summaryTokenLength / groundingShare", () => {
  it("counts whitespace-delimited words", () => {
    expect(summaryTokenLength("  Led the   Kepler launch ")).toBe(4);
    expect(summaryTokenLength("")).toBe(0);
  });

  it("grounds a Unit only within a single résumé line, at word boundaries", () => {
    const resume = "- **Led** the Kepler launch\nControlled the budget\nShipped v2\nto twelve teams";
    expect(groundingShare(["led the kepler launch"], resume)).toBe(1); // marker, emphasis, case ignored
    expect(groundingShare(["Led"], "Controlled the budget")).toBe(0); // not inside "Controlled"
    expect(groundingShare(["Shipped v2 to twelve teams"], resume)).toBe(0); // stitched across lines
    expect(groundingShare(["Shipped v2", "Invented"], resume)).toBe(0.5);
    expect(groundingShare([], resume)).toBeNull();
  });
});

describe("requirement metrics", () => {
  const expected = [
    { text: "8 years product management experience", must_have: true },
    { text: "Kubernetes and cloud infrastructure", must_have: false },
    { text: "MBA preferred", must_have: false },
  ];
  const actual = [
    { normalizedRequirement: "Experience with Kubernetes", mustHave: true }, // vs expected[1]
    { normalizedRequirement: "8 years of product management experience", mustHave: true }, // vs expected[0]
    { normalizedRequirement: "Excellent communication", mustHave: false },
  ];

  it("assigns greedily, one-to-one, in label order", () => {
    const asg = requirementAssignment(expected, actual);
    expect(asg.pairs.map((p) => [p.expectedIndex, p.actualIndex])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    // 1 (full overlap) + 1/3 ("kubernetes" shared; min(4, 3) tokens) + 0, over 3.
    expect(asg.mean).toBeCloseTo((1 + 1 / 3 + 0) / 3, 12);
    expect(requirementAssignment([], []).mean).toBe(1);
    expect(requirementAssignment([], actual).mean).toBe(0);
  });

  it("agreement and precision use pairs mapped at >= 0.3", () => {
    const asg = requirementMapping(expected, actual);
    // Pair (0,1) agrees (true/true); pair (1,0) disagrees (false/true).
    expect(mustHaveAgreement(expected, actual, asg)).toBe(0.5);
    expect(requirementPrecision(asg, actual.length)).toBeCloseTo(2 / 3, 12);
    expect(requirementPrecision(asg, 0)).toBeNull();
    expect(mustHaveAgreement(expected, actual, { mean: 0, pairs: [] })).toBeNull();
  });
});

function flow(over: Partial<FlowRecord>): FlowRecord {
  return {
    schemaVersion: 1,
    invocationId: "i",
    variant: "v",
    stages: {},
    embeddingModel: "e",
    resumeId: "r",
    jdId: "j",
    cell: "r__j",
    sampleIndex: 0,
    startedAt: "",
    finishedAt: "",
    latencyMs: 0,
    ok: true,
    error: null,
    extractionAccuracy: 0.5,
    matchAccuracy: 0.25,
    extractedUnitCount: 0,
    parsedRequirementCount: 0,
    parsedMustHaveCount: 0,
    matchCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    stepCacheHits: {},
    calls: [],
    failures: null,
    units: [],
    requirements: [],
    costUsd: 0,
    modeledCostUsd: 0,
    ...over,
  };
}

describe("flow metric sets", () => {
  it("scores extraction from the saved Units", () => {
    const m = extractionMetrics(
      flow({
        units: [
          { raw_text: "Led the Kepler launch", normalized_summary: "led kepler launch", skills: ["a"] },
          { raw_text: "Made it up", normalized_summary: "made up thing", skills: [] },
        ],
      }),
      { expectedUnits: [{ id: "u1", normalized_summary: "led kepler launch", skills: ["a"] }], resumeText: "- Led the Kepler launch" },
    );
    expect(m).toEqual({
      extraction_accuracy: 1,
      unit_precision: 0.5,
      extracted_unit_count: 2,
      summary_tokens: 3,
      grounding_share: 0.5,
      match_accuracy: 0.25,
    });
  });

  it("scores JD parsing from the saved Requirements", () => {
    const m = jdMetrics(
      flow({
        requirements: [
          { normalized_requirement: "8 years product management", must_have: true },
          { normalized_requirement: "something else", must_have: false },
        ],
      }),
      { expectedRequirements: [{ id: "r1", text: "8 years product management", must_have: true, category: "experience" }] },
    );
    expect(m).toEqual({
      requirement_set_accuracy: 1,
      must_have_agreement: 1,
      requirement_precision: 0.5,
      parsed_requirement_count: 2,
      parsed_must_have_count: 1,
      match_accuracy: 0.25,
    });
  });
});
