/**
 * Callable-level tests for `generateResumeHandler` (#121).
 *
 * Covers the auth + arg-validation + error-mapping paths the
 * orchestrator-level integration test (`tests/generation-
 * persistence.integration.test.ts`) doesn't reach, since that
 * test calls `runGenerateResume` directly. CodeRabbit
 * Critical round 1 on PR #124 called for this coverage.
 *
 * Tests invoke `generateResumeHandler` (the inner async
 * function) with fabricated `CallableRequest` objects rather
 * than routing through `onCall`'s runtime. The handler is the
 * same one `generateResumeCallable` wraps, so behavior under
 * test is the production code path minus the runtime's
 * request parsing.
 *
 * The orchestrator's deps are injected via the handler's
 * `deps` arg — same shape as the pipeline-level tests at
 * `functions/src/generation/pipeline.test.ts` (#120). No
 * Firestore emulator needed; `loadInputs` and `persistAsset`
 * are both DI'd.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { HttpsError } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import { describe, expect, it, vi } from "vitest";

import {
  generateResumeHandler,
  type GenerateResumeData,
} from "./generateResume.ts";
import {
  GenerationApplicationNotFound,
  GenerationError,
  GenerationNoApprovedUnitsError,
} from "../generation/pipeline.ts";
import { GenerateResumePersistNotFound } from "../generation/runGenerateResume.ts";
import type { GenerationInputs } from "../generation/pipeline.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.ts";
import type { Role } from "../types/crm.ts";

// -- Fixtures ---------------------------------------------------------------

const ALICE = "user-alice";
const APP_ID = "app-1";

/**
 * Build a fabricated CallableRequest. Pass `null` for
 * `authUid` to simulate an unauthenticated request — the
 * literal `undefined` would fall back to the default param,
 * so we use a sentinel.
 */
function makeRequest(
  data: GenerateResumeData | undefined,
  authUid: string | null = ALICE,
): CallableRequest<GenerateResumeData> {
  return {
    data: data as GenerateResumeData,
    auth: authUid !== null ? { uid: authUid, token: {} } : undefined,
    rawRequest: {} as never,
    acceptsStreaming: false,
  } as unknown as CallableRequest<GenerateResumeData>;
}

function makeUnit(id: string): ExperienceUnit {
  return {
    id,
    owner_uid: ALICE,
    source_type: "resume",
    source_ref: "ref",
    raw_text: "ground truth",
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeRole(): Role {
  return {
    id: "role-1",
    owner_uid: ALICE,
    company_id: "company-1",
    title: "Senior PM",
    jd_raw: "Build great things.",
    discovered_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeRequirement(): JobRequirementUnit {
  return {
    id: "req-1",
    owner_uid: ALICE,
    role_id: "role-1",
    raw_text: "Ship things",
    normalized_requirement: "Ship products",
    category: "domain",
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
    owner_uid: ALICE,
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

const VALID_LLM_RESPONSE = {
  summary: { text: "Senior PM grounded.", source_unit_ids: ["u1"] },
  bullets: [{ text: "Shipped X.", source_unit_ids: ["u1"] }],
  skills: [{ text: "Strategy", source_unit_ids: ["u1"] }],
};

function mockClient(toolInput: unknown): Anthropic {
  return {
    messages: {
      create: async () => ({
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
        usage: { input_tokens: 500, output_tokens: 200 },
      }),
    },
  } as unknown as Anthropic;
}

// -- Tests ------------------------------------------------------------------

describe("generateResumeHandler", () => {
  it("AUTH: rejects unauthenticated requests with HttpsError(unauthenticated)", async () => {
    const req = makeRequest({ applicationId: APP_ID }, null);
    let thrown: unknown;
    try {
      await generateResumeHandler(req);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("unauthenticated");
  });

  it("ARG-VALIDATION: rejects missing applicationId with HttpsError(invalid-argument)", async () => {
    const req = makeRequest({});
    let thrown: unknown;
    try {
      await generateResumeHandler(req);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("invalid-argument");
  });

  it("ARG-VALIDATION: rejects empty-string applicationId with HttpsError(invalid-argument)", async () => {
    const req = makeRequest({ applicationId: "   " });
    let thrown: unknown;
    try {
      await generateResumeHandler(req);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("invalid-argument");
  });

  it("ARG-VALIDATION: rejects applicationId containing '/' with HttpsError(invalid-argument) — Firestore path delimiter guard", async () => {
    const req = makeRequest({ applicationId: "app/sneaky" });
    let thrown: unknown;
    try {
      await generateResumeHandler(req);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("invalid-argument");
    expect((thrown as HttpsError).message).toContain("/");
  });

  it("ERROR-MAP: GenerationApplicationNotFound → HttpsError(permission-denied) — anti-enumeration", async () => {
    const req = makeRequest({ applicationId: APP_ID });
    const deps = {
      loadInputs: async () => {
        throw new GenerationApplicationNotFound(
          `Application ${APP_ID} not found.`,
        );
      },
    };
    let thrown: unknown;
    try {
      await generateResumeHandler(req, deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("permission-denied");
    // Critical: the user-facing message is the COLLAPSED
    // anti-enumeration shape, NOT the underlying error's
    // message. Ensures we don't leak whether the app exists.
    expect((thrown as HttpsError).message).toContain("not found");
    expect((thrown as HttpsError).message).not.toContain(APP_ID);
  });

  it("ERROR-MAP: GenerateResumePersistNotFound → HttpsError(permission-denied) — same anti-enumeration shape at the persist boundary", async () => {
    const req = makeRequest({ applicationId: APP_ID });
    const inputs: GenerationInputs = {
      units: [makeUnit("u1")],
      role: makeRole(),
      requirements: [makeRequirement()],
      approvedMatches: [makeMatch("u1")],
    };
    const deps = {
      client: mockClient(VALID_LLM_RESPONSE),
      record: vi.fn(async () => 0),
      loadInputs: async () => inputs,
      persistAsset: async () => {
        throw new GenerateResumePersistNotFound(
          `Application ${APP_ID} not found during persist.`,
        );
      },
      generateId: () => "asset-deterministic",
      now: () => "2026-04-26T05:00:00.000Z",
      sleep: async () => {},
    };
    let thrown: unknown;
    try {
      await generateResumeHandler(req, deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("permission-denied");
  });

  it("ERROR-MAP: GenerationNoApprovedUnitsError → HttpsError(failed-precondition) — message flows through verbatim", async () => {
    const req = makeRequest({ applicationId: APP_ID });
    const message =
      `Approved Units present (3) but no approved UnitMatches for this Role for application ${APP_ID}; nothing to generate from. Approve at least one match in the Matches tab before generating.`;
    const deps = {
      loadInputs: async () => {
        throw new GenerationNoApprovedUnitsError(message);
      },
    };
    let thrown: unknown;
    try {
      await generateResumeHandler(req, deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("failed-precondition");
    // The pipeline's distinguishing message ("Approved Units
    // present" vs. "No approved ExperienceUnits") flows
    // through verbatim so the editor surface (#24) can pick
    // the right CTA.
    expect((thrown as HttpsError).message).toBe(message);
  });

  it("ERROR-MAP: GenerationError → HttpsError(failed-precondition) with { failures, stage } details", async () => {
    const req = makeRequest({ applicationId: APP_ID });
    const failures = [
      { attempt: 0, kind: "schema_error" as const, message: "bad shape" },
      { attempt: 1, kind: "value_error" as const, message: "fabricated id" },
      { attempt: 2, kind: "schema_error" as const, message: "bad again" },
    ];
    const deps = {
      loadInputs: async () => {
        throw new GenerationError("retry budget exhausted", failures);
      },
    };
    let thrown: unknown;
    try {
      await generateResumeHandler(req, deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpsError);
    expect((thrown as HttpsError).code).toBe("failed-precondition");
    // Per-attempt detail surfaced for the editor's "needs
    // manual review" UI. Same shape as validateAsset's per-
    // stage mapping (#109).
    const details = (thrown as HttpsError).details as {
      failures: typeof failures;
      stage: string;
    };
    expect(details.stage).toBe("generation");
    expect(details.failures).toEqual(failures);
  });

  it("HAPPY PATH: returns { assetId, applicationId } only — cost/latency live on the persisted AssetRef, NOT the response", async () => {
    const req = makeRequest({ applicationId: APP_ID });
    const inputs: GenerationInputs = {
      units: [makeUnit("u1")],
      role: makeRole(),
      requirements: [makeRequirement()],
      approvedMatches: [makeMatch("u1")],
    };
    let persistedSeen = false;
    const deps = {
      client: mockClient(VALID_LLM_RESPONSE),
      record: vi.fn(async () => 0),
      loadInputs: async () => inputs,
      persistAsset: async (params: { asset: { cost_usd?: number } }) => {
        // The asset arrives at persist with cost/latency
        // populated — the orchestrator's contract.
        expect(params.asset.cost_usd).toBeGreaterThan(0);
        persistedSeen = true;
      },
      generateId: () => "asset-deterministic",
      now: () => "2026-04-26T05:00:00.000Z",
      sleep: async () => {},
    };

    const result = await generateResumeHandler(req, deps);
    expect(persistedSeen).toBe(true);
    // Response is INTENTIONALLY narrow: editor reads cost/
    // latency from the persisted AssetRef via Application
    // doc, not from the callable's response. Pin against
    // future drift that would inflate the response surface.
    expect(result).toEqual({
      assetId: "asset-deterministic",
      applicationId: APP_ID,
    });
    expect(Object.keys(result).sort()).toEqual([
      "applicationId",
      "assetId",
    ]);
  });
});
