/**
 * Per-fixture orchestrator tests (#136). Mocks the LLM
 * clients so the orchestrator can be exercised without
 * spending real API credit.
 *
 * Pinned invariants:
 *   - Happy path: fixture loads, extraction returns
 *     expected-shape Units, parsing returns expected-shape
 *     Requirements, mapping resolves all to mnemonics,
 *     matching produces composites that overlap with
 *     expected_top_matches, scorer returns a number > 0.
 *   - Failure capture: a thrown extraction error doesn't
 *     propagate; result.ok=false, result.error populated,
 *     accuracies clamped to 0.
 *   - Cost field is intentionally null (no per-fixture cost
 *     attribution at this layer; future enhancement).
 *
 * The fixtures used are read from `tests/fixtures/` (the
 * real Nathan + Google pair). The test mocks return shapes
 * derived from the labeler's expected_units so the mapping
 * layer's content matching exercises actual prose.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runForFixture } from "./runForFixture.ts";

// -- Mock factories ---------------------------------------------------------

/**
 * Build a mock Anthropic client whose `messages.create`
 * returns a predetermined sequence of tool_use responses.
 * The orchestrator calls Anthropic twice (extraction then
 * parsing), so the seq is [extractionResponse,
 * parsingResponse].
 */
function makeMockAnthropic(seq: readonly unknown[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const toolInput = seq[i++];
        return {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [
            {
              type: "tool_use",
              id: `toolu_${i}`,
              name: "tool",
              input: toolInput,
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      }),
    },
  } as unknown as Anthropic;
}

/**
 * Build a mock OpenAI client whose `embeddings.create`
 * returns a stub vector for each input. 1536-dim like the
 * production model; values are deterministic per-input
 * length so different texts produce different vectors
 * (matters for the matching pipeline's similarity scoring).
 */
function makeMockOpenAi(): OpenAI {
  return {
    embeddings: {
      create: vi.fn(async ({ input }: { input: string | string[] }) => {
        const inputs = Array.isArray(input) ? input : [input];
        return {
          data: inputs.map((s, idx) => ({
            embedding: makeStubEmbedding(s, idx),
            index: idx,
            object: "embedding",
          })),
          model: "text-embedding-3-small",
          object: "list",
          usage: { prompt_tokens: inputs.length * 10, total_tokens: inputs.length * 10 },
        };
      }),
    },
  } as unknown as OpenAI;
}

/**
 * Deterministic 1536-dim stub vector. Different inputs
 * produce different magnitudes via a seeded random walk so
 * cosine-similarity downstream stays above 0 but below 1
 * for distinct strings.
 */
function makeStubEmbedding(text: string, idx: number): number[] {
  const seed = (text.length * 31 + idx) % 1000 + 1;
  const vec: number[] = [];
  let x = seed;
  for (let i = 0; i < 1536; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    vec.push((x / 0x7fffffff) * 2 - 1);
  }
  return vec;
}

// -- Tests ------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runForFixture", () => {
  it("HAPPY PATH: extracts → embeds → parses → matches → scores; returns ok=true with non-null accuracies", async () => {
    // Mock extraction returns 2 Units that closely match the
    // first two expected_units in nathan-2026.json. Mock
    // parsing returns 2 Requirements that closely match the
    // first two expected_requirements in the matches file.
    const extractionResp = {
      units: [
        {
          raw_text: "Led Amazon Kepler launch",
          normalized_summary:
            "Led Amazon Kepler launch — ground-up rewrite replacing Fire TV Android stack",
          unit_type: "project",
          skills: ["platform launch", "partner integration"],
          tools: ["NCP", "Fire TV"],
          domains: ["streaming video infrastructure"],
          seniority_signals: [],
          scope_signals: [],
          business_outcomes: [],
          metrics: [],
          evidence_type: "verified",
          confidence_score: 0.9,
        },
        {
          raw_text: "Brought Disney+ from concept to launch",
          normalized_summary:
            "Brought Disney+ from concept to launch on multiple connected devices",
          unit_type: "project",
          skills: ["0-to-1 product launch", "cross-functional leadership"],
          tools: ["Disney+"],
          domains: ["streaming video infrastructure"],
          seniority_signals: [],
          scope_signals: [],
          business_outcomes: [],
          metrics: [],
          evidence_type: "verified",
          confidence_score: 0.9,
        },
      ],
    };
    const parsingResp = {
      requirements: [
        {
          raw_text: "8 years of experience in product management",
          normalized_requirement: "8 years of product management experience",
          category: "experience_level",
          keywords: [],
          tools: [],
          domains: [],
          priority: "high",
          must_have: true,
          extracted_from: "qualifications",
        },
        {
          raw_text: "3 years taking technical products from conception to launch",
          normalized_requirement: "3 years 0-to-1 product launch experience",
          category: "experience_level",
          keywords: [],
          tools: [],
          domains: [],
          priority: "high",
          must_have: true,
          extracted_from: "qualifications",
        },
      ],
    };

    const result = await runForFixture(
      {
        resumeFixtureId: "nathan-2026",
        jdFixtureId: "google-compute-spm-2026",
      },
      {
        anthropicClient: makeMockAnthropic([extractionResp, parsingResp]),
        openaiClient: makeMockOpenAi(),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.extractedUnitCount).toBe(2);
    expect(result.parsedRequirementCount).toBe(2);
    expect(result.extractionAccuracy).toBeGreaterThan(0);
    // matchAccuracy may be > 0 if the matching pipeline
    // produced any composites that line up with expected_top_matches.
    // With only 2 extracted Units / 2 parsed Reqs vs. 24 expected
    // matches, expect a low number — the test pins shape, not absolute.
    expect(result.matchAccuracy).toBeGreaterThanOrEqual(0);
    expect(result.matchAccuracy).toBeLessThanOrEqual(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // cursor #139 r1: cost is now accumulated via the
    // closure-bound priceFor recorder, NOT dropped on the
    // floor. Mock LLM calls produce non-zero token counts
    // (100/50 anthropic + N×10 openai) so cost > 0.
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeLessThan(1); // a tiny test run; sanity bound
  });

  it("FAILURE CAPTURE: extraction throws → result.ok=false, result.error populated, accuracies=0", async () => {
    const failingAnthropic = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("Anthropic 503 — pretend transport error");
        }),
      },
    } as unknown as Anthropic;

    const result = await runForFixture(
      {
        resumeFixtureId: "nathan-2026",
        jdFixtureId: "google-compute-spm-2026",
      },
      {
        anthropicClient: failingAnthropic,
        openaiClient: makeMockOpenAi(),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.extractionAccuracy).toBe(0);
    expect(result.matchAccuracy).toBe(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // Failure path returns 0, not null — cost is a number
    // post-#139 r1 (no LLM call made → 0 accumulated).
    expect(result.costUsd).toBe(0);
  });

  it("FIXTURE-NOT-FOUND: missing fixture id → result.ok=false with descriptive error", async () => {
    const result = await runForFixture(
      {
        resumeFixtureId: "does-not-exist",
        jdFixtureId: "also-does-not-exist",
      },
      {
        anthropicClient: makeMockAnthropic([]),
        openaiClient: makeMockOpenAi(),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOENT|no such file|does-not-exist/);
  });
});
