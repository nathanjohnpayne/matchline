import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CERT_RAW,
  CERT_SUMMARY,
  PLAYBACK_METRICS,
  PLAYBACK_RAW,
  PLAYBACK_SUMMARY,
  RESUME_EXAMPLE_INPUT,
  RESUME_EXAMPLE_UNITS,
  exampleUnit,
  resumeExampleInputBlock,
  resumeExampleText,
  resumeV2Sections,
} from "../generation/__fixtures__/resumeExample.ts";
import { renderResumeInput } from "../generation/resumeInput.ts";
import type { ExperienceUnit } from "../types/capability.ts";
import { formatUnit } from "../validation/unitPromptText.ts";

import { PROMPT_CONFIG } from "./config.ts";
import { ResumeGenerationResponseV2Schema } from "./generation/resume.v2.schema.ts";
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

const TRACEABILITY_UNITS: Record<string, ExperienceUnit> = {
  "unit-a": exampleUnit("unit-a", {
    raw_text: PLAYBACK_RAW,
    normalized_summary: PLAYBACK_SUMMARY,
    metrics: PLAYBACK_METRICS,
    seniority_signals: ["led"],
    skills: ["memory optimization", "cross-platform playback"],
    domains: ["streaming video"],
    date_range: { start: "2019-03-01", end: "2021-06-30" },
  }),
  "unit-b": exampleUnit("unit-b", {
    raw_text: "Built nightly data pipelines that load partner sales files into the reporting warehouse.",
    normalized_summary: "Built nightly pipelines loading partner sales files into the reporting warehouse.",
    skills: ["Python", "data pipelines"],
    tools: ["Airflow"],
  }),
  "unit-c": exampleUnit("unit-c", {
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

interface Item {
  readonly text: string;
  readonly source_unit_ids: readonly string[];
}

describe("resume.v2 few-shot", () => {
  const { system, userFewShot } = resumeV2Sections();
  const example = resumeExampleText();
  const answerText = fences(example.slice(example.indexOf("Correct `record_resume` call:")), "json")[0]!;
  const answer = ResumeGenerationResponseV2Schema.parse(JSON.parse(answerText));
  const items: readonly Item[] = [answer.summary, ...answer.bullets, ...answer.skills, ...(answer.education ?? [])];
  const unitsById = new Map(RESUME_EXAMPLE_UNITS.map((u) => [u.id, u]));

  it("shows the input exactly as renderResumeInput renders it", () => {
    expect(resumeExampleInputBlock()).toBe(renderResumeInput(RESUME_EXAMPLE_INPUT));
  });

  it("cites only the example's Unit ids", () => {
    for (const item of items) {
      for (const id of item.source_unit_ids) expect(["ex-unit-1", "ex-unit-2"]).toContain(id);
    }
  });

  it("repeats each skill as a tag of every Unit it cites", () => {
    for (const skill of answer.skills) {
      for (const id of skill.source_unit_ids) {
        const u = unitsById.get(id)!;
        const tags = [...u.skills, ...u.tools, ...u.domains].map((t) => t.toLowerCase());
        expect(tags, `${skill.text} / ${id}`).toContain(skill.text.toLowerCase());
      }
    }
  });

  it("writes a summary of one to three sentences", () => {
    const sentences = answer.summary.text.split(/(?<=[.!?])\s+/).filter((p) => p.length > 0);
    expect(sentences.length).toBeGreaterThanOrEqual(1);
    expect(sentences.length).toBeLessThanOrEqual(3);
  });

  it("takes no title, seniority, role wording or tenure from the target role", () => {
    for (const item of items) {
      expect(item.text).not.toMatch(/product manager|senior|connected-tv|video infrastructure|\b\d+\+?\s*years?\b/i);
    }
  });

  it("states only numbers its cited Units state", () => {
    for (const item of items) {
      const evidence = item.source_unit_ids.map((id) => formatUnit(unitsById.get(id)!)).join("\n");
      for (const n of item.text.match(/\d+(?:\.\d+)?/g) ?? []) {
        expect(evidence, `${n} in "${item.text}"`).toContain(n);
      }
    }
  });

  it("keeps each bullet to about 200 characters", () => {
    for (const b of answer.bullets) expect(b.text.length).toBeLessThanOrEqual(200);
  });

  it("keeps development history out of model-visible text", () => {
    expect(`${system}\n${userFewShot}`).not.toMatch(DEV_HISTORY);
  });
});

describe("active prompt versions (#485)", () => {
  it("serves traceability v2", () => {
    expect(PROMPT_CONFIG.validation.traceability).toBe("v2");
  });

  it("serves resume generation v2", () => {
    expect(PROMPT_CONFIG.generation.resume).toBe("v2");
  });
});
