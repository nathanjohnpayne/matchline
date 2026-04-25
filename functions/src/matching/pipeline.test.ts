import { describe, expect, it, vi } from "vitest";

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.ts";

import { runMatchingPipeline, type RunMatchingContext } from "./pipeline.ts";
import type { ScoreResult } from "./score.ts";

/**
 * DI-based pipeline tests. The Firestore boundary is replaced
 * via `listUnits`, `listRequirements`, and `persistBatch` deps;
 * the score function is replaced via the `score` dep so we
 * pin compositional behavior independent of the actual scoring
 * math (which is tested in score.test.ts at #97).
 *
 * Cross-tenant safety + transactional concurrency is exercised
 * end-to-end against the emulator in
 * `tests/matching-replace.integration.test.ts` (the integration
 * test wraps the real `replaceMatchesForRole`).
 */

const CTX: RunMatchingContext = { ownerUid: "user-alice", roleId: "role-1" };

function makeUnit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: "unit-1",
    owner_uid: "user-alice",
    source_type: "resume",
    source_ref: "ref",
    raw_text: "raw",
    normalized_summary: "summary",
    unit_type: "project",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: true,
    embedding: [1, 0, 0],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRequirement(
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  return {
    id: "req-1",
    owner_uid: "user-alice",
    role_id: "role-1",
    raw_text: "raw",
    normalized_requirement: "norm",
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "medium",
    must_have: false,
    extracted_from: "qualifications",
    embedding: [1, 0, 0],
    ...overrides,
  };
}

function makeScoreResult(final_score: number): ScoreResult {
  return {
    components: {
      semantic_similarity: 1,
      skill_overlap: 0,
      domain_overlap: 0,
      tool_overlap: 0,
      seniority_alignment: 0,
      scope_alignment: 0,
      recency: 0,
    },
    rule_score: final_score,
    semantic_score: 1,
    final_score,
  };
}

describe("runMatchingPipeline", () => {
  it("scores every (Unit × Requirement) pair, persists, and returns the matches", async () => {
    const unit1 = makeUnit({ id: "u1" });
    const unit2 = makeUnit({ id: "u2" });
    const req1 = makeRequirement({ id: "r1" });
    const req2 = makeRequirement({ id: "r2" });

    const score = vi.fn(() => makeScoreResult(0.8));
    const persistBatch = vi.fn(async () => {});
    const generateId = vi
      .fn()
      .mockReturnValueOnce("m1")
      .mockReturnValueOnce("m2")
      .mockReturnValueOnce("m3")
      .mockReturnValueOnce("m4");

    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [unit1, unit2],
      listRequirements: async () => [req1, req2],
      score,
      persistBatch,
      generateId,
      now: () => "2026-04-25T00:00:00.000Z",
    });

    // 2 Units × 2 Requirements = 4 matches.
    expect(result).toHaveLength(4);
    expect(score).toHaveBeenCalledTimes(4);
    // Each match stamped with the right keys.
    for (const m of result) {
      expect(m.owner_uid).toBe("user-alice");
      expect(m.role_id).toBe("role-1");
      expect(m.final_score).toBe(0.8);
      // Rationale + surface_evidence are populated by #100's
      // deterministic generator (wired via the default
      // `generateRationale` dep). Assert both non-empty rather
      // than pinning specific prose — the rationale.test.ts
      // surface owns that contract; here we just verify the
      // wire-in copied BOTH fields onto the persisted record
      // (a regression that wired only `rationale` would slip
      // past a single-field check; CodeRabbit Minor on PR #105).
      expect(m.rationale.length).toBeGreaterThan(0);
      expect(m.surface_evidence.length).toBeGreaterThan(0);
      expect(m.approved_for_use).toBe(false);
      expect(m.user_rejected).toBe(false);
      expect(m.created_at).toBe("2026-04-25T00:00:00.000Z");
    }
    // persistBatch called exactly once with the full match set
    // and the ctx — so the atomic-replace happens once per run.
    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(persistBatch).toHaveBeenCalledWith(CTX, expect.any(Array));
    expect(persistBatch.mock.calls[0]![1]).toHaveLength(4);
  });

  it("sorts matches high-to-low by final_score before persist", async () => {
    const unit1 = makeUnit({ id: "u1" });
    const unit2 = makeUnit({ id: "u2" });
    const req1 = makeRequirement({ id: "r1" });

    // Different scores per (unit, req) so we can pin the order.
    const score = vi
      .fn()
      .mockReturnValueOnce(makeScoreResult(0.3))
      .mockReturnValueOnce(makeScoreResult(0.9));
    const persistBatch = vi.fn(async () => {});

    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [unit1, unit2],
      listRequirements: async () => [req1],
      score,
      persistBatch,
    });

    expect(result.map((m) => m.final_score)).toEqual([0.9, 0.3]);
    // Persisted set is also sorted (so a UI that reads without
    // an orderBy clause still sees the right order).
    expect(persistBatch.mock.calls[0]![1].map((m) => m.final_score)).toEqual([
      0.9, 0.3,
    ]);
  });

  it("empty Units → empty match set; persistBatch STILL called to clear stale rows", async () => {
    // Mirrors the JD pipeline's empty-result clear semantics
    // (Codex P1 round 3 on #19). A user who rejects every Unit
    // and re-runs matching should see prior matches wiped.
    const persistBatch = vi.fn(async () => {});

    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [],
      listRequirements: async () => [makeRequirement()],
      persistBatch,
    });

    expect(result).toEqual([]);
    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(persistBatch).toHaveBeenCalledWith(CTX, []);
  });

  it("empty Requirements → empty match set; persistBatch STILL called", async () => {
    const persistBatch = vi.fn(async () => {});

    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [makeUnit()],
      listRequirements: async () => [],
      persistBatch,
    });

    expect(result).toEqual([]);
    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(persistBatch).toHaveBeenCalledWith(CTX, []);
  });

  it("both empty → still clears (atomic-replace covers the all-rejected case)", async () => {
    const persistBatch = vi.fn(async () => {});

    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [],
      listRequirements: async () => [],
      persistBatch,
    });

    expect(result).toEqual([]);
    expect(persistBatch).toHaveBeenCalledTimes(1);
  });

  it("skips Units with missing embeddings (upstream-pipeline bug, not fatal)", async () => {
    const unitWith = makeUnit({ id: "u1", embedding: [0.5, 0.5] });
    const unitWithout = makeUnit({ id: "u2", embedding: undefined });
    const req = makeRequirement();

    const score = vi.fn(() => makeScoreResult(0.5));
    const persistBatch = vi.fn(async () => {});

    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [unitWith, unitWithout],
      listRequirements: async () => [req],
      score,
      persistBatch,
    });

    // Only the Unit with an embedding produces a match.
    expect(result).toHaveLength(1);
    expect(result[0]!.experience_unit_id).toBe("u1");
    expect(score).toHaveBeenCalledTimes(1);
  });

  it("skips Requirements with missing embeddings", async () => {
    const reqWith = makeRequirement({ id: "r1", embedding: [0.5, 0.5] });
    const reqWithout = makeRequirement({ id: "r2", embedding: undefined });
    const unit = makeUnit();

    const score = vi.fn(() => makeScoreResult(0.5));

    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [unit],
      listRequirements: async () => [reqWith, reqWithout],
      score,
      persistBatch: async () => {},
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.job_requirement_unit_id).toBe("r1");
    expect(score).toHaveBeenCalledTimes(1);
  });

  it("skips empty-array embeddings (defensive against [] vs undefined)", async () => {
    // Firestore will sometimes round-trip `embedding: []` after
    // a bad write rather than `undefined`. Treat both the same.
    const unit = makeUnit({ embedding: [] });
    const req = makeRequirement({ embedding: [] });

    const score = vi.fn();
    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [unit],
      listRequirements: async () => [req],
      score,
      persistBatch: async () => {},
    });

    expect(result).toEqual([]);
    expect(score).not.toHaveBeenCalled();
  });

  it("generateRationale throws on a pair → that pair is skipped; pipeline does NOT abort the run (Codex P1 + CR Major round 1 on #105)", async () => {
    // Rationale-generation failures must be isolated per pair,
    // same as score() failures. A bad input or injected-dep
    // bug in generateRationale must not tear down the entire
    // matching run for the role.
    const u1 = makeUnit({ id: "u1" });
    const u2 = makeUnit({ id: "u2" });
    const r = makeRequirement({ id: "r1" });

    let rationaleCallCount = 0;
    const generateRationaleStub = vi.fn(() => {
      rationaleCallCount += 1;
      if (rationaleCallCount === 1) throw new Error("synthetic rationale failure");
      return {
        rationale: "ok",
        surface_evidence: "ok",
        driving_component: "semantic_similarity" as const,
      };
    });

    const persistBatch = vi.fn(async () => {});
    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [u1, u2],
      listRequirements: async () => [r],
      score: () => makeScoreResult(0.5),
      generateRationale: generateRationaleStub,
      persistBatch,
    });

    // The first pair (u1, r1) is skipped because rationale
    // generation threw. The second pair (u2, r1) succeeds.
    expect(result).toHaveLength(1);
    expect(result[0]!.experience_unit_id).toBe("u2");
    expect(persistBatch).toHaveBeenCalledTimes(1);
  });

  it("generateRationale throws on EVERY pair → wholesale-failure abort fires (no persistBatch)", async () => {
    // Same shape as the wholesale-scoring-failure test below,
    // but via generateRationale instead. Both code paths feed
    // into the same scoreFailures counter inside the per-pair
    // try/catch so the abort guard fires identically.
    const generateRationaleStub = vi.fn(() => {
      throw new Error("synthetic rationale failure on every pair");
    });
    const persistBatch = vi.fn(async () => {});

    await expect(
      runMatchingPipeline(CTX, {
        listUnits: async () => [makeUnit({ id: "u1" }), makeUnit({ id: "u2" })],
        listRequirements: async () => [makeRequirement({ id: "r1" })],
        score: () => makeScoreResult(0.5),
        generateRationale: generateRationaleStub,
        persistBatch,
      }),
    ).rejects.toThrow(/scoring or rationale generation threw on every candidate pair/);

    // Critical: persistBatch must NOT be called — prior matches
    // protected.
    expect(persistBatch).not.toHaveBeenCalled();
  });

  it("score throws on EVERY candidate pair → pipeline aborts, persistBatch NOT called (CodeRabbit Critical #1)", async () => {
    // Wholesale-scoring-failure guard: if every candidate pair
    // throws, the empty match set isn't a real "no matches" —
    // it's a scoring bug. Aborting before persistBatch protects
    // prior valid matches from being wiped by a bad deploy.
    const score = vi.fn(() => {
      throw new Error("synthetic universal scoring failure");
    });
    const persistBatch = vi.fn(async () => {});

    await expect(
      runMatchingPipeline(CTX, {
        listUnits: async () => [makeUnit({ id: "u1" }), makeUnit({ id: "u2" })],
        listRequirements: async () => [
          makeRequirement({ id: "r1" }),
          makeRequirement({ id: "r2" }),
        ],
        score,
        persistBatch,
      }),
    ).rejects.toThrow(/scoring or rationale generation threw on every candidate pair/);

    // Critical: persistBatch must NOT be called. If it were,
    // we'd have wiped prior matches.
    expect(persistBatch).not.toHaveBeenCalled();
    // All 4 pairs were attempted before the wholesale-failure
    // detection.
    expect(score).toHaveBeenCalledTimes(4);
  });

  it("score throws on SOME pairs → those are skipped; persistBatch DOES run (partial-failure stays partial)", async () => {
    // The wholesale-failure guard only fires if EVERY pair
    // fails. A partial-failure run with some surviving matches
    // still persists those matches.
    const u1 = makeUnit({ id: "u1" });
    const u2 = makeUnit({ id: "u2" });
    const r = makeRequirement({ id: "r1" });

    const score = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("synthetic score failure");
      })
      .mockImplementationOnce(() => makeScoreResult(0.7));

    const persistBatch = vi.fn(async () => {});
    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [u1, u2],
      listRequirements: async () => [r],
      score,
      persistBatch,
    });

    // 1 match survived; pipeline does NOT throw.
    expect(result).toHaveLength(1);
    expect(result[0]!.experience_unit_id).toBe("u2");
    expect(persistBatch).toHaveBeenCalledTimes(1);
  });

  it("zero candidate pairs (no embeddings on either side) → persistBatch DOES run; clearing stale rows is correct here", async () => {
    // candidatePairs=0 case: no pair was even attempted, so
    // there's no scoring-failure signal. This is the
    // legitimate "all rejected" / "no embeddings yet" case
    // and the empty-result clear semantics ARE correct.
    const score = vi.fn();
    const persistBatch = vi.fn(async () => {});
    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [makeUnit({ embedding: undefined })],
      listRequirements: async () => [makeRequirement({ embedding: undefined })],
      score,
      persistBatch,
    });

    expect(result).toEqual([]);
    expect(score).not.toHaveBeenCalled();
    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(persistBatch).toHaveBeenCalledWith(CTX, []);
  });

  it("score throws → pair skipped; pipeline does NOT abort the whole run (legacy partial-failure check)", async () => {
    // Defense-in-depth: if a single (unit, req) pair throws
    // (corrupt input, etc.), the surrounding pairs still
    // produce matches. This is the right call for V1 because
    // a single bad pair shouldn't lose the entire match set
    // for a Role; the missing match surfaces in the Gaps view
    // instead.
    const u1 = makeUnit({ id: "u1" });
    const u2 = makeUnit({ id: "u2" });
    const r = makeRequirement({ id: "r1" });

    const score = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("synthetic score failure");
      })
      .mockImplementationOnce(() => makeScoreResult(0.7));

    const result = await runMatchingPipeline(CTX, {
      listUnits: async () => [u1, u2],
      listRequirements: async () => [r],
      score,
      persistBatch: async () => {},
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.experience_unit_id).toBe("u2");
  });

  it("persistBatch failure propagates to the caller (atomic-replace must not silently swallow)", async () => {
    const score = vi.fn(() => makeScoreResult(0.5));
    const persistBatch = vi.fn(async () => {
      throw new Error("Firestore transaction aborted");
    });

    await expect(
      runMatchingPipeline(CTX, {
        listUnits: async () => [makeUnit()],
        listRequirements: async () => [makeRequirement()],
        score,
        persistBatch,
      }),
    ).rejects.toThrow(/Firestore transaction aborted/);
  });

  it("stamps role_id on every persisted match (denormalization invariant)", async () => {
    // Pin: every match doc has role_id === ctx.roleId. A
    // missing or wrong role_id would break listMatchesByRole
    // (the Matches-tab read query) and the atomic-replace
    // clear (which keys on (owner, role_id)).
    const persistBatch = vi.fn(async () => {});
    await runMatchingPipeline(CTX, {
      listUnits: async () => [makeUnit({ id: "u1" }), makeUnit({ id: "u2" })],
      listRequirements: async () => [
        makeRequirement({ id: "r1" }),
        makeRequirement({ id: "r2" }),
      ],
      score: () => makeScoreResult(0.5),
      persistBatch,
    });

    const persisted = persistBatch.mock.calls[0]![1] as UnitMatch[];
    expect(persisted).toHaveLength(4);
    for (const m of persisted) {
      expect(m.role_id).toBe("role-1");
      expect(m.owner_uid).toBe("user-alice");
    }
  });

  it("passes options.asOf through to the score function (deterministic recency in tests)", async () => {
    const asOf = new Date("2025-06-01T00:00:00.000Z");
    const score = vi.fn(() => makeScoreResult(1));
    await runMatchingPipeline(CTX, {
      listUnits: async () => [makeUnit()],
      listRequirements: async () => [makeRequirement()],
      score,
      persistBatch: async () => {},
      asOf,
    });
    expect(score).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      { asOf },
    );
  });

  it("listUnits + listRequirements run in parallel (Promise.all)", async () => {
    // Pin: the two reads are concurrent. A serial implementation
    // would double the worst-case latency on the matching call,
    // and #99's perf budget (10×20 in <2s) assumes parallel reads.
    const order: string[] = [];
    const listUnits = vi.fn(async () => {
      order.push("units-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("units-end");
      return [makeUnit()];
    });
    const listRequirements = vi.fn(async () => {
      order.push("reqs-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("reqs-end");
      return [makeRequirement()];
    });

    await runMatchingPipeline(CTX, {
      listUnits,
      listRequirements,
      score: () => makeScoreResult(0.5),
      persistBatch: async () => {},
    });

    // Both reads start before either ends → parallel execution.
    expect(order.indexOf("units-start")).toBeLessThan(
      order.indexOf("reqs-end"),
    );
    expect(order.indexOf("reqs-start")).toBeLessThan(
      order.indexOf("units-end"),
    );
  });
});
