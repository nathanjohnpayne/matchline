/**
 * Shared helpers for the `eval:fixed-inputs` tests. No network: the
 * OpenAI mock returns a vector that is a deterministic function of the
 * text alone (a hashed bag of words), so the same text always gets the
 * same vector whatever batch it arrives in, and texts sharing words are
 * similar.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

import type { OpenAIClient as OpenAI } from "../../../functions/src/llm/openai.ts";

import { buildFlowRecord, type FlowRecord } from "../flowRecord.ts";
import { newFlowTrace } from "../flowTrace.ts";
import { loadExpectedMatches, loadExpectedUnits } from "../loadFixtures.ts";
import { FLOWS_FILE } from "../recorder.ts";

export const RESUME = "nathan-2026";
export const JD = "google-compute-spm-2026";
export const CELL = `${RESUME}__${JD}`;
export const DIMS = 64;

/** Hermetic git: no global or system config, no inherited repository. */
export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[k];
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], { env, stdio: ["ignore", "pipe", "pipe"] });
  return dir;
}

/** A unit-length hashed bag-of-words vector: a function of the text only. */
export function textVector(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/u).filter((w) => w.length > 2)) {
    const h = createHash("sha256").update(word).digest();
    v[h[0]! % DIMS]! += 1;
    v[h[1]! % DIMS]! += 0.5;
  }
  v[0]! += 0.01;
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / norm);
}

export function mockOpenAi(): OpenAI & { embeddings: { create: ReturnType<typeof vi.fn> } } {
  return {
    embeddings: {
      create: vi.fn(async ({ input }: { input: string | string[] }) => {
        const inputs = Array.isArray(input) ? input : [input];
        return {
          data: inputs.map((s, index) => ({ embedding: textVector(s), index, object: "embedding" })),
          model: "text-embedding-3-small",
          object: "list",
          usage: { prompt_tokens: inputs.reduce((a, s) => a + Math.ceil(s.length / 4), 0), total_tokens: 0 },
        };
      }),
    },
  } as unknown as OpenAI & { embeddings: { create: ReturnType<typeof vi.fn> } };
}

/**
 * Saved Units for the public nathan cell: the labelled Units reworded
 * slightly (so mapping is non-trivial), minus `dropUnits` of them, with
 * random-looking ids; and the labelled Requirements reworded, minus
 * `dropReqs`, with structure.
 */
export function savedItems(
  sample: number,
  options: { readonly dropUnits?: number; readonly dropReqs?: number } = {},
): { units: Record<string, unknown>[]; requirements: Record<string, unknown>[] } {
  const eu = loadExpectedUnits(RESUME).expected_units;
  const er = loadExpectedMatches(RESUME, JD).expected_requirements;
  const units = eu.slice(options.dropUnits ?? 0).map((e, i) => ({
    id: `unit-${sample}-${i}`,
    owner_uid: "eval-user",
    source_type: "resume",
    source_ref: `resume:abc:${i}`,
    raw_text: e.normalized_summary,
    normalized_summary: i % 3 === 0 ? `${e.normalized_summary} across teams` : e.normalized_summary,
    unit_type: "achievement",
    skills: [...e.skills],
    tools: [...(e.tools ?? [])],
    domains: [...(e.domains ?? [])],
    seniority_signals: i % 2 === 0 ? ["led"] : [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 0.9,
    user_approved: true,
    created_at: "",
    updated_at: "",
  }));
  const requirements = er.slice(options.dropReqs ?? 0).map((q, i) => ({
    id: `req-${sample}-${i}`,
    owner_uid: "eval-user",
    role_id: "eval-role",
    raw_text: q.text,
    normalized_requirement: i % 2 === 0 ? `${q.text} required` : q.text,
    category: q.category,
    keywords: q.text.split(" ").slice(0, 2),
    tools: [],
    domains: [],
    priority: q.must_have ? "high" : "medium",
    must_have: q.must_have,
    extracted_from: "qualifications",
  }));
  return { units, requirements };
}

export function flowFor(
  variant: string,
  invocationId: string,
  sample: number,
  items: ReturnType<typeof savedItems> | null,
  options: { readonly matchAccuracy?: number; readonly matchCount?: number; readonly ok?: boolean } = {},
): FlowRecord {
  const trace = newFlowTrace();
  if (items !== null) {
    trace.units = items.units;
    trace.requirements = items.requirements;
  }
  const ok = options.ok ?? items !== null;
  return buildFlowRecord(
    {
      invocationId,
      variant,
      stages: {},
      embeddingModel: "text-embedding-3-small",
      resumeId: RESUME,
      jdId: JD,
      sampleIndex: sample,
      startedAt: "2026-10-28T00:00:00.000Z",
      finishedAt: "2026-10-28T00:00:01.000Z",
    },
    {
      resumeFixtureId: RESUME,
      jdFixtureId: JD,
      extractionAccuracy: 0.5,
      matchAccuracy: options.matchAccuracy ?? 0,
      latencyMs: 1,
      costUsd: 0,
      modeledCostUsd: 0,
      cacheHits: 0,
      cacheMisses: 0,
      extractedUnitCount: items?.units.length ?? 0,
      parsedRequirementCount: items?.requirements.length ?? 0,
      matchCount: options.matchCount ?? 0,
      ok,
      error: ok ? null : "boom",
    },
    trace,
  );
}

export function writeFlows(dir: string, flows: readonly FlowRecord[]): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FLOWS_FILE), flows.map((f) => `${JSON.stringify(f)}\n`).join(""), "utf8");
  return dir;
}
