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
 *     propagate; result.ok=false, result.error populated
 *     (string), accuracies clamped to 0. Partial cost is
 *     SURFACED (cursor #139 r2 + CR Major: zeroing cost
 *     on failure hides real spend during flaky runs).
 *   - Cost is accumulated via the closure-bound `priceFor`
 *     recorder (cursor #139 r1); the prior null-shape was
 *     replaced — `costUsd` is now `number` always.
 *
 * The fixtures used are read from `tests/fixtures/` (the
 * real Nathan + Google pair). The test mocks return shapes
 * derived from the labeler's expected_units so the mapping
 * layer's content matching exercises actual prose.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnthropicClient as Anthropic } from "../../functions/src/llm/anthropic.ts";
import { modelFor } from "../../functions/src/llm/config.ts";
import { priceFor } from "../../functions/src/llm/cost.ts";
import type { OpenAIClient as OpenAI } from "../../functions/src/llm/openai.ts";

import { StageCache } from "./cache.ts";
import { describeError, promptFingerprint, runForFixture } from "./runForFixture.ts";

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

describe("promptFingerprint", () => {
  // Codex P1 round 3: keying on the version string alone meant
  // editing a prompt file IN PLACE — exactly what prompt tuning does,
  // and what #177 workstream B is — left the key unchanged. The cache
  // then served extraction from the PREVIOUS prompt while the report
  // claimed to evaluate the new one, so a tuning session would draw
  // conclusions from stale output and never notice.
  it("includes the resolved version", () => {
    expect(promptFingerprint("extraction", "resume")).toMatch(/^v1:/);
  });

  it("appends a hash of the prompt contents", () => {
    const fp = promptFingerprint("extraction", "resume");
    expect(fp).toMatch(/^v1:[0-9a-f]{16}$/);
  });

  it("is stable across calls for unchanged content", () => {
    expect(promptFingerprint("extraction", "resume")).toBe(
      promptFingerprint("extraction", "resume"),
    );
  });

  it("differs between prompts", () => {
    expect(promptFingerprint("extraction", "resume")).not.toBe(
      promptFingerprint("parsing", "jd"),
    );
  });

  // Codex P2 round 4. The section boundary must be forgeable by
  // neither section's content. Joining on a raw NUL was not: with
  // `system + NUL + fewShot`, the pairs below both serialize to
  // `a\u0000b\u0000c` and collide, so two prompts that render
  // differently to the model shared one cache key — a hole in exactly
  // what promptFingerprint exists to close.
  //
  // Asserted against the encoding directly rather than through
  // `promptFingerprint`, because reproducing it end-to-end would mean
  // writing NUL bytes into the real prompt files on disk.
  it("uses an encoding no section content can forge a boundary in", () => {
    const encode = (system: string, fewShot: string): string =>
      JSON.stringify([system, fewShot]);

    expect(encode("a\u0000b", "c")).not.toBe(encode("a", "b\u0000c"));
    // The naive form these two defeat:
    const naive = (s: string, f: string): string => `${s}\u0000${f}`;
    expect(naive("a\u0000b", "c")).toBe(naive("a", "b\u0000c"));

    // The quote and backslash JSON uses as delimiters are escaped, so
    // they cannot forge a boundary either.
    expect(encode('a"b', "c")).not.toBe(encode("a", 'b"c'));
    expect(encode("a\\", "b")).not.toBe(encode("a", "\\b"));
  });
});

describe("describeError", () => {
  it("appends the first attempt's cause to a retry-loop summary", () => {
    // "Extraction failed after 3 attempts. See .failures for
    // per-attempt detail" is useless in a report — `.failures` is
    // exactly where the cause lives and the report never showed it.
    const err = Object.assign(
      new Error("Extraction failed after 3 attempts. See .failures for per-attempt detail."),
      {
        failures: [
          { attempt: 0, kind: "transport_error", message: "ANTHROPIC_API_KEY is not set" },
          { attempt: 1, kind: "transport_error", message: "second attempt" },
        ],
      },
    );
    const described = describeError(err);
    expect(described).toContain("Extraction failed after 3 attempts");
    expect(described).toContain("transport_error");
    expect(described).toContain("ANTHROPIC_API_KEY is not set");
    // Only the FIRST failure — three near-identical retries would
    // bury the message they exist to surface.
    expect(described).not.toContain("second attempt");
  });

  it("passes a plain error through unchanged", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  // Codex P2: `null` and `undefined` are legal throw values, and a
  // bare property access on either raises a fresh TypeError — which
  // would escape runForFixture's catch and abort the entire corpus,
  // breaking its documented always-return contract.
  it.each([[null], [undefined], [42], [Symbol("s")]])(
    "does not throw on the non-object throw value %s",
    (thrown) => {
      expect(() => describeError(thrown)).not.toThrow();
    },
  );

  it("handles non-Error throws and malformed failure arrays", () => {
    expect(describeError("a string")).toBe("a string");
    expect(describeError(Object.assign(new Error("x"), { failures: [] }))).toBe("x");
    expect(
      describeError(Object.assign(new Error("x"), { failures: [{ attempt: 0 }] })),
    ).toBe("x");
  });
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

  it("anthropicIsMetered=false: costUsd excludes Anthropic usage, modeledCostUsd does not", async () => {
    // Codex P2: a subscription-backed `claude-cli` token source was
    // priced into `costUsd` exactly like a real API call. Same
    // extraction/parsing responses as the HAPPY PATH test above (2
    // Units, 2 Requirements — 100/50 mock Anthropic token counts per
    // call), run twice: once metered (default), once not.
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
      ],
    };
    const input = {
      resumeFixtureId: "nathan-2026",
      jdFixtureId: "google-compute-spm-2026",
    };

    const metered = await runForFixture(input, {
      anthropicClient: makeMockAnthropic([extractionResp, parsingResp]),
      openaiClient: makeMockOpenAi(),
      // anthropicIsMetered omitted — defaults to true.
    });
    const unmetered = await runForFixture(input, {
      anthropicClient: makeMockAnthropic([extractionResp, parsingResp]),
      openaiClient: makeMockOpenAi(),
      anthropicIsMetered: false,
    });

    expect(metered.ok).toBe(true);
    expect(unmetered.ok).toBe(true);
    // Both runs modeled identical usage, so modeledCostUsd must match
    // regardless of which billing source actually paid for it.
    expect(unmetered.modeledCostUsd).toBeCloseTo(metered.modeledCostUsd, 12);
    // costUsd must drop by exactly the Anthropic-priced portion — only
    // the OpenAI embeddings remain real spend.
    //
    // CodeRabbit: `toBeLessThan` alone did not enforce the invariant
    // the comment claims. A partial-exclusion regression — dropping
    // extraction's usage but still pricing the JD parse — decreases the
    // cost and keeps it positive, so it satisfied both old assertions.
    // Pin the delta instead.
    //
    // The two Anthropic stages run on DIFFERENT default models
    // (extraction on Sonnet, requirement_parsing on Haiku), so the
    // expected delta is their sum, not one price doubled. Both are
    // resolved through `modelFor` rather than hardcoded, so a config.ts
    // model change updates the expectation instead of reddening this
    // test for the wrong reason.
    const anthropicTokens = { inputTokens: 100, outputTokens: 50 };
    const expectedAnthropicCost =
      priceFor(modelFor("extraction").model, anthropicTokens) +
      priceFor(modelFor("requirement_parsing").model, anthropicTokens);
    expect(metered.costUsd - unmetered.costUsd).toBeCloseTo(expectedAnthropicCost, 12);
    // The embeddings are still metered, so what remains is exactly them.
    expect(unmetered.costUsd).toBeGreaterThan(0);
    expect(unmetered.costUsd).toBeCloseTo(metered.costUsd - expectedAnthropicCost, 12);
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
    // Tighter than `toBeDefined()` — `null` would pass
    // toBeDefined too. Force the failure path to populate
    // a real string error message. (CR Minor on #139 r1.)
    expect(typeof result.error).toBe("string");
    expect((result.error as string).length).toBeGreaterThan(0);
    expect(result.extractionAccuracy).toBe(0);
    expect(result.matchAccuracy).toBe(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    // Failure path: extraction was the FIRST API call and
    // it threw immediately, so no tokens were consumed.
    // Cost = 0 in this scenario. The under-reporting fix
    // (cursor #139 r2 + CR Major) preserves PARTIAL cost
    // when a later step throws — pinned by a separate
    // test below.
    expect(result.costUsd).toBe(0);
  });

  it("PARTIAL COST ON FAILURE (cursor #139 r2 + CR Major): a throw AFTER successful API calls surfaces the real partial cost, not 0", async () => {
    // The load-bearing pin. Extraction succeeds (consumes
    // real tokens), then parsing throws. The prior shape
    // zeroed cost on the failure path, hiding the spend.
    // The fix lifts costAccum to outer scope so the catch
    // sees the partial accumulation.
    let call = 0;
    const mixedAnthropic = {
      messages: {
        create: vi.fn(async () => {
          call += 1;
          if (call === 1) {
            // First call (extraction) — succeeds with real tokens.
            return {
              id: "x",
              type: "message",
              role: "assistant",
              model: "claude-haiku-4-5-20251001",
              content: [
                {
                  type: "tool_use",
                  id: "x",
                  name: "tool",
                  input: {
                    units: [
                      {
                        raw_text: "x",
                        normalized_summary: "y",
                        unit_type: "project",
                        skills: [],
                        tools: [],
                        domains: [],
                        seniority_signals: [],
                        scope_signals: [],
                        business_outcomes: [],
                        metrics: [],
                        evidence_type: "verified",
                        confidence_score: 0.9,
                      },
                    ],
                  },
                },
              ],
              stop_reason: "tool_use",
              stop_sequence: null,
              // Real-looking token counts so priceFor produces non-zero.
              usage: { input_tokens: 5000, output_tokens: 2000 },
            };
          }
          // Second + third calls (parsing retries) — throw.
          // The retry budget is 3, so we throw on every
          // subsequent attempt to exhaust it.
          throw new Error("Parsing transport error");
        }),
      },
    } as unknown as Anthropic;

    const result = await runForFixture(
      {
        resumeFixtureId: "nathan-2026",
        jdFixtureId: "google-compute-spm-2026",
      },
      {
        anthropicClient: mixedAnthropic,
        openaiClient: makeMockOpenAi(),
      },
    );

    expect(result.ok).toBe(false);
    // The load-bearing assertion: cost is NON-ZERO because
    // extraction consumed real tokens before parsing threw.
    // Without the partial-cost fix this would be 0.
    expect(result.costUsd).toBeGreaterThan(0);
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

  it("EMPTY EXTRACTION + EMPTY REQUIREMENTS: orchestration completes with ok=true, no crash, zero/low accuracy", async () => {
    // CodeRabbit Nitpick on PR #139: pin the no-crash contract for
    // the empty-pipeline case. If extraction and parsing both
    // return valid-shape responses but with zero items, the
    // orchestrator should:
    //   - not throw,
    //   - produce a well-formed result shape (ok=true),
    //   - report extracted=0 / parsed=0 counts,
    //   - clamp both accuracies to a sane numeric range (0..1),
    //   - still surface non-negative cost from the API calls.
    // Without this pin, a regression that crashed on empty arrays
    // (e.g., a `.reduce` without an initial value, or a `[0]!`
    // bang) wouldn't surface in CI until a real fixture happened
    // to extract nothing.
    const emptyExtraction = { units: [] };
    const emptyParsing = { requirements: [] };

    const result = await runForFixture(
      {
        resumeFixtureId: "nathan-2026",
        jdFixtureId: "google-compute-spm-2026",
      },
      {
        anthropicClient: makeMockAnthropic([emptyExtraction, emptyParsing]),
        openaiClient: makeMockOpenAi(),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.extractedUnitCount).toBe(0);
    expect(result.parsedRequirementCount).toBe(0);
    expect(result.extractionAccuracy).toBeGreaterThanOrEqual(0);
    expect(result.extractionAccuracy).toBeLessThanOrEqual(1);
    expect(result.matchAccuracy).toBeGreaterThanOrEqual(0);
    expect(result.matchAccuracy).toBeLessThanOrEqual(1);
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });

  // -- Stage cache (#389) ---------------------------------------------------

  describe("stage cache", () => {
    let cacheDir: string;

    beforeEach(() => {
      cacheDir = mkdtempSync(join(tmpdir(), "matchline-rff-cache-"));
    });

    afterEach(() => {
      rmSync(cacheDir, { recursive: true, force: true });
    });

    function fixtureResponses() {
      return {
        extraction: {
          units: [
            {
              raw_text: "Led the Disney+ playback migration to a new CDN",
              normalized_summary:
                "Led a streaming-video playback migration to a new CDN.",
              unit_type: "project",
              skills: ["streaming video infrastructure"],
              tools: ["CDN"],
              domains: ["streaming"],
              seniority_signals: ["led"],
              scope_signals: ["40M users"],
              business_outcomes: ["reduced rebuffer rate"],
              metrics: [],
              evidence_type: "verified",
              confidence_score: 0.9,
            },
          ],
        },
        parsing: {
          requirements: [
            {
              raw_text: "Experience with large-scale distributed systems",
              normalized_requirement:
                "Experience with large-scale distributed systems",
              category: "skill",
              keywords: ["distributed systems"],
              tools: [],
              domains: [],
              priority: "high",
              must_have: true,
              extracted_from: "qualifications",
            },
          ],
        },
      };
    }

    /**
     * The #389 acceptance criterion: once the cache is warm, a
     * re-run of the same fixture must issue ZERO LLM calls. This is
     * what makes matching-layer tuning (#177 workstream A, score
     * weights, ontology coverage) free — matching itself has no LLM
     * in its path, so with the upstream stages cached the whole
     * re-run is offline.
     */
    it("warm re-run issues zero Anthropic and zero OpenAI calls", async () => {
      const { extraction, parsing } = fixtureResponses();
      const cache = new StageCache({ dir: cacheDir });
      const input = {
        resumeFixtureId: "nathan-2026",
        jdFixtureId: "google-compute-spm-2026",
      };

      const coldAnthropic = makeMockAnthropic([extraction, parsing]);
      const coldOpenai = makeMockOpenAi();
      const cold = await runForFixture(input, {
        anthropicClient: coldAnthropic,
        openaiClient: coldOpenai,
        cache,
      });

      // Surface the pipeline error rather than a bare `false !== true`
      // if the mock shapes ever drift out of schema.
      expect(cold.error).toBeNull();
      expect(cold.ok).toBe(true);
      expect(cold.cacheMisses).toBe(4); // extraction, unit-embed, parsing, req-embed
      expect(cold.cacheHits).toBe(0);
      expect(cold.costUsd).toBeGreaterThan(0);

      // Fresh clients: any call at all will show up here.
      const warmAnthropic = makeMockAnthropic([extraction, parsing]);
      const warmOpenai = makeMockOpenAi();
      const warm = await runForFixture(input, {
        anthropicClient: warmAnthropic,
        openaiClient: warmOpenai,
        cache: new StageCache({ dir: cacheDir }),
      });

      expect(warm.ok).toBe(true);
      expect(warm.cacheHits).toBe(4);
      expect(warm.cacheMisses).toBe(0);

      // The acceptance assertions.
      expect(warmAnthropic.messages.create).not.toHaveBeenCalled();
      expect(warmOpenai.embeddings.create).not.toHaveBeenCalled();
      expect(warm.costUsd).toBe(0);
    });

    it("warm re-run reproduces the same accuracies and modeled cost", async () => {
      const { extraction, parsing } = fixtureResponses();
      const input = {
        resumeFixtureId: "nathan-2026",
        jdFixtureId: "google-compute-spm-2026",
      };

      const cold = await runForFixture(input, {
        anthropicClient: makeMockAnthropic([extraction, parsing]),
        openaiClient: makeMockOpenAi(),
        cache: new StageCache({ dir: cacheDir }),
      });
      const warm = await runForFixture(input, {
        anthropicClient: makeMockAnthropic([extraction, parsing]),
        openaiClient: makeMockOpenAi(),
        cache: new StageCache({ dir: cacheDir }),
      });

      // Determinism: caching must not change what the harness measures.
      expect(warm.extractionAccuracy).toBe(cold.extractionAccuracy);
      expect(warm.matchAccuracy).toBe(cold.matchAccuracy);
      expect(warm.extractedUnitCount).toBe(cold.extractedUnitCount);
      expect(warm.matchCount).toBe(cold.matchCount);

      // Real spend collapses to zero...
      expect(cold.costUsd).toBeGreaterThan(0);
      expect(warm.costUsd).toBe(0);
      // ...but the number the model sweep ranks on does NOT move.
      expect(warm.modeledCostUsd).toBeCloseTo(cold.modeledCostUsd, 12);
      expect(warm.modeledCostUsd).toBeGreaterThan(0);
    });

    it("switching token source re-runs the LLM stages but reuses embeddings", async () => {
      // CodeRabbit P1: the token-source discriminator used to be folded
      // into all four stage keys, embeddings included. Embeddings always
      // call OpenAI, and their token-source dependence already arrives
      // via `input` (the upstream Units / Requirements), so
      // discriminating them could never prevent a wrong hit — it could
      // only force a miss and re-pay OpenAI for identical vectors on
      // every `--token-source` flip. This repo runs under a hard
      // monthly OpenAI ceiling, so that is real money.
      const { extraction, parsing } = fixtureResponses();
      const input = {
        resumeFixtureId: "nathan-2026",
        jdFixtureId: "google-compute-spm-2026",
      };

      const cli = await runForFixture(input, {
        anthropicClient: makeMockAnthropic([extraction, parsing]),
        openaiClient: makeMockOpenAi(),
        cache: new StageCache({ dir: cacheDir }),
        cacheDiscriminators: { tokenSource: "claude-cli" },
      });
      expect(cli.ok).toBe(true);
      expect(cli.cacheMisses).toBe(4);

      // Same corpus, same upstream mock output, metered-API keyspace.
      const apiAnthropic = makeMockAnthropic([extraction, parsing]);
      const apiOpenai = makeMockOpenAi();
      const api = await runForFixture(input, {
        anthropicClient: apiAnthropic,
        openaiClient: apiOpenai,
        cache: new StageCache({ dir: cacheDir }),
      });

      expect(api.ok).toBe(true);
      // The two Anthropic stages are genuinely a different keyspace and
      // must re-run — separating them is the point of the sweep.
      expect(apiAnthropic.messages.create).toHaveBeenCalledTimes(2);
      // The two embedding stages must NOT.
      expect(apiOpenai.embeddings.create).not.toHaveBeenCalled();
      expect(api.cacheMisses).toBe(2);
      expect(api.cacheHits).toBe(2);
    });

    /**
     * The mechanism behind the 10× saving on #137's 10×10 corpus:
     * extraction is keyed on the resume ALONE and JD parsing on the
     * JD ALONE, so N resumes × M JDs needs N extractions and M
     * parses rather than N×M of each.
     *
     * This is asserted structurally (one entry per distinct input,
     * in its own stage namespace) rather than by running two cells
     * that share a JD — today's 4 labeled cells each use a distinct
     * resume AND a distinct JD, so no such pair exists yet. The
     * cross-key sharing itself is pinned in `cache.test.ts`
     * ("leaves sibling stages warm when one stage's key changes").
     */
    it("writes one entry per stage, namespaced by stage", async () => {
      const { extraction, parsing } = fixtureResponses();
      await runForFixture(
        { resumeFixtureId: "nathan-2026", jdFixtureId: "google-compute-spm-2026" },
        {
          anthropicClient: makeMockAnthropic([extraction, parsing]),
          openaiClient: makeMockOpenAi(),
          cache: new StageCache({ dir: cacheDir }),
        },
      );

      const entriesIn = (stage: string): string[] =>
        existsSync(join(cacheDir, stage)) ? readdirSync(join(cacheDir, stage)) : [];

      // One extraction keyed on the resume text.
      expect(entriesIn("extraction")).toHaveLength(1);
      // One JD parse keyed on the JD text — untouched by a resume change.
      expect(entriesIn("requirement_parsing")).toHaveLength(1);
      // Two embedding entries: one for the Unit texts, one for the
      // Requirement texts.
      expect(entriesIn("embedding")).toHaveLength(2);
    });
  });
});
