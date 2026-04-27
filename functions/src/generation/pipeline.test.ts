import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.ts";
import type { Role } from "../types/crm.ts";

import {
  GenerationApplicationNotFound,
  GenerationError,
  GenerationNoApprovedUnitsError,
  runGenerationPipeline,
  type GenerationInputs,
  type RunGenerationContext,
} from "./pipeline.ts";

/**
 * DI-based pipeline tests. The Firestore boundary is replaced
 * via `loadInputs`; the LLM client is mocked. The orchestrator's
 * composition logic + cross-validation contract are what's pinned.
 *
 * Coverage:
 *   - Happy path: 1 Unit → 1 LLM call returns valid response →
 *     ids stamped, content + cost/latency returned.
 *   - **Empty-units guard**: throws GenerationNoApprovedUnitsError
 *     synchronously without calling the LLM.
 *   - **Cross-validation (load-bearing zero-fab pin)**: a response
 *     with a fabricated source_unit_id triggers a retry; on
 *     third occurrence, throws GenerationError with `value_error`.
 *   - **Retry semantics**: schema_error → retry → succeed;
 *     transport_error → backoff → retry → succeed; no_tool_use
 *     → retry → succeed.
 *   - **Retry exhaustion**: 3 schema errors → GenerationError.
 *   - **Cost tracking**: every successful response logs via
 *     recordUsage with stage='generation'.
 *   - **recordUsage non-fatal**: telemetry write rejection
 *     doesn't kill the pipeline (mirror of #118).
 *   - **Server-stamped ids**: every emitted item gets a fresh
 *     UUID; LLM never emits ids.
 */

const CTX: RunGenerationContext = {
  ownerUid: "user-alice",
  applicationId: "app-1",
};

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

function makeRole(): Role {
  return {
    id: "role-1",
    owner_uid: "user-alice",
    company_id: "company-1",
    title: "Senior PM",
    jd_raw: "JD text",
    discovered_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeReq(id: string): JobRequirementUnit {
  return {
    id,
    owner_uid: "user-alice",
    role_id: "role-1",
    raw_text: "5+ years PM",
    normalized_requirement: "5+ years product management experience",
    category: "experience_level",
    keywords: [],
    tools: [],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
  };
}

function makeMatch(unitId: string): UnitMatch {
  return {
    id: `match-${unitId}`,
    owner_uid: "user-alice",
    role_id: "role-1",
    experience_unit_id: unitId,
    job_requirement_unit_id: "req-1",
    semantic_score: 0.8,
    rule_score: 0.7,
    final_score: 0.75,
    rationale: "supports",
    surface_evidence: "evidence",
    approved_for_use: true,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Build inputs. By default every Unit is "eligible" — i.e. has
 * an approved match. Pass `approvedMatchUnitIds` to override
 * (e.g. `[]` for the empty-matches edge case, or a subset of
 * `unitIds` to test the partial-eligibility case).
 */
function makeInputs(
  unitIds: string[],
  approvedMatchUnitIds?: string[],
): GenerationInputs {
  const matchedIds = approvedMatchUnitIds ?? unitIds;
  return {
    units: unitIds.map((id) => makeUnit(id)),
    role: makeRole(),
    requirements: [makeReq("req-1")],
    approvedMatches: matchedIds.map((id) => makeMatch(id)),
  };
}

function mockMessage(
  toolInput: unknown,
  usage = { input_tokens: 800, output_tokens: 400 },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [
      {
        type: "tool_use",
        id: "toolu_test",
        name: "record_resume",
        input: toolInput,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
  } as Anthropic.Messages.Message;
}

function mockTextOnlyMessage(
  text: string,
  usage = { input_tokens: 100, output_tokens: 10 },
): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  } as Anthropic.Messages.Message;
}

interface MockClientHandle {
  client: Anthropic;
  create: ReturnType<typeof vi.fn>;
}

function mockClient(
  responses: (Anthropic.Messages.Message | Error)[],
): MockClientHandle {
  const queue = [...responses];
  const create = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock client: no more queued responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    client: { messages: { create } } as unknown as Anthropic,
    create,
  };
}

const VALID_RESPONSE = {
  summary: {
    text: "Senior PM with streaming experience.",
    source_unit_ids: ["u1"],
  },
  bullets: [
    {
      text: "Led NCP migration on Disney+ playback.",
      source_unit_ids: ["u1"],
    },
  ],
  skills: [
    { text: "Streaming video", source_unit_ids: ["u1"] },
  ],
};

describe("runGenerationPipeline", () => {
  it("happy path: returns content with stamped ids + cost/latency telemetry", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.0005);
    const { client } = mockClient([mockMessage(VALID_RESPONSE)]);
    const ids = ["id-summary", "id-b1", "id-s1"];

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => ids.shift() ?? "fallback",
    });

    expect(result.content.summary.id).toBe("id-summary");
    expect(result.content.summary.text).toBe(
      "Senior PM with streaming experience.",
    );
    expect(result.content.bullets).toHaveLength(1);
    expect(result.content.bullets[0]!.id).toBe("id-b1");
    expect(result.content.skills).toHaveLength(1);
    expect(result.content.skills[0]!.id).toBe("id-s1");
    expect(result.content.education).toBeUndefined();

    expect(result.input_tokens).toBe(800);
    expect(result.output_tokens).toBe(400);
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("EMPTY-UNITS GUARD: 0 approved Units → throws GenerationNoApprovedUnitsError WITHOUT calling the LLM", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);

    await expect(
      runGenerationPipeline(CTX, {
        client,
        record,
        loadInputs: async () => makeInputs([]),
      }),
    ).rejects.toBeInstanceOf(GenerationNoApprovedUnitsError);

    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("APPROVED-MATCHES GATE (cursor #123 r1): approved Units WITHOUT approved matches → throws GenerationNoApprovedUnitsError", async () => {
    // The spec gates generation on Units AND their approved
    // matches for THIS Role. A Unit the user approved but
    // never connected to a Role Requirement (no
    // UnitMatch.approved_for_use === true) is generic content
    // — using it as ground for THIS Role's resume invites
    // generic prose the user hasn't reviewed in context.
    //
    // The error message distinguishes this case from the
    // 0-Units case so the editor surface (#24) can prompt
    // "approve a match in the Matches tab" specifically.
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([]);

    let thrown: unknown;
    try {
      await runGenerationPipeline(CTX, {
        client,
        record,
        // 1 approved Unit, 0 approved matches.
        loadInputs: async () => makeInputs(["u1"], []),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GenerationNoApprovedUnitsError);
    if (thrown instanceof Error) {
      expect(thrown.message).toContain("Approved Units present");
      expect(thrown.message).toContain("no approved UnitMatches");
    }
    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("APPROVED-MATCHES GATE: only Units WITH approved matches reach the prompt + cross-validation", async () => {
    // 3 Units approved, but only u1 + u2 have approved
    // matches. u3 is approved-but-unmatched. The pipeline
    // filters u3 out of the prompt; cross-validation rejects
    // any LLM emission citing u3.
    const groundsOnUnmatched = {
      summary: { text: "Summary", source_unit_ids: ["u3"] }, // u3 is approved but unmatched
      bullets: [],
      skills: [],
    };
    const validResponse = {
      summary: { text: "Summary", source_unit_ids: ["u1"] }, // u1 is matched
      bullets: [],
      skills: [],
    };
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([
      mockMessage(groundsOnUnmatched),
      mockMessage(validResponse),
    ]);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () =>
        makeInputs(["u1", "u2", "u3"], ["u1", "u2"]),
      generateId: () => "id-x",
      sleep: async () => {},
    });

    // First attempt rejected (u3 isn't an eligible Unit);
    // second attempt accepted.
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.content.summary.source_unit_ids).toEqual(["u1"]);
  });

  it("CROSS-VALIDATION (load-bearing zero-fab pin): fabricated source_unit_id → retry → succeed on second attempt", async () => {
    // The LLM emits "u-fabricated" which isn't in the loaded
    // Units. The pipeline catches this as a value_error and
    // retries. Second attempt returns valid; pipeline succeeds.
    const fabricatedResponse = {
      summary: {
        text: "Senior PM.",
        source_unit_ids: ["u-fabricated"], // NOT a loaded Unit id
      },
      bullets: [],
      skills: [],
    };
    const record = vi.fn<typeof RecordUsage>(async () => 0.0005);
    const { client, create } = mockClient([
      mockMessage(fabricatedResponse),
      mockMessage(VALID_RESPONSE),
    ]);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
      sleep: async () => {}, // no real backoff in tests
    });

    expect(result.content.summary.source_unit_ids).toEqual(["u1"]);
    expect(create).toHaveBeenCalledTimes(2);
    // Cost recorded for BOTH responses — even the failed-validation
    // first attempt produced tokens.
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("CUMULATIVE TOKENS + COST (CodeRabbit r2 advisory): retry burns real tokens; returned values reflect TOTAL spend, not just the final attempt", async () => {
    // Pins the bug CodeRabbit caught on the 4a72fd0 round:
    // returning only `response.usage` from the final successful
    // attempt makes failed-then-retried calls look free in the
    // caller's per-application budget tracker. The pipeline now
    // accumulates tokens + cost across ALL attempts (whether
    // they pass schema/cross-validation or not).
    const fabricated = {
      summary: { text: "x", source_unit_ids: ["u-fab"] },
      bullets: [],
      skills: [],
    };
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([
      mockMessage(fabricated, { input_tokens: 1000, output_tokens: 500 }),
      mockMessage(VALID_RESPONSE, { input_tokens: 700, output_tokens: 200 }),
    ]);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
      sleep: async () => {},
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.input_tokens).toBe(1700); // 1000 + 700
    expect(result.output_tokens).toBe(700); // 500 + 200
    // estimateCostUsd uses Haiku pricing
    // ($0.25/MTok input, $1.25/MTok output): cumulative >
    // single-attempt cost.
    const singleAttemptCost = (700 * 0.25 + 200 * 1.25) / 1_000_000;
    expect(result.cost_usd).toBeGreaterThan(singleAttemptCost);
  });

  it("CROSS-VALIDATION exhaustion: 3 fabricated-id responses → GenerationError with value_error failures", async () => {
    const fabricated = {
      summary: { text: "x", source_unit_ids: ["u-fab"] },
      bullets: [],
      skills: [],
    };
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client } = mockClient([
      mockMessage(fabricated),
      mockMessage(fabricated),
      mockMessage(fabricated),
    ]);

    let thrown: unknown;
    try {
      await runGenerationPipeline(CTX, {
        client,
        record,
        loadInputs: async () => makeInputs(["u1"]),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GenerationError);
    if (thrown instanceof GenerationError) {
      expect(thrown.failures).toHaveLength(3);
      for (const f of thrown.failures) {
        expect(f.kind).toBe("value_error");
        expect(f.message).toContain("u-fab");
      }
    }
  });

  it("schema_error retry: malformed → retry → valid → succeed", async () => {
    const malformed = { wrong_shape: true };
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const { client, create } = mockClient([
      mockMessage(malformed),
      mockMessage(VALID_RESPONSE),
    ]);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
    });

    expect(result.content.summary.text).toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("schema_error exhaustion: 3 malformed responses → GenerationError with schema_error failures", async () => {
    const malformed = { wrong_shape: true };
    const { client } = mockClient([
      mockMessage(malformed),
      mockMessage(malformed),
      mockMessage(malformed),
    ]);

    await expect(
      runGenerationPipeline(CTX, {
        client,
        record: vi.fn<typeof RecordUsage>(async () => 0),
        loadInputs: async () => makeInputs(["u1"]),
      }),
    ).rejects.toBeInstanceOf(GenerationError);
  });

  it("transport_error: backs off and retries on next attempt", async () => {
    const { client, create } = mockClient([
      new Error("ECONNRESET"),
      mockMessage(VALID_RESPONSE),
    ]);
    const sleep = vi.fn(async () => {});
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
      sleep,
    });

    expect(result.content.summary.text).toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
    // Backoff sleep was called once before the retry.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThan(0);
    // recordUsage NOT called for the transport error (no tokens
    // to record); only the successful attempt.
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("post-merge cursor on PR #144: passes err to transportBackoffMs so retry-after / anthropic-ratelimit-*-reset headers are honored", async () => {
    // Pin the regression cursor caught after #114/#144 merged:
    // generation/pipeline.ts was calling
    // `transportBackoffMs(attempt)` without the err arg, so the
    // header-aware backoff (#114) silently fell back to the
    // exponential schedule. With err passed correctly, a 429
    // carrying `retry-after: 30` elevates the delay to ≥30,000
    // ms (vs. the slow-down exponential's 1,000-1,250 ms at
    // attempt 0). Asserting `>= 30000` proves the err arg
    // propagated through.
    const apiError = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "retry-after": "30" },
    });
    const { client, create } = mockClient([
      apiError,
      mockMessage(VALID_RESPONSE),
    ]);
    const sleep = vi.fn(async () => {});
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
      sleep,
    });

    expect(result.content.summary.text).toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // 30s retry-after → backoff ≥ 30,000 ms (jitter adds up to
    // 250). Without the err arg, attempt-0 slow-down backoff
    // tops out around 1,250 ms — well below this bound.
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(30_000);
  });

  it("no_tool_use response: counts as failure, retries", async () => {
    const { client, create } = mockClient([
      mockTextOnlyMessage("I would emit but cannot use tools."),
      mockMessage(VALID_RESPONSE),
    ]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
    });

    expect(result.content.summary.text).toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
    // Both attempts emitted tokens → both recorded.
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("recordUsage non-fatal: telemetry rejection does NOT kill the pipeline", async () => {
    // Mirror of #118's pattern. The cost tracker rejecting
    // shouldn't lose an otherwise-successful generation.
    const record = vi.fn<typeof RecordUsage>(async () => {
      throw new Error("Telemetry write failed");
    });
    const { client } = mockClient([mockMessage(VALID_RESPONSE)]);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
    });

    expect(result.content.summary.text).toBeDefined();
    expect(record).toHaveBeenCalled();
  });

  it("cost tracker shape: stage='generation', provider='anthropic', tokens propagated", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0.0005);
    const { client } = mockClient([mockMessage(VALID_RESPONSE)]);

    await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
    });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "generation",
        provider: "anthropic",
        inputTokens: 800,
        outputTokens: 400,
        ownerUid: "user-alice",
      }),
    );
  });

  it("server-stamps unique ids on every item; LLM-emitted `id` rejected at schema layer", async () => {
    // The schema rejects LLM-emitted `id` (#119 strict mode).
    // The pipeline stamps fresh UUIDs after schema validation.
    // Pin: every item has a distinct id (no collisions).
    const richResponse = {
      summary: { text: "Summary", source_unit_ids: ["u1"] },
      bullets: [
        { text: "Bullet 1", source_unit_ids: ["u1"] },
        { text: "Bullet 2", source_unit_ids: ["u1"] },
      ],
      skills: [
        { text: "Skill A", source_unit_ids: ["u1"] },
        { text: "Skill B", source_unit_ids: ["u1"] },
      ],
      education: [{ text: "BS, MIT", source_unit_ids: ["u1"] }],
    };
    let counter = 0;
    const { client } = mockClient([mockMessage(richResponse)]);

    const result = await runGenerationPipeline(CTX, {
      client,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => `id-${++counter}`,
    });

    const allIds = [
      result.content.summary.id,
      ...result.content.bullets.map((b) => b.id),
      ...result.content.skills.map((s) => s.id),
      ...(result.content.education ?? []).map((e) => e.id),
    ];
    // 1 summary + 2 bullets + 2 skills + 1 education = 6 ids.
    expect(allIds).toHaveLength(6);
    expect(new Set(allIds).size).toBe(6);
  });

  it("propagates GenerationNoApprovedUnitsError from loadInputs (no Units case)", async () => {
    await expect(
      runGenerationPipeline(CTX, {
        loadInputs: async () => {
          throw new GenerationNoApprovedUnitsError("none");
        },
      }),
    ).rejects.toBeInstanceOf(GenerationNoApprovedUnitsError);
  });

  it("propagates GenerationApplicationNotFound from loadInputs (anti-enumeration)", async () => {
    await expect(
      runGenerationPipeline(CTX, {
        loadInputs: async () => {
          throw new GenerationApplicationNotFound("not yours");
        },
      }),
    ).rejects.toBeInstanceOf(GenerationApplicationNotFound);
  });

  it("source_unit_ids ALL must validate — partial fabrication caught", async () => {
    // A response where ONE bullet has a fabricated id while
    // others are clean still fails cross-validation. The
    // pipeline catches the first fab and retries.
    const partialFab = {
      summary: { text: "x", source_unit_ids: ["u1"] }, // valid
      bullets: [
        { text: "real", source_unit_ids: ["u1"] },          // valid
        { text: "fake", source_unit_ids: ["u-fake"] },      // FAB
      ],
      skills: [],
    };
    const { client, create } = mockClient([
      mockMessage(partialFab),
      mockMessage(VALID_RESPONSE),
    ]);
    const record = vi.fn<typeof RecordUsage>(async () => 0);

    const result = await runGenerationPipeline(CTX, {
      client,
      record,
      loadInputs: async () => makeInputs(["u1"]),
      generateId: () => "id-x",
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.content.summary.source_unit_ids).toEqual(["u1"]);
  });

  it("source_unit_ids cross-validation iterates summary + bullets + skills + education", async () => {
    // Pin: a fabricated id in education (the most-easily-
    // missed iteration target) is caught.
    const educationFab = {
      summary: { text: "x", source_unit_ids: ["u1"] },
      bullets: [],
      skills: [],
      education: [
        { text: "PhD MIT", source_unit_ids: ["u-edu-fake"] }, // FAB
      ],
    };
    const { client } = mockClient([
      mockMessage(educationFab),
      mockMessage(educationFab),
      mockMessage(educationFab),
    ]);

    let thrown: unknown;
    try {
      await runGenerationPipeline(CTX, {
        client,
        record: vi.fn<typeof RecordUsage>(async () => 0),
        loadInputs: async () => makeInputs(["u1"]),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GenerationError);
    if (thrown instanceof GenerationError) {
      expect(thrown.failures[0]!.message).toContain("u-edu-fake");
    }
  });
});
