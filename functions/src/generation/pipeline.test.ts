import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
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

function makeInputs(unitIds: string[]): GenerationInputs {
  return {
    units: unitIds.map((id) => makeUnit(id)),
    role: makeRole(),
    requirements: [makeReq("req-1")],
    approvedMatches: [],
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

  it("EMPTY-UNITS GUARD: throws GenerationNoApprovedUnitsError WITHOUT calling the LLM", async () => {
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
