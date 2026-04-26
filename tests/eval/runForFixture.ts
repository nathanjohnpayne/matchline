/**
 * Per-fixture orchestrator (#136).
 *
 *   resume.txt + jd.txt + expected-units.json + expected-matches.json
 *     → extractFromResume     (Anthropic, in-memory)
 *     → embedMany on Units    (OpenAI, in-memory)
 *     → parseJobRequirements  (Anthropic, in-memory)
 *     → embedMany on Reqs     (OpenAI, in-memory)
 *     → mapUnitIds            (runtime UUID → mnemonic)
 *     → mapRequirementIds     (runtime UUID → mnemonic)
 *     → runMatchingPipeline   (in-memory; no Firestore persist)
 *     → unitSetAccuracy       (extraction score)
 *     → topKOverlap           (match score)
 *     → FixtureResult
 *
 * No Firestore reads/writes — the matching pipeline's
 * `listUnits`, `listRequirements`, and `persistBatch` deps
 * are all overridden so the orchestrator runs purely
 * in-memory. This is the eval-side flow; production reads
 * from Firestore via the same pipeline with default deps.
 *
 * The orchestrator is dep-injectable: real Anthropic +
 * OpenAI clients in the production CLI run, mocked clients
 * in `runForFixture.test.ts`.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

import { extractFromResume } from "../../functions/src/extraction/resume.ts";
import { embedMany } from "../../functions/src/llm/embeddings.ts";
import { runMatchingPipeline } from "../../functions/src/matching/pipeline.ts";
import { parseJobRequirements } from "../../functions/src/parsing/jd.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../functions/src/types/capability.ts";

import {
  loadExpectedMatches,
  loadExpectedUnits,
  loadJdText,
  loadResumeText,
  type ExpectedMatchesFile,
  type ExpectedUnitFile,
  type FixturePaths,
} from "./loadFixtures.ts";
import { compositeIdsFromMatches, mapRequirementIds, mapUnitIds } from "./mapping.ts";
import { topKOverlap, unitSetAccuracy } from "./scoring.ts";

const EVAL_OWNER_UID = "eval-user";
const EVAL_ROLE_ID = "eval-role";

export interface RunForFixtureDeps {
  /** Anthropic client used by extraction + parsing. */
  readonly anthropicClient: Anthropic;
  /** OpenAI client used by embedding. */
  readonly openaiClient: OpenAI;
  /** Override fixture root for tests. */
  readonly fixturePaths?: FixturePaths;
  /**
   * Override the matching pipeline's persistBatch (defaults
   * to a no-op that just returns the input matches — see
   * pipeline.ts's persistBatch fallback). Tests may want to
   * inspect the call.
   */
  readonly persistBatch?: (
    ctx: { ownerUid: string; roleId: string },
    matches: readonly UnitMatch[],
  ) => Promise<readonly UnitMatch[] | void>;
}

export interface RunForFixtureInput {
  readonly resumeFixtureId: string;
  readonly jdFixtureId: string;
}

export interface RunForFixtureResult {
  readonly resumeFixtureId: string;
  readonly jdFixtureId: string;
  /** Extraction accuracy in [0, 1] from `unitSetAccuracy`. */
  readonly extractionAccuracy: number;
  /** Match accuracy in [0, 1] from `topKOverlap` against expected. */
  readonly matchAccuracy: number;
  /** End-to-end orchestration latency. */
  readonly latencyMs: number;
  /**
   * Cost telemetry is collected via `recordUsage` writes
   * by the underlying pipelines. The eval harness's run.ts
   * reads aggregated usage separately; per-fixture cost is
   * not easily attributable without restructuring
   * `recordUsage` to return a value, so this is null at the
   * orchestrator level. Future enhancement: thread a
   * per-fixture accumulator through the pipelines.
   */
  readonly costUsd: number | null;
  /** Counts for the report. */
  readonly extractedUnitCount: number;
  readonly parsedRequirementCount: number;
  readonly matchCount: number;
  /** True iff the harness completed without throwing. */
  readonly ok: boolean;
  /** Error message if the run threw (null on success). */
  readonly error: string | null;
}

/**
 * Run a single (resume × JD) eval. Returns the per-fixture
 * result the harness aggregates across the corpus. Always
 * returns — errors are captured into `error` rather than
 * propagated, so one bad fixture doesn't abort the corpus
 * run. Failed fixtures contribute 0 to the corpus mean
 * (intentional — bad fixtures should drag the score down,
 * not be silently skipped).
 */
export async function runForFixture(
  input: RunForFixtureInput,
  deps: RunForFixtureDeps,
): Promise<RunForFixtureResult> {
  const start = Date.now();
  try {
    return await runForFixtureInner(input, deps, start);
  } catch (err) {
    return {
      resumeFixtureId: input.resumeFixtureId,
      jdFixtureId: input.jdFixtureId,
      extractionAccuracy: 0,
      matchAccuracy: 0,
      latencyMs: Date.now() - start,
      costUsd: null,
      extractedUnitCount: 0,
      parsedRequirementCount: 0,
      matchCount: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runForFixtureInner(
  input: RunForFixtureInput,
  deps: RunForFixtureDeps,
  start: number,
): Promise<RunForFixtureResult> {
  // 1. Load fixtures.
  const resumeText = loadResumeText(input.resumeFixtureId, deps.fixturePaths);
  const jdText = loadJdText(input.jdFixtureId, deps.fixturePaths);
  const expectedUnitsFile: ExpectedUnitFile = loadExpectedUnits(
    input.resumeFixtureId,
    deps.fixturePaths,
  );
  const expectedMatchesFile: ExpectedMatchesFile = loadExpectedMatches(
    input.resumeFixtureId,
    input.jdFixtureId,
    deps.fixturePaths,
  );

  // 2. Extract Units (Anthropic).
  const extractedUnits = await extractFromResume(
    resumeText,
    { ownerUid: EVAL_OWNER_UID },
    {
      client: deps.anthropicClient,
      record: async () => 0,
    },
  );

  // 3. Embed Units (OpenAI). Attach embedding to each Unit
  //    in-place so the matching pipeline's filter for
  //    !reembed_pending sees populated embeddings.
  const unitTexts = extractedUnits.map((u) => u.normalized_summary);
  const unitEmbeddings = await embedMany(unitTexts, {
    client: deps.openaiClient,
    record: async () => 0,
    ownerUid: EVAL_OWNER_UID,
  });
  const embeddedUnits: ExperienceUnit[] = extractedUnits.map((u, idx) => ({
    ...u,
    embedding: unitEmbeddings[idx],
  }));

  // 4. Parse Requirements (Anthropic).
  const parsedRequirements = await parseJobRequirements(
    jdText,
    { ownerUid: EVAL_OWNER_UID, roleId: EVAL_ROLE_ID },
    {
      client: deps.anthropicClient,
      record: async () => 0,
    },
  );

  // 5. Embed Requirements (OpenAI).
  const reqTexts = parsedRequirements.map((r) => r.normalized_requirement);
  const reqEmbeddings = await embedMany(reqTexts, {
    client: deps.openaiClient,
    record: async () => 0,
    ownerUid: EVAL_OWNER_UID,
  });
  const embeddedReqs: JobRequirementUnit[] = parsedRequirements.map((r, idx) => ({
    ...r,
    embedding: reqEmbeddings[idx],
  }));

  // 6. Run matching with in-memory deps (no Firestore).
  const matches = await runMatchingPipeline(
    { ownerUid: EVAL_OWNER_UID, roleId: EVAL_ROLE_ID },
    {
      listUnits: async () => embeddedUnits,
      listRequirements: async () => embeddedReqs,
      persistBatch: deps.persistBatch ?? (async (_ctx, m) => m),
    },
  );

  // 7. Score extraction. unitSetAccuracy uses
  //    `normalizedSummary` + `skills`; convert our shapes.
  const extractionAccuracy = unitSetAccuracy(
    expectedUnitsFile.expected_units.map((e) => ({
      normalizedSummary: e.normalized_summary,
      skills: e.skills,
    })),
    embeddedUnits.map((u) => ({
      normalizedSummary: u.normalized_summary,
      skills: u.skills,
    })),
  );

  // 8. Score matches. Build mnemonic-ID maps; convert
  //    actual matches to composite strings; topKOverlap.
  const expectedRequirements = expectedMatchesFile.expected_requirements ?? [];
  const unitMap = mapUnitIds(expectedUnitsFile.expected_units, embeddedUnits);
  const reqMap = mapRequirementIds(expectedRequirements, embeddedReqs);
  const actualComposite = compositeIdsFromMatches(matches, unitMap, reqMap);
  const matchAccuracy = topKOverlap(
    expectedMatchesFile.expected_top_matches,
    actualComposite,
    expectedMatchesFile.k,
  );

  return {
    resumeFixtureId: input.resumeFixtureId,
    jdFixtureId: input.jdFixtureId,
    extractionAccuracy,
    matchAccuracy,
    latencyMs: Date.now() - start,
    costUsd: null,
    extractedUnitCount: embeddedUnits.length,
    parsedRequirementCount: embeddedReqs.length,
    matchCount: matches.length,
    ok: true,
    error: null,
  };
}
