import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderResumeInput, type ResumeInput } from "../generation/resumeInput.ts";
import type { ExperienceUnit, JobRequirementUnit } from "../types/capability.ts";
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

function requirement(id: string, text: string, mustHave: boolean): JobRequirementUnit {
  return {
    id,
    owner_uid: "example",
    role_id: "example",
    raw_text: text,
    normalized_requirement: text,
    category: "skill",
    keywords: [],
    tools: [],
    domains: [],
    priority: "high",
    must_have: mustHave,
    extracted_from: "qualifications",
  };
}

const RESUME_UNITS: readonly ExperienceUnit[] = [
  unit("ex-unit-1", {
    raw_text: PLAYBACK_RAW,
    normalized_summary: PLAYBACK_SUMMARY,
    metrics: PLAYBACK_METRICS,
    seniority_signals: ["led"],
    skills: ["memory optimization", "cross-platform playback"],
    domains: ["streaming video"],
    date_range: { start: "2019-03-01", end: "2021-06-30" },
  }),
  unit("ex-unit-2", {
    raw_text: CERT_RAW,
    normalized_summary: CERT_SUMMARY,
    scope_signals: ["Samsung and LG smart TVs"],
    skills: ["device certification"],
    domains: ["streaming video"],
    date_range: { start: "2021-07-01" },
  }),
];

const EXAMPLE_FIXTURE: ResumeInput = {
  units: RESUME_UNITS,
  roleTitle: "Senior Product Manager, Video Infrastructure",
  requirements: [
    requirement("ex-req-1", "Streaming video domain experience", true),
    requirement("ex-req-2", "Connected-TV platform experience", true),
    requirement("ex-req-3", "Has managed a team of 10 or more engineers", false),
  ],
  links: [
    ["ex-unit-1", "ex-req-1"],
    ["ex-unit-2", "ex-req-1"],
    ["ex-unit-2", "ex-req-2"],
  ],
};

interface Item {
  readonly text: string;
  readonly source_unit_ids: readonly string[];
}

describe("resume.v2 few-shot", () => {
  const { system, userFewShot } = sections("generation", "resume.v2.md");
  const example = userFewShot.slice(userFewShot.indexOf("<example>"), userFewShot.indexOf("</example>"));
  const answerText = fences(example.slice(example.indexOf("Correct `record_resume` call:")), "json")[0]!;
  const answer = ResumeGenerationResponseV2Schema.parse(JSON.parse(answerText));
  const items: readonly Item[] = [answer.summary, ...answer.bullets, ...answer.skills, ...(answer.education ?? [])];
  const unitsById = new Map(RESUME_UNITS.map((u) => [u.id, u]));

  it("shows the input exactly as renderResumeInput renders it", () => {
    const lines = example.split("\n");
    const start = lines.indexOf("<input>");
    const end = lines.indexOf("</input>");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, end + 1).join("\n")).toBe(renderResumeInput(EXAMPLE_FIXTURE));
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
