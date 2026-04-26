/**
 * Pure-helper tests for the runtime-UUID → mnemonic-ID
 * mapping logic (#136). The mapping is the bridge between
 * the production matching pipeline (random UUIDs) and the
 * fixture labels (stable mnemonics) — bugs here corrupt
 * scoring silently in either direction (premature
 * "unmapped" → false misses; promiscuous matching → false
 * hits).
 */

import { describe, expect, it } from "vitest";

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../functions/src/types/capability.ts";

import type {
  ExpectedRequirement,
  ExpectedUnit,
} from "./loadFixtures.ts";

import {
  DEFAULT_MAPPING_THRESHOLD,
  compositeIdsFromMatches,
  mapRequirementIds,
  mapUnitIds,
  scoreRequirementPair,
  scoreUnitPair,
  tokenJaccard,
  tokenize,
} from "./mapping.ts";

// -- tokenize / tokenJaccard --

describe("tokenize", () => {
  it("lowercases, strips punctuation, drops short tokens", () => {
    const tokens = tokenize("Led NCP migration on Disney+, cutting memory 30%!");
    // "led" (=3) makes it through. "on" (=2) does not.
    expect(tokens.has("led")).toBe(true);
    expect(tokens.has("ncp")).toBe(true);
    expect(tokens.has("migration")).toBe(true);
    expect(tokens.has("disney")).toBe(true);
    expect(tokens.has("on")).toBe(false);
  });

  it("handles empty string", () => {
    expect(tokenize("").size).toBe(0);
  });

  it("handles all-punctuation", () => {
    expect(tokenize("!!! ???").size).toBe(0);
  });
});

describe("tokenJaccard", () => {
  it("returns 1.0 for identical sets", () => {
    expect(tokenJaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBeCloseTo(1.0);
  });

  it("returns 0 when either side is empty", () => {
    // Different from the matching engine's empty-vs-empty=1
    // convention. See mapping.ts module docstring.
    expect(tokenJaccard(new Set(), new Set(["a"]))).toBe(0);
    expect(tokenJaccard(new Set(["a"]), new Set())).toBe(0);
    expect(tokenJaccard(new Set(), new Set())).toBe(0);
  });

  it("returns intersection / union", () => {
    expect(
      tokenJaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"])),
    ).toBeCloseTo(2 / 4); // {b,c} / {a,b,c,d}
  });
});

// -- scoreUnitPair --

const ALICE = "user-alice";

function makeExpectedUnit(
  id: string,
  summary: string,
  skills: readonly string[] = [],
): ExpectedUnit {
  return {
    id,
    normalized_summary: summary,
    skills,
  };
}

function makeActualUnit(
  id: string,
  summary: string,
  skills: readonly string[] = [],
): ExperienceUnit {
  return {
    id,
    owner_uid: ALICE,
    source_type: "resume",
    source_ref: "ref",
    raw_text: summary,
    normalized_summary: summary,
    unit_type: "project",
    skills: skills.slice(),
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("scoreUnitPair", () => {
  it("identical Units score 1.0", () => {
    const e = makeExpectedUnit("u_a", "Led Disney+ launch", [
      "platform launch",
    ]);
    const a = makeActualUnit("uuid-a", "Led Disney+ launch", [
      "platform launch",
    ]);
    expect(scoreUnitPair(e, a)).toBeCloseTo(1.0);
  });

  it("paraphrase scores partially (LLM rewrites are typical)", () => {
    const e = makeExpectedUnit("u_a", "Led Amazon Kepler launch on Fire TV", [
      "partner launch",
    ]);
    const a = makeActualUnit(
      "uuid-a",
      "Drove Kepler launch for Amazon Fire TV from concept",
      ["device certification"],
    );
    const s = scoreUnitPair(e, a);
    // Some token overlap on "kepler", "launch", "amazon",
    // "fire" — should be > 0 but well below 1.
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it("wholly unrelated Units score near 0", () => {
    const e = makeExpectedUnit("u_a", "Led Disney+ launch", [
      "platform launch",
    ]);
    const a = makeActualUnit(
      "uuid-a",
      "Wrote Python ETL for accounting reconciliation",
      ["python"],
    );
    expect(scoreUnitPair(e, a)).toBeLessThan(0.1);
  });
});

// -- mapUnitIds --

describe("mapUnitIds", () => {
  it("maps each actual Unit to its closest expected by content", () => {
    const expected = [
      makeExpectedUnit("u_kepler", "Led Amazon Kepler launch on Fire TV", [
        "partner launch",
      ]),
      makeExpectedUnit("u_disney", "Brought Disney+ to launch on devices", [
        "0-to-1 launch",
      ]),
    ];
    const actual = [
      makeActualUnit(
        "uuid-disney",
        "Brought Disney+ from concept to launch on connected devices",
        ["0-to-1 launch"],
      ),
      makeActualUnit(
        "uuid-kepler",
        "Led Amazon Kepler launch replacing Fire TV stack",
        ["partner launch"],
      ),
    ];
    const map = mapUnitIds(expected, actual);
    expect(map.get("uuid-kepler")).toBe("u_kepler");
    expect(map.get("uuid-disney")).toBe("u_disney");
  });

  it("unmapped actuals get `unmapped_<id>` mnemonic", () => {
    const expected = [
      makeExpectedUnit("u_kepler", "Led Amazon Kepler launch", []),
    ];
    const actual = [
      makeActualUnit("uuid-orphan", "Wrote SAP HANA throughput optimization", [
        "database",
      ]),
    ];
    const map = mapUnitIds(expected, actual);
    expect(map.get("uuid-orphan")).toBe("unmapped_uuid-orphan");
  });

  it("greedy: each expected is claimed at most once", () => {
    const expected = [
      makeExpectedUnit("u_only", "Led Amazon Kepler launch", ["launch"]),
    ];
    const actual = [
      makeActualUnit("uuid-strong", "Led Amazon Kepler launch perfectly", [
        "launch",
      ]),
      makeActualUnit("uuid-weaker", "Led Amazon Kepler launch", []),
    ];
    const map = mapUnitIds(expected, actual);
    // Strong wins; weaker → unmapped.
    expect(map.get("uuid-strong")).toBe("u_only");
    expect(map.get("uuid-weaker")).toBe("unmapped_uuid-weaker");
  });

  it("respects threshold — below-threshold pairs don't map", () => {
    const expected = [
      makeExpectedUnit("u_kepler", "Led Amazon Kepler launch", ["launch"]),
    ];
    const actual = [
      makeActualUnit("uuid-weak", "Did some work", []),
    ];
    // Default threshold (0.30): "did some work" doesn't
    // overlap meaningfully with "led amazon kepler launch."
    const map = mapUnitIds(expected, actual);
    expect(map.get("uuid-weak")).toBe("unmapped_uuid-weak");
  });

  it("threshold is overridable", () => {
    const expected = [
      makeExpectedUnit("u_a", "Aaaa bbbb", []),
    ];
    const actual = [
      makeActualUnit("uuid-a", "Aaaa cccc", []),
    ];
    // Token overlap: aaaa shared. Jaccard = 1/3 = 0.33.
    // Skills both empty → 0 (per tokenJaccard's empty-set
    // convention). Composite: 0.33 * 0.6 + 0 * 0.4 = 0.20.
    expect(mapUnitIds(expected, actual, 0.5).get("uuid-a")).toBe(
      "unmapped_uuid-a",
    );
    // At threshold 0.15, the 0.20 score crosses.
    expect(mapUnitIds(expected, actual, 0.15).get("uuid-a")).toBe("u_a");
  });
});

// -- mapRequirementIds --

function makeExpectedReq(id: string, text: string): ExpectedRequirement {
  return {
    id,
    text,
    must_have: false,
    category: "skill",
  };
}

function makeActualReq(
  id: string,
  normalized: string,
): JobRequirementUnit {
  return {
    id,
    owner_uid: ALICE,
    role_id: "role-1",
    raw_text: normalized,
    normalized_requirement: normalized,
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "medium",
    must_have: false,
    extracted_from: "qualifications",
  };
}

describe("mapRequirementIds", () => {
  it("maps requirements by text similarity", () => {
    const expected = [
      makeExpectedReq("r_8yr_pm", "8 years of product management experience"),
      makeExpectedReq("r_cloud", "experience with cloud, compute, SaaS"),
    ];
    const actual = [
      makeActualReq(
        "uuid-cloud",
        "Working with cloud, compute, SaaS or enterprise technologies",
      ),
      makeActualReq("uuid-8yr", "8 years experience in product management"),
    ];
    const map = mapRequirementIds(expected, actual);
    expect(map.get("uuid-8yr")).toBe("r_8yr_pm");
    expect(map.get("uuid-cloud")).toBe("r_cloud");
  });

  it("unmapped requirements get `unmapped_<id>`", () => {
    const expected = [makeExpectedReq("r_a", "Knowledge of Kubernetes")];
    const actual = [makeActualReq("uuid-orphan", "Strong written communication")];
    const map = mapRequirementIds(expected, actual);
    expect(map.get("uuid-orphan")).toBe("unmapped_uuid-orphan");
  });
});

// -- compositeIdsFromMatches --

function makeMatch(
  id: string,
  expUnitId: string,
  reqId: string,
  finalScore: number,
): UnitMatch {
  return {
    id,
    owner_uid: ALICE,
    role_id: "role-1",
    experience_unit_id: expUnitId,
    job_requirement_unit_id: reqId,
    semantic_score: finalScore,
    rule_score: finalScore,
    final_score: finalScore,
    rationale: "",
    surface_evidence: "",
    approved_for_use: false,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("compositeIdsFromMatches", () => {
  it("translates runtime UUIDs into mnemonic composite strings, sorted by final_score desc", () => {
    const matches = [
      makeMatch("m1", "uuid-kepler", "uuid-r1", 0.5),
      makeMatch("m2", "uuid-disney", "uuid-r1", 0.9),
      makeMatch("m3", "uuid-kepler", "uuid-r2", 0.7),
    ];
    const unitMap = new Map([
      ["uuid-kepler", "u_kepler"],
      ["uuid-disney", "u_disney"],
    ]);
    const reqMap = new Map([
      ["uuid-r1", "r_one"],
      ["uuid-r2", "r_two"],
    ]);
    const composite = compositeIdsFromMatches(matches, unitMap, reqMap);
    expect(composite).toEqual([
      "u_disney:r_one", // 0.9
      "u_kepler:r_two", // 0.7
      "u_kepler:r_one", // 0.5
    ]);
  });

  it("maps unmapped runtime UUIDs to `unmapped_<id>` so they cannot match expected_top_matches", () => {
    const matches = [makeMatch("m1", "uuid-orphan", "uuid-rorphan", 0.5)];
    // Empty maps — neither side mapped.
    const composite = compositeIdsFromMatches(matches, new Map(), new Map());
    expect(composite).toEqual(["unmapped_uuid-orphan:unmapped_uuid-rorphan"]);
  });
});

describe("DEFAULT_MAPPING_THRESHOLD", () => {
  it("is in the documented permissive-but-not-promiscuous range", () => {
    // Pin against drift. 0.30 is small enough that LLM
    // paraphrases map correctly, large enough that
    // wholly-unrelated content stays unmapped.
    expect(DEFAULT_MAPPING_THRESHOLD).toBe(0.3);
  });
});
