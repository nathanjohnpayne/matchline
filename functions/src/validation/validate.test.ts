import { describe, expect, it, vi } from "vitest";

import type { ExperienceUnit } from "../types/capability.ts";
import type {
  AssetRef,
  GeneratedAssetContent,
  ValidationFlag,
} from "../types/crm.ts";

import type { Claim } from "./claimExtraction.ts";
import type { SpecificityResult } from "./specificity.ts";
import type { TraceabilityResult } from "./traceability.ts";
import {
  validateAsset,
  ValidateAssetMissingContent,
  ValidateAssetNotFound,
  ValidateAssetStale,
  type ValidateAssetContext,
} from "./validate.ts";

/**
 * DI-based orchestrator tests. The Firestore boundary +
 * per-claim LLM calls are replaced via deps; the orchestrator's
 * composition logic is what's pinned.
 *
 * Coverage:
 *   - Happy path: 1 bullet → 1 claim → traceability passes →
 *     specificity passes → `traced` flag, status=`passed`.
 *   - **Adversarial fixture**: a bullet whose extracted claims
 *     don't trace produces `untraceable` flags + status=`failed`.
 *     Pin the load-bearing zero-fab invariant.
 *   - **Specificity short-circuit**: a claim that's untraceable
 *     does NOT have specificity checked (cost optimization +
 *     correctness — fabricated claims' specificity is moot).
 *   - **No auto-regeneration**: failures surface as flags; the
 *     orchestrator does not invoke generation again. Pinned by
 *     verifying no extra dep is called.
 *   - **Cross-tenant safety**: another user's assetId →
 *     ValidateAssetNotFound (the default loader's check; mirror
 *     the persist-side check via integration test).
 *   - Empty-bullets edge: empty `text` → bullet skipped, no
 *     claim extraction call.
 *   - Per-bullet flag aggregation: 2 bullets × 2 claims each =
 *     4 flags total.
 *   - persistFlags called once with the full result.
 *   - validation_status: passed / failed semantics.
 *   - Unit-loading dedup: shared source_unit_ids across bullets
 *     produce a single Unit-load call.
 *   - Asset content with bullet whose source_unit_ids reference
 *     a Unit not returned by loadUnits → traceability gets
 *     fewer candidate Units (the missing Unit is silently
 *     filtered).
 */

const CTX: ValidateAssetContext = {
  ownerUid: "user-alice",
  applicationId: "app-1",
  assetId: "asset-1",
};

function makeBullet(
  id: string,
  text: string,
  source_unit_ids: string[] = [],
) {
  return { id, text, source_unit_ids };
}

function makeContent(
  bullets: Array<ReturnType<typeof makeBullet>>,
  summaryOverride?: { id?: string; text?: string; source_unit_ids?: string[] },
): GeneratedAssetContent {
  return {
    summary: {
      id: summaryOverride?.id ?? "summary-1",
      // Default summary is empty so the orchestrator's empty-
      // bullet skip path skips it (no extra LLM calls in tests
      // that don't care about summary). Tests that exercise
      // summary validation pass an explicit summaryOverride.
      text: summaryOverride?.text ?? "",
      source_unit_ids: summaryOverride?.source_unit_ids ?? [],
    },
    experience: [
      {
        title: "Senior PM",
        company: "Disney",
        bullets,
      },
    ],
    skills: [],
  };
}

function makeAsset(
  content: GeneratedAssetContent,
  overrides: Partial<AssetRef> = {},
): AssetRef {
  return {
    id: "asset-1",
    owner_uid: "user-alice",
    application_id: "app-1",
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: content,
    validation_status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeUnit(id: string, overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id,
    owner_uid: "user-alice",
    source_type: "resume",
    source_ref: "ref",
    raw_text: `Unit ${id} raw text`,
    normalized_summary: `Unit ${id} summary`,
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeClaim(id: string, bulletId: string, text: string): Claim {
  return { id, bullet_id: bulletId, text };
}

function fakeTraceSupports(unitId: string): TraceabilityResult {
  return {
    supports: true,
    supporting_unit_id: unitId,
    rationale: `Unit ${unitId} supports the claim.`,
  };
}
const FAKE_TRACE_NO_SUPPORT: TraceabilityResult = {
  supports: false,
  rationale: "No Unit supports the claim.",
};
const FAKE_SPEC_OK: SpecificityResult = {
  specific: true,
  rationale: "Claim is verifiable.",
};
const FAKE_SPEC_VAGUE: SpecificityResult = {
  specific: false,
  rationale: "Claim is too vague.",
};

describe("validateAsset orchestrator", () => {
  it("happy path: 1 bullet → 1 claim → traceability + specificity pass → traced flag, status=passed", async () => {
    const content = makeContent([
      makeBullet("b1", "The user did a thing.", ["u1"]),
    ]);
    const asset = makeAsset(content);

    const extractClaims = vi.fn(async () => [fakeClaim("c1", "b1", "x")]);
    const checkTraceability = vi.fn(async () => fakeTraceSupports("u1"));
    const checkSpecificity = vi.fn(async () => FAKE_SPEC_OK);
    const persistFlags = vi.fn(async () => {});

    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset, content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims,
      checkTraceability,
      checkSpecificity,
      persistFlags,
      generateId: () => "f1",
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.status).toBe("passed");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]!.status).toBe("traced");
    expect(result.flags[0]!.supporting_unit_id).toBe("u1");
    expect(persistFlags).toHaveBeenCalledTimes(1);
  });

  it("ADVERSARIAL: untraceable claim → untraceable flag + status=failed (load-bearing zero-fab pin)", async () => {
    // The product-defining test for the validation layer. A
    // bullet whose claims don't trace MUST produce a failure
    // status. If this test ever passes accidentally with
    // status=passed, the entire zero-fab thesis collapses.
    const content = makeContent([
      makeBullet("b1", "The user managed a team of 40 at Netflix.", ["u1"]),
    ]);

    const extractClaims = vi.fn(async () => [
      fakeClaim("c1", "b1", "The user managed a team of 40 at Netflix."),
    ]);
    const checkTraceability = vi.fn(async () => FAKE_TRACE_NO_SUPPORT);
    const checkSpecificity = vi.fn();

    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1", { raw_text: "Worked on Disney+" })],
      extractClaims,
      checkTraceability,
      checkSpecificity,
      persistFlags: async () => {},
      generateId: () => "f1",
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.status).toBe("failed");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]!.status).toBe("untraceable");
    expect(result.flags[0]!.supporting_unit_id).toBeUndefined();
  });

  it("specificity short-circuit: untraceable claim does NOT trigger specificity check", async () => {
    // Pin the cost optimization + correctness call: a fabricated
    // claim's specificity is moot. The orchestrator skips the
    // specificity LLM call when traceability returns false.
    const content = makeContent([
      makeBullet("b1", "The user did a fabricated thing.", ["u1"]),
    ]);

    const extractClaims = vi.fn(async () => [fakeClaim("c1", "b1", "x")]);
    const checkTraceability = vi.fn(async () => FAKE_TRACE_NO_SUPPORT);
    const checkSpecificity = vi.fn();

    await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims,
      checkTraceability,
      checkSpecificity,
      persistFlags: async () => {},
    });

    expect(checkSpecificity).not.toHaveBeenCalled();
  });

  it("specificity flag: traceable BUT vague → status=failed", async () => {
    const content = makeContent([
      makeBullet("b1", "The user collaborated cross-functionally.", ["u1"]),
    ]);

    const extractClaims = vi.fn(async () => [fakeClaim("c1", "b1", "x")]);
    const checkTraceability = vi.fn(async () => fakeTraceSupports("u1"));
    const checkSpecificity = vi.fn(async () => ({
      ...FAKE_SPEC_VAGUE,
      matched_pattern: "collaborated cross-functionally",
    }));

    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims,
      checkTraceability,
      checkSpecificity,
      persistFlags: async () => {},
      generateId: () => "f1",
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.status).toBe("failed");
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]!.status).toBe("specificity");
    expect(result.flags[0]!.matched_pattern).toBe(
      "collaborated cross-functionally",
    );
    // Traced supporting_unit_id propagates onto specificity
    // flags too — the editor's UX shows what Unit the claim
    // grounded on AND why it's flagged as vague.
    expect(result.flags[0]!.supporting_unit_id).toBe("u1");
  });

  it("multi-bullet, multi-claim aggregation: 2 bullets × 2 claims = 4 flags", async () => {
    const content = makeContent([
      makeBullet("b1", "The user did a thing.", ["u1"]),
      makeBullet("b2", "The user shipped a feature.", ["u2"]),
    ]);

    const extractClaims = vi.fn(async (bullet, ctx) => [
      fakeClaim(`${ctx.bulletId}-c1`, ctx.bulletId, "x"),
      fakeClaim(`${ctx.bulletId}-c2`, ctx.bulletId, "y"),
    ]);
    const checkTraceability = vi.fn(async () => fakeTraceSupports("u1"));
    const checkSpecificity = vi.fn(async () => FAKE_SPEC_OK);

    let idCounter = 0;
    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1"), makeUnit("u2")],
      extractClaims,
      checkTraceability,
      checkSpecificity,
      persistFlags: async () => {},
      generateId: () => `f${++idCounter}`,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.flags).toHaveLength(4);
    expect(result.status).toBe("passed");
    expect(extractClaims).toHaveBeenCalledTimes(2); // once per bullet
    // bullet_id is correctly propagated onto each flag.
    const bullet1Flags = result.flags.filter((f) => f.bullet_id === "b1");
    const bullet2Flags = result.flags.filter((f) => f.bullet_id === "b2");
    expect(bullet1Flags).toHaveLength(2);
    expect(bullet2Flags).toHaveLength(2);
  });

  it("Unit-loading dedup: shared source_unit_ids across bullets produce a single loadUnits call", async () => {
    // Pin: even if 10 bullets all reference Unit u1, the
    // orchestrator loads u1 ONCE up front. The flat collection
    // + Set semantics make this structural.
    const content = makeContent([
      makeBullet("b1", "thing 1", ["u1", "u2"]),
      makeBullet("b2", "thing 2", ["u1"]),
      makeBullet("b3", "thing 3", ["u2"]),
    ]);

    const loadUnits = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => makeUnit(id)),
    );
    await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits,
      extractClaims: async () => [fakeClaim("c1", "b1", "x")],
      checkTraceability: async () => fakeTraceSupports("u1"),
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
    });

    // loadUnits called exactly once with deduped ids ["u1","u2"].
    expect(loadUnits).toHaveBeenCalledTimes(1);
    const calledWith = loadUnits.mock.calls[0]![0];
    expect(new Set(calledWith)).toEqual(new Set(["u1", "u2"]));
  });

  it("empty bullet text: bullet skipped, no LLM calls for it", async () => {
    const content = makeContent([
      makeBullet("b1", "", ["u1"]),
      makeBullet("b2", "Real bullet.", ["u1"]),
    ]);

    const extractClaims = vi.fn(async () => [fakeClaim("c1", "b2", "x")]);
    const checkTraceability = vi.fn(async () => fakeTraceSupports("u1"));
    const checkSpecificity = vi.fn(async () => FAKE_SPEC_OK);

    await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims,
      checkTraceability,
      checkSpecificity,
      persistFlags: async () => {},
    });

    expect(extractClaims).toHaveBeenCalledTimes(1); // only the non-empty bullet
  });

  it("traceability candidate Units are scoped to the bullet's source_unit_ids", async () => {
    // Pin: even if the user owns 100 Units, traceability for a
    // specific bullet only sees the Units the bullet's
    // generator said it grounded on. A claim mentioning
    // content the user has elsewhere but the generator didn't
    // ground on is a fabrication.
    const content = makeContent([
      makeBullet("b1", "Worked on Project X.", ["u1"]),
    ]);

    const checkTraceability = vi.fn(async (claim, candidates) => {
      // The orchestrator passes ONLY the bullet's source units
      // (u1), not all loaded Units (u1, u2).
      expect(candidates.map((u) => u.id)).toEqual(["u1"]);
      return fakeTraceSupports("u1");
    });

    await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1"), makeUnit("u2")],
      extractClaims: async () => [fakeClaim("c1", "b1", "x")],
      checkTraceability,
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
    });

    expect(checkTraceability).toHaveBeenCalledTimes(1);
  });

  it("missing Units (referenced source_unit_ids not in loadUnits result) are silently filtered", async () => {
    // Defensive: if a bullet references u1 but loadUnits doesn't
    // return u1 (e.g. the user deleted the Unit since
    // generation), traceability still runs with the empty
    // candidate set and returns supports=false (the empty-units
    // short-circuit from #107). The missing Unit doesn't crash
    // the orchestrator.
    const content = makeContent([
      makeBullet("b1", "Worked on a deleted Unit.", ["u-deleted"]),
    ]);

    const checkTraceability = vi.fn(async (_claim, candidates) => {
      expect(candidates).toHaveLength(0);
      return FAKE_TRACE_NO_SUPPORT;
    });

    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [], // u-deleted not returned
      extractClaims: async () => [fakeClaim("c1", "b1", "x")],
      checkTraceability,
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
      generateId: () => "f1",
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.status).toBe("failed");
    expect(result.flags[0]!.status).toBe("untraceable");
  });

  it("persistFlags called exactly once per validateAsset invocation with the full result", async () => {
    const content = makeContent([
      makeBullet("b1", "thing", ["u1"]),
      makeBullet("b2", "another thing", ["u1"]),
    ]);

    const persistFlags = vi.fn(async () => {});
    let idCounter = 0;
    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims: async (bullet, ctx) => [
        fakeClaim(`${ctx.bulletId}-c`, ctx.bulletId, "x"),
      ],
      checkTraceability: async () => fakeTraceSupports("u1"),
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags,
      generateId: () => `f${++idCounter}`,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(persistFlags).toHaveBeenCalledTimes(1);
    const persistedResult = persistFlags.mock.calls[0]![1];
    expect(persistedResult.flags).toHaveLength(2);
    expect(persistedResult.status).toBe("passed");
    expect(persistedResult.validated_at).toBe("2026-04-26T00:00:00.000Z");
    // Returned result === persisted result.
    expect(result).toBe(persistedResult);
  });

  it("propagates ValidateAssetNotFound from loadAsset", async () => {
    await expect(
      validateAsset(CTX, {
        loadAsset: async () => {
          throw new ValidateAssetNotFound("Application app-1 not found.");
        },
        loadUnits: async () => [],
        persistFlags: async () => {},
      }),
    ).rejects.toBeInstanceOf(ValidateAssetNotFound);
  });

  it("propagates ValidateAssetMissingContent from loadAsset", async () => {
    await expect(
      validateAsset(CTX, {
        loadAsset: async () => {
          throw new ValidateAssetMissingContent(
            "Asset asset-1 has no generated_content.",
          );
        },
        loadUnits: async () => [],
        persistFlags: async () => {},
      }),
    ).rejects.toBeInstanceOf(ValidateAssetMissingContent);
  });

  it("does NOT call generation again on validation failure (no auto-regeneration pin)", async () => {
    // Per the parent #23 spec: "validation failures never auto-
    // regenerate. They always surface to the user for explicit
    // approval." This test pins the contract by verifying the
    // orchestrator calls only the validation deps — never an
    // imagined generation dep — even when status=failed.
    const content = makeContent([
      makeBullet("b1", "Fabricated thing.", ["u1"]),
    ]);

    const extractClaims = vi.fn(async () => [fakeClaim("c1", "b1", "x")]);
    const checkTraceability = vi.fn(async () => FAKE_TRACE_NO_SUPPORT);

    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims,
      checkTraceability,
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
      generateId: () => "f1",
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.status).toBe("failed");
    // Each dep called the expected number of times — no extra
    // dep was somehow invoked (the function shape doesn't
    // accept a generation dep, structurally enforcing the no-
    // auto-regen contract).
    expect(extractClaims).toHaveBeenCalledTimes(1);
    expect(checkTraceability).toHaveBeenCalledTimes(1);
  });

  it("validates SKILLS items as synthetic bullets (cursor CHANGES_REQUESTED round 2 on #117)", async () => {
    // Cursor caught a prior version where `skills: string[]`
    // was a plain string array and bypassed validation —
    // a fabricated skill could ship with status=passed.
    // Fix: skills are now GeneratedSkill items
    // (id+text+source_unit_ids) and the orchestrator
    // iterates them through the same per-bullet pipeline.
    const content: GeneratedAssetContent = {
      summary: { id: "summary-1", text: "", source_unit_ids: [] },
      experience: [],
      skills: [
        // Real-skill claim that traces.
        {
          id: "skill-1",
          text: "Product strategy at scale.",
          source_unit_ids: ["u1"],
        },
        // Fabricated-skill claim — no Unit supports it.
        {
          id: "skill-fab",
          text: "Built rocket guidance systems at NASA.",
          source_unit_ids: ["u1"],
        },
      ],
    };

    const checkTraceability = vi.fn(async (claim) => {
      if (claim.text.toLowerCase().includes("nasa"))
        return FAKE_TRACE_NO_SUPPORT;
      return fakeTraceSupports("u1");
    });
    let idCounter = 0;
    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1", { raw_text: "Disney+ work" })],
      extractClaims: async (bullet, ctx) => [
        fakeClaim(`${ctx.bulletId}-c1`, ctx.bulletId, bullet.text),
      ],
      checkTraceability,
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
      generateId: () => `f${++idCounter}`,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.flags).toHaveLength(2);
    const fabFlag = result.flags.find((f) => f.bullet_id === "skill-fab");
    const realFlag = result.flags.find((f) => f.bullet_id === "skill-1");
    expect(fabFlag?.status).toBe("untraceable");
    expect(realFlag?.status).toBe("traced");
    expect(result.status).toBe("failed");
  });

  it("validates EDUCATION items as synthetic bullets (cursor CHANGES_REQUESTED round 2 on #117)", async () => {
    // Mirror of the skills test — same gap, same shape.
    const content: GeneratedAssetContent = {
      summary: { id: "summary-1", text: "", source_unit_ids: [] },
      experience: [],
      skills: [],
      education: [
        // Fabricated-education claim.
        {
          id: "edu-fab",
          text: "PhD in Astrophysics, MIT, 2020.",
          source_unit_ids: ["u1"],
        },
      ],
    };

    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1", { raw_text: "BA in CS" })],
      extractClaims: async (bullet, ctx) => [
        fakeClaim(`${ctx.bulletId}-c1`, ctx.bulletId, bullet.text),
      ],
      checkTraceability: async () => FAKE_TRACE_NO_SUPPORT,
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
      generateId: () => "f1",
      now: () => "2026-04-26T00:00:00.000Z",
    });

    expect(result.flags).toHaveLength(1);
    expect(result.flags[0]!.status).toBe("untraceable");
    expect(result.flags[0]!.bullet_id).toBe("edu-fab");
    expect(result.status).toBe("failed");
  });

  it("treats education as optional (no education field → no flags from education)", async () => {
    // The schema marks education optional. An asset without
    // it shouldn't crash the orchestrator; it shouldn't
    // produce education-derived flags either.
    const content: GeneratedAssetContent = {
      summary: { id: "summary-1", text: "", source_unit_ids: [] },
      experience: [{ title: "PM", company: "Disney", bullets: [] }],
      skills: [],
      // education intentionally omitted
    };

    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [],
      extractClaims: async () => [],
      checkTraceability: async () => fakeTraceSupports("u1"),
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
    });

    expect(result.flags).toHaveLength(0);
    expect(result.status).toBe("passed");
  });

  it("validates the SUMMARY as a synthetic bullet (Codex P1 round 1 on #117)", async () => {
    // Codex caught a prior version that iterated only
    // experience[*].bullets — claims in the summary bypassed
    // validation. Now the orchestrator treats summary as a
    // synthetic bullet (same shape: id + text +
    // source_unit_ids) and runs the full per-bullet pipeline
    // on it.
    const content = makeContent(
      [makeBullet("b1", "Real bullet.", ["u1"])],
      {
        id: "summary-1",
        text: "Fabricated summary content about Netflix.",
        source_unit_ids: ["u1"],
      },
    );

    const checkTraceability = vi.fn(async (claim) => {
      // Both the summary and the bullet get traceability
      // checks. The summary's claim doesn't match the Disney
      // Unit; we mock false.
      if (claim.text.toLowerCase().includes("netflix")) {
        return FAKE_TRACE_NO_SUPPORT;
      }
      return fakeTraceSupports("u1");
    });
    const persistFlags = vi.fn(async () => {});
    let idCounter = 0;
    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [
        makeUnit("u1", { raw_text: "Disney+ work" }),
      ],
      extractClaims: async (bullet, ctx) => [
        fakeClaim(`${ctx.bulletId}-c1`, ctx.bulletId, bullet.text),
      ],
      checkTraceability,
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags,
      generateId: () => `f${++idCounter}`,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    // Two flags: summary's untraceable + bullet's traced.
    expect(result.flags).toHaveLength(2);
    const summaryFlag = result.flags.find((f) => f.bullet_id === "summary-1");
    expect(summaryFlag?.status).toBe("untraceable");
    expect(result.status).toBe("failed");
  });

  it("skips empty summary text (no LLM call for an empty-content summary)", async () => {
    const content = makeContent(
      [makeBullet("b1", "Real bullet.", ["u1"])],
      // Summary present but empty (the default in makeContent
      // returns "" for text).
    );

    const extractClaims = vi.fn(async (_bullet, ctx) => [
      fakeClaim(`${ctx.bulletId}-c1`, ctx.bulletId, "x"),
    ]);
    await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims,
      checkTraceability: async () => fakeTraceSupports("u1"),
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
    });

    // Only the experience bullet got a claim-extraction call;
    // the empty summary was skipped.
    expect(extractClaims).toHaveBeenCalledTimes(1);
  });

  it("computes content_snapshot deterministically for TOCTOU detection", async () => {
    // Pin: result.content_snapshot is a JSON-string of the
    // loaded content. The persist transaction uses this to
    // detect concurrent edits. Codex/CR Major round 1 on #117.
    const content = makeContent([makeBullet("b1", "thing", ["u1"])]);
    const persistFlags = vi.fn(async () => {});

    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims: async (b, ctx) => [
        fakeClaim(`${ctx.bulletId}-c1`, ctx.bulletId, "x"),
      ],
      checkTraceability: async () => fakeTraceSupports("u1"),
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags,
    });

    expect(result.content_snapshot).toBe(JSON.stringify(content));
    // The persistFlags call gets the snapshot too — the
    // production persist uses this to detect TOCTOU edits.
    const persisted = persistFlags.mock.calls[0]![1];
    expect(persisted.content_snapshot).toBe(JSON.stringify(content));
  });

  it("propagates ValidateAssetStale from persistFlags (TOCTOU stale-write defense)", async () => {
    // The orchestrator surfaces ValidateAssetStale as-is so
    // the callable can map it to an `aborted` HttpsError and
    // the editor surface can re-trigger validation.
    const content = makeContent([makeBullet("b1", "thing", ["u1"])]);
    await expect(
      validateAsset(CTX, {
        loadAsset: async () => ({ asset: makeAsset(content), content }),
        loadUnits: async () => [makeUnit("u1")],
        extractClaims: async (b, ctx) => [
          fakeClaim(`${ctx.bulletId}-c1`, ctx.bulletId, "x"),
        ],
        checkTraceability: async () => fakeTraceSupports("u1"),
        checkSpecificity: async () => FAKE_SPEC_OK,
        persistFlags: async () => {
          throw new ValidateAssetStale(
            "Asset asset-1 content changed during validation.",
          );
        },
      }),
    ).rejects.toBeInstanceOf(ValidateAssetStale);
  });

  it("flag id stamped from generateId; bullet_id propagated; claim_id from the input claim", async () => {
    const content = makeContent([
      makeBullet("b-stamped", "thing", ["u1"]),
    ]);

    const ids = ["flag-1", "flag-2"];
    const result = await validateAsset(CTX, {
      loadAsset: async () => ({ asset: makeAsset(content), content }),
      loadUnits: async () => [makeUnit("u1")],
      extractClaims: async () => [
        fakeClaim("claim-stamped", "b-stamped", "x"),
      ],
      checkTraceability: async () => fakeTraceSupports("u1"),
      checkSpecificity: async () => FAKE_SPEC_OK,
      persistFlags: async () => {},
      generateId: () => ids.shift() ?? "fallback",
      now: () => "2026-04-26T00:00:00.000Z",
    });

    const flag = result.flags[0]! as ValidationFlag;
    expect(flag.id).toBe("flag-1");
    expect(flag.bullet_id).toBe("b-stamped");
    expect(flag.claim_id).toBe("claim-stamped");
    expect(flag.asset_id).toBe("asset-1");
  });
});
