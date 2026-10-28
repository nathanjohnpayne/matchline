/**
 * The one copy of the resume.v2 few-shot example's input (#485 review).
 *
 * `../../prompts/generation/resume.v2.md` shows the model an `<input>`
 * block, and two tests pin it to `renderResumeInput`:
 * `../resumeInput.test.ts` and `../../prompts/promptExamples.test.ts`.
 * Both import this fixture and both read the golden from the prompt
 * file (`resumeExampleInputBlock`), so the prompt file is the only
 * golden and no copy can drift from what the model is shown.
 *
 * Test-only: `functions/tsconfig.json` excludes `src/**\/__fixtures__/**`,
 * so this never reaches `lib` or a deploy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePromptSections } from "../../prompts/loader.ts";
import type { ExperienceUnit, JobRequirementUnit } from "../../types/capability.ts";
import type { ResumeInput } from "../resumeInput.ts";

/** An approved Unit with every field the formatter does not render set to a fixed default. */
export function exampleUnit(id: string, fields: Partial<ExperienceUnit>): ExperienceUnit {
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

export function exampleRequirement(id: string, text: string, mustHave: boolean): JobRequirementUnit {
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

export const PLAYBACK_RAW =
  "Led the 64-bit migration of the Disney+ playback stack on PS4, PS5 and Xbox; cut memory footprint 30% and shipped to 5M daily active users.";
export const PLAYBACK_SUMMARY =
  "Led the 64-bit Disney+ playback migration on PlayStation and Xbox, cutting memory footprint 30% at 5M daily active users.";
export const PLAYBACK_METRICS: ExperienceUnit["metrics"] = [
  { claim: "Cut memory footprint 30%", value: 30, unit: "%", direction: "down", confidence: "high" },
  { claim: "Shipped to 5M daily active users", value: 5000000, unit: "users", direction: "up", confidence: "high" },
];
export const CERT_RAW = "Owned the device certification pipeline for smart TVs from Samsung and LG.";
export const CERT_SUMMARY = "Owned smart-TV device certification for Samsung and LG.";

export const RESUME_EXAMPLE_UNITS: readonly ExperienceUnit[] = [
  exampleUnit("ex-unit-1", {
    raw_text: PLAYBACK_RAW,
    normalized_summary: PLAYBACK_SUMMARY,
    metrics: PLAYBACK_METRICS,
    seniority_signals: ["led"],
    skills: ["memory optimization", "cross-platform playback"],
    domains: ["streaming video"],
    date_range: { start: "2019-03-01", end: "2021-06-30" },
  }),
  exampleUnit("ex-unit-2", {
    raw_text: CERT_RAW,
    normalized_summary: CERT_SUMMARY,
    scope_signals: ["Samsung and LG smart TVs"],
    skills: ["device certification"],
    domains: ["streaming video"],
    date_range: { start: "2021-07-01" },
  }),
];

/** The input the resume.v2 example shows, before rendering. */
export const RESUME_EXAMPLE_INPUT: ResumeInput = {
  units: RESUME_EXAMPLE_UNITS,
  roleTitle: "Senior Product Manager, Video Infrastructure",
  requirements: [
    exampleRequirement("ex-req-1", "Streaming video domain experience", true),
    exampleRequirement("ex-req-2", "Connected-TV platform experience", true),
    exampleRequirement("ex-req-3", "Has managed a team of 10 or more engineers", false),
  ],
  links: [
    ["ex-unit-1", "ex-req-1"],
    ["ex-unit-2", "ex-req-1"],
    ["ex-unit-2", "ex-req-2"],
  ],
};

/** The resume.v2 prompt's model-visible sections, read from the prompt file. */
export function resumeV2Sections() {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "generation", "resume.v2.md");
  return parsePromptSections(readFileSync(file, "utf8"), "resume.v2.md");
}

/** The text of the resume.v2 example, from `<example>` up to `</example>`. */
export function resumeExampleText(): string {
  const { userFewShot } = resumeV2Sections();
  return userFewShot.slice(userFewShot.indexOf("<example>"), userFewShot.indexOf("</example>"));
}

/**
 * The example's `<input>` block, from the `<input>` line through the
 * `</input>` line, exactly as the prompt file shows it. The golden for
 * `renderResumeInput(RESUME_EXAMPLE_INPUT)`. Throws when the prompt has
 * no such block, so a test cannot pass against an empty golden.
 */
export function resumeExampleInputBlock(): string {
  const lines = resumeExampleText().split("\n");
  const start = lines.indexOf("<input>");
  const end = lines.indexOf("</input>");
  if (start < 0 || end < start) throw new Error("resume.v2.md example has no <input> block");
  return lines.slice(start, end + 1).join("\n");
}
