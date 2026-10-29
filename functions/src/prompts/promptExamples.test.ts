import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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
import { renderTraceabilityInput } from "../validation/traceability.ts";
import { formatUnit } from "../validation/unitPromptText.ts";

import { PROMPT_CONFIG } from "./config.ts";
import { ResumeGenerationResponseV2Schema } from "./generation/resume.v2.schema.ts";
import { clearPromptVersionOverrides, loadPromptText, parsePromptSections, setPromptVersionOverrides } from "./loader.ts";
import { ParsedRequirementV2Schema, JdParsingResponseV2Schema } from "./parsing/jd.v2.schema.ts";
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
  "unit-e": exampleUnit("unit-e", {
    raw_text: "Ran the weekly release review for the mobile apps and set the rollout schedule.",
    normalized_summary: "Ran the weekly mobile release review and set the rollout schedule.",
    seniority_signals: ["led"],
    scope_signals: ["4 mobile teams"],
  }),
  "unit-c": exampleUnit("unit-c", {
    raw_text: CERT_RAW,
    normalized_summary: CERT_SUMMARY,
    domains: ["streaming video"],
    date_range: { start: "2015-01-01", end: "2021-06-30" },
  }),
  "unit-d": exampleUnit("unit-d", {
    raw_text: CERT_RAW,
    normalized_summary: CERT_SUMMARY,
    skills: ["device certification"],
    date_range: { start: "2021-07-01", end: "2027-06-30" },
  }),
};

/** The run date every traceability example shows. */
const TRACEABILITY_EXAMPLE_TODAY = "2026-01-15";

describe("traceability.v2 few-shot", () => {
  const { system, userFewShot } = sections("validation", "traceability.v2.md");
  const inputs = fences(userFewShot, "text");
  const answers = fences(userFewShot, "json");

  it("has six examples, each with one input and one answer", () => {
    expect(inputs).toHaveLength(6);
    expect(answers).toHaveLength(6);
  });

  it("shows each example input exactly as renderTraceabilityInput renders it, run date included", () => {
    for (const input of inputs) {
      const claim = JSON.parse(/^Claim: (.*)$/m.exec(input)![1]!) as string;
      const id = /^\[Unit ([^\]]+)\]/m.exec(input)![1]!;
      expect(input).toBe(
        renderTraceabilityInput(claim, TRACEABILITY_EXAMPLE_TODAY, [TRACEABILITY_UNITS[id]!]),
      );
    }
  });

  it("rejects a claim built from a date_range end later than today", () => {
    const i = inputs.findIndex((input) => input.includes("[Unit unit-d]"));
    const end = TRACEABILITY_UNITS["unit-d"]!.date_range!.end!;
    expect(end > TRACEABILITY_EXAMPLE_TODAY).toBe(true);
    expect(inputs[i]).toContain("June 2027");
    expect(TraceabilityResponseV2Schema.parse(JSON.parse(answers[i]!)).supports).toBe(false);
  });

  it("tells the model a future start or end supports no claim", () => {
    expect(system).toContain("A `start` or `end` later than `Today` supports no claim");
  });

  it("rejects a title that a seniority signal does not name in its own wording", () => {
    const i = inputs.findIndex((input) => input.includes("[Unit unit-e]"));
    const unit = TRACEABILITY_UNITS["unit-e"]!;
    expect(unit.seniority_signals).toEqual(["led"]);
    expect(inputs[i]).toContain('Claim: "The user was a team lead."');
    expect(`${unit.raw_text} ${unit.normalized_summary}`.toLowerCase()).not.toContain("lead");
    expect(TraceabilityResponseV2Schema.parse(JSON.parse(answers[i]!)).supports).toBe(false);
  });

  it("puts both signal fields under the literal-wording rule, and titles under their own wording", () => {
    expect(system).toContain(
      "A `skills`, `tools`, `domains`, `seniority_signals` or `scope_signals` value supports a claim that names that value",
    );
    expect(system).toContain("a signal \"led\" does not support \"team lead\"");
    expect(system).toContain("appears in its own wording in a Unit's `raw_text` or `normalized_summary`");
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
    expect(ids).toEqual(["unit-a", "unit-b", "unit-b", "unit-e", "unit-c", "unit-d"]);
  });

  it("gives answers that pass the v2 schema, with the intended verdicts", () => {
    const verdicts = answers.map((a) => TraceabilityResponseV2Schema.parse(JSON.parse(a)).supports);
    expect(verdicts).toEqual([true, true, false, false, false, false]);
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

  it("shows a run date after every date its Units show", () => {
    expect(resumeExampleInputBlock().split("\n")[1]).toBe(`today: "${RESUME_EXAMPLE_INPUT.today}"`);
    for (const u of RESUME_EXAMPLE_UNITS) {
      for (const d of [u.date_range?.start, u.date_range?.end]) {
        if (d !== undefined) expect(d < RESUME_EXAMPLE_INPUT.today, `${u.id} ${d}`).toBe(true);
      }
    }
  });

  it("tells the model a future start or end supports no claim", () => {
    expect(system).toContain("A `start` or `end` later than `today` supports no claim");
  });

  it("reads both signal fields in their literal wording, never as a title by meaning", () => {
    expect(system).toContain(
      "Use a `skills`, `tools`, `domains`, `seniority_signals` or `scope_signals` value exactly as written",
    );
    expect(system).toContain("does not make the candidate a \"team lead\"");
    expect(system).toContain("appears in its own wording in a cited Unit's `raw_text` or `normalized_summary`");
    // Rule 1 no longer offers the signals as a source of titles by meaning.
    expect(system).not.toMatch(/in its `raw_text`, `normalized_summary`, `metrics`, `seniority_signals`/);
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

describe("jd.v2 prompt (#656)", () => {
  const v1 = sections("parsing", "jd.v1.md");
  const { system, userFewShot } = sections("parsing", "jd.v2.md");
  const shape = ParsedRequirementV2Schema.shape;

  afterEach(() => clearPromptVersionOverrides());

  it("names every value of every enum field, read from the schema so the two cannot drift", () => {
    const enums = {
      category: shape.category.options,
      priority: shape.priority.options,
      extracted_from: shape.extracted_from.options,
      seniority_level: shape.seniority_level.unwrap().options,
    };
    for (const [field, options] of Object.entries(enums)) {
      expect(options.length, field).toBeGreaterThan(0);
      for (const option of options) expect(system, `${field}: ${option}`).toContain(`\`"${option}"\``);
    }
  });

  it("states that category takes only the seven strings, and where a degree and a practical condition go", () => {
    expect(shape.category.options).toHaveLength(7);
    expect(system).toMatch(/`category` is exactly one of these seven strings; no other value is accepted/);
    expect(system).toContain('not `"education"`');
    expect(system).toMatch(/A degree, certification, or license is `"credential"`/);
    expect(system).toMatch(/willingness to travel[^.]*is `"skill"`/);
  });

  it("defines a must-have under a plain qualifications header and keeps the unclear-case default", () => {
    expect(system).toMatch(/plain qualifications or requirements header[^.]*is a must-have unless its own wording softens it/);
    expect(system).toContain("Default to `false` when genuinely unclear");
  });

  it("tells the model to leave seniority_level out rather than send null or an empty string", () => {
    expect(system).toMatch(/leave the field out of that Unit entirely: never `null`, never `""`/);
    expect(system).toMatch(/"Sr" and "Sr\." mean `"senior"`/);
  });

  it("spells out every field's type and lists exactly the schema's keys", () => {
    const rule = system.slice(system.indexOf("8. **Field types.**"), system.indexOf("9. **One Unit per ask.**"));
    expect(rule).toMatch(/never a string holding JSON/);
    expect(rule).toMatch(/`\[\]` when there are none, never omitted, never a single string/);
    expect(rule).toMatch(/the boolean `true` or `false`, not a string/);
    const named = [...rule.matchAll(/^ {3}- (.+?) —/gm)].flatMap((m) => [...m[1]!.matchAll(/`([a-z_]+)`/g)].map((k) => k[1]!));
    expect(named.sort()).toEqual(Object.keys(shape).sort());
  });

  it("sets the granularity: one Unit per ask, never one per listed example", () => {
    expect(system).toMatch(/Emit one Unit per stated ask: usually one per bullet/);
    expect(system).toMatch(/a bullet with two sentences that each state their own ask gives one Unit per sentence/);
    expect(system).toMatch(/Never split a single ask into several Units because it lists several examples, tools, partners, or technologies/);
    expect(system).toMatch(/It becomes its own `must_have: false` Unit when it names a different skill, tool, or domain/);
    expect(system).toMatch(/Prose that only describes the role, the team, or the company is not an ask/);
  });

  it("says the few-shot is abbreviated by exactly the one responsibility bullet it omits", () => {
    expect(system).toMatch(/The example below is abbreviated and omits one responsibility bullet; a full answer would include it\./);
    const input = fences(userFewShot, "")[0] ?? "";
    const bullets = input.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    const units = (JSON.parse(fences(userFewShot, "json")[0]!) as { requirements: { raw_text: string; extracted_from: string }[] }).requirements;
    const omitted = bullets.filter((b) => !units.some((u) => u.raw_text === b));
    expect(omitted).toHaveLength(1);
    const responsibilities = input.slice(input.indexOf("Responsibilities:"), input.indexOf("Qualifications:"));
    expect(responsibilities).toContain(omitted[0]!);
  });

  it("numbers the hard rules 1 to 9 in order", () => {
    const numbers = [...system.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps v1's few-shot unchanged and changes only the System text", () => {
    expect(userFewShot).toBe(v1.userFewShot);
    expect(system).not.toBe(v1.system);
    // Every v1 line survives; v2 only adds to it.
    for (const line of v1.system.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("3. ") && !l.startsWith("6. "))) {
      expect(system, line).toContain(line);
    }
  });

  it("gives a few-shot answer that passes the v2 schema", () => {
    const answers = fences(userFewShot, "json");
    expect(answers).toHaveLength(1);
    const parsed = JdParsingResponseV2Schema.safeParse(JSON.parse(answers[0]!));
    expect(parsed.success).toBe(true);
  });

  it("keeps development history out of model-visible text", () => {
    expect(`${system}\n${userFewShot}`).not.toMatch(DEV_HISTORY);
  });

  it("is what the loader serves under a parsing/jd=v2 override", () => {
    setPromptVersionOverrides({ "parsing/jd": "v2" });
    const loaded = loadPromptText("parsing", "jd");
    expect(loaded.version).toBe("v2");
    expect(loaded.system).toBe(system);
    expect(loaded.userFewShot).toBe(userFewShot);
  });
});

describe("active prompt versions (#485)", () => {
  it("serves traceability v2", () => {
    expect(PROMPT_CONFIG.validation.traceability).toBe("v2");
  });

  it("serves resume generation v2", () => {
    expect(PROMPT_CONFIG.generation.resume).toBe("v2");
  });

  it("keeps JD parsing at v1 in production; v2 is eval-only (#656)", () => {
    expect(PROMPT_CONFIG.parsing.jd).toBe("v1");
    expect(loadPromptText("parsing", "jd").version).toBe("v1");
  });
});
