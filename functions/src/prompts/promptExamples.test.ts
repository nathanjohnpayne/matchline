import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../types/capability.ts";
import { formatUnit } from "../validation/unitPromptText.ts";

import { PROMPT_CONFIG } from "./config.ts";
import { parsePromptSections } from "./loader.ts";
import { TraceabilityResponseV2Schema } from "./validation/traceability.v2.schema.ts";

/**
 * The few-shot examples in the v2 prompts are pinned to the code that
 * renders the real input (#485). An example that shows a different
 * format from the real input teaches the model the wrong format, and
 * v1's did: its traceability example printed `metrics: []`, which the
 * formatter never emits.
 */

const promptsRoot = dirname(fileURLToPath(import.meta.url));

function sections(stage: string, file: string) {
  return parsePromptSections(readFileSync(join(promptsRoot, stage, file), "utf8"), file);
}

/** Contents of every fence opened with exactly ```<lang>. */
function fences(text: string, lang: string): string[] {
  const re = new RegExp("^```" + lang + "\\n([\\s\\S]*?)\\n```$", "gm");
  return [...text.matchAll(re)].map((m) => m[1]!);
}

/** Development history must never reach the model. */
const DEV_HISTORY = /#\d{2,}|\bPR\b|Phase \d|Codex|CodeRabbit|cursor|prior version|validator will|pipeline \(/;

function unit(id: string, fields: Partial<ExperienceUnit>): ExperienceUnit {
  return {
    id,
    owner_uid: "example",
    source_type: "resume",
    source_ref: "example",
    raw_text: "",
    normalized_summary: "",
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
    ...fields,
  };
}

const PLAYBACK_RAW =
  "Led the 64-bit migration of the Disney+ playback stack on PS4, PS5 and Xbox; cut memory footprint 30% and shipped to 5M daily active users.";
const PLAYBACK_SUMMARY =
  "Led the 64-bit Disney+ playback migration on PlayStation and Xbox, cutting memory footprint 30% at 5M daily active users.";
const PLAYBACK_METRICS: ExperienceUnit["metrics"] = [
  { claim: "Cut memory footprint 30%", value: 30, unit: "%", direction: "down", confidence: "high" },
  { claim: "Shipped to 5M daily active users", value: 5000000, unit: "users", direction: "up", confidence: "high" },
];
const CERT_RAW = "Owned the device certification pipeline for smart TVs from Samsung and LG.";
const CERT_SUMMARY = "Owned smart-TV device certification for Samsung and LG.";

const TRACEABILITY_UNITS: Record<string, ExperienceUnit> = {
  "unit-a": unit("unit-a", {
    raw_text: PLAYBACK_RAW,
    normalized_summary: PLAYBACK_SUMMARY,
    metrics: PLAYBACK_METRICS,
    seniority_signals: ["led"],
    skills: ["memory optimization", "cross-platform playback"],
    domains: ["streaming video"],
    date_range: { start: "2019-03-01", end: "2021-06-30" },
  }),
  "unit-b": unit("unit-b", {
    raw_text: "Built nightly data pipelines that load partner sales files into the reporting warehouse.",
    normalized_summary: "Built nightly pipelines loading partner sales files into the reporting warehouse.",
    skills: ["Python", "data pipelines"],
    tools: ["Airflow"],
  }),
  "unit-c": unit("unit-c", {
    raw_text: CERT_RAW,
    normalized_summary: CERT_SUMMARY,
    domains: ["streaming video"],
    date_range: { start: "2015-01-01", end: "2021-06-30" },
  }),
};

describe("traceability.v2 few-shot", () => {
  const { system, userFewShot } = sections("validation", "traceability.v2.md");
  const inputs = fences(userFewShot, "text");
  const answers = fences(userFewShot, "json");

  it("has four examples, each with one input and one answer", () => {
    expect(inputs).toHaveLength(4);
    expect(answers).toHaveLength(4);
  });

  it("shows each example Unit exactly as formatUnit renders it", () => {
    const marker = "Candidate Experience Units:\n\n";
    const ids: string[] = [];
    for (const input of inputs) {
      const unitText = input.slice(input.indexOf(marker) + marker.length);
      const id = /^\[Unit ([^\]]+)\]/.exec(unitText)?.[1];
      expect(id, unitText).toBeDefined();
      ids.push(id!);
      expect(unitText).toBe(formatUnit(TRACEABILITY_UNITS[id!]!));
    }
    expect(ids).toEqual(["unit-a", "unit-b", "unit-b", "unit-c"]);
  });

  it("gives answers that pass the v2 schema, with the intended verdicts", () => {
    const verdicts = answers.map((a) => TraceabilityResponseV2Schema.parse(JSON.parse(a)).supports);
    expect(verdicts).toEqual([true, true, false, false]);
  });

  it("keeps development history out of model-visible text", () => {
    expect(`${system}\n${userFewShot}`).not.toMatch(DEV_HISTORY);
  });
});

describe("active prompt versions (#485)", () => {
  it("serves traceability v2", () => {
    expect(PROMPT_CONFIG.validation.traceability).toBe("v2");
  });
});
