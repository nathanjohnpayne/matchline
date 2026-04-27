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
  scoreUnitPair,
  tokenJaccard,
  tokenOverlapCoefficient,
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

// -- tokenOverlapCoefficient (#148) --

describe("tokenOverlapCoefficient", () => {
  it("returns 1.0 for identical sets", () => {
    expect(
      tokenOverlapCoefficient(new Set(["a", "b"]), new Set(["a", "b"])),
    ).toBeCloseTo(1.0);
  });

  it("returns 0 when either side is empty (mirror of tokenJaccard)", () => {
    expect(tokenOverlapCoefficient(new Set(), new Set(["a"]))).toBe(0);
    expect(tokenOverlapCoefficient(new Set(["a"]), new Set())).toBe(0);
    expect(tokenOverlapCoefficient(new Set(), new Set())).toBe(0);
  });

  it("uses min(|A|, |B|) as denominator (verbosity-resilient)", () => {
    // |A ∩ B| / min(|A|, |B|) = 2 / min(3, 5) = 2/3.
    // tokenJaccard on the same inputs would be 2 / 6 = 0.33 —
    // overlap-coefficient gives full credit when the smaller
    // set is fully contained in the larger one.
    expect(
      tokenOverlapCoefficient(
        new Set(["a", "b", "c"]),
        new Set(["b", "c", "d", "e", "f"]),
      ),
    ).toBeCloseTo(2 / 3);
  });

  it("returns 1.0 when one side is fully contained in the other (any size)", () => {
    // The motivation case: actual is verbose but contains
    // every expected token. Pre-#148 this scored
    // 3 / (3+10-3) = 0.30 under Jaccard; under overlap-coef
    // it scores 1.0 (perfect coverage of the smaller set).
    expect(
      tokenOverlapCoefficient(
        new Set(["led", "kepler", "launch"]),
        new Set([
          "led",
          "amazon",
          "kepler",
          "launch",
          "ground-up",
          "rewrite",
          "fire",
          "android",
          "stack",
          "linux",
        ]),
      ),
    ).toBe(1.0);
  });

  it("returns intersection size / smaller-set size, not size-asymmetric", () => {
    // Symmetric: order-independent.
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d", "e", "f"]);
    expect(tokenOverlapCoefficient(a, b)).toBe(
      tokenOverlapCoefficient(b, a),
    );
  });

  it("scores Kepler-shape inputs above 0.30 mapping threshold (#148 anchor)", () => {
    // Exact tokens from the live diagnostic on Nathan-2026 ×
    // Google-Compute-SPM. With the prior tokenJaccard, this
    // pair scored ~0.34 on the summary axis × 0.6 = 0.21 +
    // skills 0.4×low ≈ 0.25 — below the 0.30 threshold so
    // mapUnitIds left u_kepler unmapped despite being the
    // correct match. With overlap-coefficient the summary
    // contribution alone exceeds 0.5, well above threshold.
    const expected = tokenize(
      "Led Amazon Kepler launch — ground-up rewrite replacing Fire TV Android stack with native Linux-based OS",
    );
    const actual = tokenize(
      "Led the Amazon Kepler launch, a ground-up rewrite of Fire TV's Android stack to a native Linux-based OS, hitting the September 2025 announcement and shipping in October with zero negative impact to engagement metrics on Fire TV",
    );
    expect(tokenOverlapCoefficient(expected, actual)).toBeGreaterThan(0.6);
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

  // -- empty-token fallback (cursor on PR #158) --

  it("identical short-token summaries get full summary credit (mirror of unitSetAccuracy)", () => {
    // "AI ML" tokenizes to empty under the >2-char filter, so
    // `tokenOverlapCoefficient` returns 0. Without the
    // exact-match fallback that `unitSetAccuracy` already has,
    // mapping would leave an exact-match short-token pair as
    // `unmapped_<id>` while extraction-acc would give it full
    // summary credit — the two metrics would disagree on the
    // same input. Identical skills → score = 0.6 + 0.4 = 1.0.
    const e = makeExpectedUnit("u_ai", "AI ML", ["machine learning"]);
    const a = makeActualUnit("uuid-ai", "AI ML", ["machine learning"]);
    expect(scoreUnitPair(e, a)).toBe(1);
  });

  it("different short-token summaries that both tokenize empty score 0 on summary", () => {
    // Different content via the fallback's exact-equality
    // arm. With identical skills, score = 0*0.6 + 1*0.4 = 0.4.
    const e = makeExpectedUnit("u_ai", "AI ML", ["data science"]);
    const a = makeActualUnit("uuid-tv", "TV OS", ["data science"]);
    expect(scoreUnitPair(e, a)).toBeCloseTo(0.4, 6);
  });

  it("trims and lowercases before exact-equality (whitespace + case insensitive)", () => {
    // "  AI ML  " (extra whitespace) and "ai ML" (mixed case)
    // should still match the fallback path.
    const e = makeExpectedUnit("u_ai", "  AI ML  ", []);
    const a = makeActualUnit("uuid-ai", "ai ML", []);
    // Both tokenize to empty; exact equality on
    // trimmed-lowercase form holds → summary 1.0.
    // Skills both empty → tokenJaccard returns 0 (mapping's
    // empty-empty convention). Total = 1.0*0.6 + 0*0.4 = 0.6.
    expect(scoreUnitPair(e, a)).toBeCloseTo(0.6, 6);
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

  it("DETERMINISTIC TIE-BREAK (cursor #139 r2 + CR Major): when two actuals tie on score AND expectedIdx, lower actualIdx wins", () => {
    // Ties on (score, expectedIdx) previously fell back
    // to V8's Array input order, which itself depends on
    // the upstream extractor's Unit ordering. This pin
    // makes the eval result stable across extractor
    // ordering drift.
    const expected = [
      makeExpectedUnit("u_only", "Led launch", []),
    ];
    // Two actuals with identical normalized_summary and
    // skills → identical scoreUnitPair output → tied on
    // (score, expectedIdx). Greedy assignment must
    // deterministically pick the lower actualIdx.
    const actual = [
      makeActualUnit("uuid-first", "Led launch", []),
      makeActualUnit("uuid-second", "Led launch", []),
    ];
    const map = mapUnitIds(expected, actual);
    expect(map.get("uuid-first")).toBe("u_only");
    expect(map.get("uuid-second")).toBe("unmapped_uuid-second");
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
