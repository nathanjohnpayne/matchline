import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ExtractedUnitV1Schema,
  ExtractionResponseV1Schema,
} from "./resume.v1.schema.ts";

/**
 * Load the known-good fixture that mirrors the example in the prompt
 * itself. Resolved from `import.meta.url` rather than `process.cwd()`
 * so the suite works regardless of the caller's working directory
 * (vitest from the functions/ dir vs. root vs. a watch invocation
 * from an editor). CodeRabbit Nitpick on PR #69.
 *
 * Keep the fixture in sync with the prompt's example so tests catch
 * drift between the prompt's documented response and the schema it's
 * validated against.
 */
// __dirname → functions/src/prompts/extraction
// repo root  → ../../../..
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const FIXTURE_PATH = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "prompts",
  "extraction",
  "nathan-ncp-migration.json",
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

describe("ExtractionResponseV1Schema", () => {
  it("parses the hand-authored known-good fixture", () => {
    const result = ExtractionResponseV1Schema.safeParse(loadFixture());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.units).toHaveLength(2);
      expect(result.data.units[0]!.evidence_type).toBe("verified");
    }
  });

  it("round-trips without data loss on the known-good fixture", () => {
    const fixture = loadFixture() as { units: unknown[] };
    const parsed = ExtractionResponseV1Schema.parse(fixture);
    // Drop the _note commentary key that exists only in the fixture
    // file, not in real LLM responses.
    const expected = { units: fixture.units };
    expect(parsed).toEqual(expected);
  });

  it("rejects a response with a confidence_score below 0.5 floor", () => {
    // The prompt instructs the model to drop Units it'd label <0.5.
    // The schema enforces this so a hallucination-flood slip gets
    // caught before the ExperienceUnit ever lands in Firestore.
    const bad = {
      raw_text: "...",
      normalized_summary: "...",
      unit_type: "project",
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified",
      confidence_score: 0.3,
    };
    const result = ExtractedUnitV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects evidence_type='user_confirmed' from extraction", () => {
    // user_confirmed is reserved for the approval pass in Unit Review.
    // Extraction should never emit it.
    const bad = {
      raw_text: "...",
      normalized_summary: "...",
      unit_type: "project",
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "user_confirmed",
      confidence_score: 0.9,
    };
    const result = ExtractedUnitV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a malformed date_range", () => {
    const bad = {
      raw_text: "...",
      normalized_summary: "...",
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
      date_range: { start: "not-a-date" },
    };
    const result = ExtractedUnitV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a date_range where end precedes start (chronology)", () => {
    // Impossible experience window — 2024-06 → 2020-01 is a real
    // shape the model could emit if it misreads "2020–2024" as
    // inverted ordering. Fail fast so downstream recency math
    // doesn't have to guard against it.
    const bad = {
      raw_text: "Worked there.",
      normalized_summary: "Worked there.",
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
      date_range: { start: "2024-06-01", end: "2020-01-01" },
    };
    const result = ExtractedUnitV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects impossible calendar dates (e.g. month 13, Feb 31)", () => {
    // YYYY-MM-DD shape would accept 2024-13-40 on a regex-only
    // check. The real-date refine rejects it via round-trip
    // through new Date() — same guard that catches Feb 31, etc.
    const makeUnit = (start: string) => ({
      raw_text: "...",
      normalized_summary: "...",
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
      date_range: { start },
    });
    expect(ExtractedUnitV1Schema.safeParse(makeUnit("2024-13-40")).success).toBe(false);
    expect(ExtractedUnitV1Schema.safeParse(makeUnit("2024-02-31")).success).toBe(false);
    expect(ExtractedUnitV1Schema.safeParse(makeUnit("2023-02-29")).success).toBe(false); // not a leap year
    expect(ExtractedUnitV1Schema.safeParse(makeUnit("2024-02-29")).success).toBe(true);  // is a leap year
  });

  it("accepts a date_range where end equals start (single-day)", () => {
    const ok = {
      raw_text: "One-day event.",
      normalized_summary: "One-day event.",
      unit_type: "achievement",
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified",
      confidence_score: 0.9,
      date_range: { start: "2024-06-01", end: "2024-06-01" },
    };
    const result = ExtractedUnitV1Schema.safeParse(ok);
    expect(result.success).toBe(true);
  });

  it("accepts a unit with no date_range (optional field)", () => {
    const ok = {
      raw_text: "Shipped a side project.",
      normalized_summary: "Shipped a side project.",
      unit_type: "project",
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified",
      confidence_score: 0.8,
    };
    const result = ExtractedUnitV1Schema.safeParse(ok);
    expect(result.success).toBe(true);
  });

  it("rejects a unit missing a required field (normalized_summary)", () => {
    const bad = {
      raw_text: "Some raw text.",
      // normalized_summary omitted
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
    };
    const result = ExtractedUnitV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an LLM-emitted server-stamped field (strict schema)", () => {
    // Silent-strip behavior would mean the model could invent an
    // `id` or `owner_uid` and parsing would succeed — defeating the
    // retry / manual-review path on hallucinated structure. The
    // schema uses .strict() so any unknown key fails validation.
    const bad = {
      raw_text: "Some raw text.",
      normalized_summary: "Summary.",
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
      id: "uuid-the-model-invented",
    };
    const result = ExtractedUnitV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an empty string for required text fields", () => {
    const bad = {
      raw_text: "",
      normalized_summary: "Summary.",
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
    };
    const result = ExtractedUnitV1Schema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only required text fields (#335)", () => {
    const bad = {
      raw_text: "   ",
      normalized_summary: "Summary.",
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
    };
    expect(ExtractedUnitV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects whitespace-only entries inside skills/tools/domains and metric claims (#335)", () => {
    const base = {
      raw_text: "Some raw text.",
      normalized_summary: "Summary.",
      unit_type: "project" as const,
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified" as const,
      confidence_score: 0.9,
    };
    expect(
      ExtractedUnitV1Schema.safeParse({ ...base, skills: ["  "] }).success,
    ).toBe(false);
    expect(
      ExtractedUnitV1Schema.safeParse({
        ...base,
        metrics: [{ claim: "\t", confidence: "high" }],
      }).success,
    ).toBe(false);
  });

  it("trims leading/trailing whitespace from valid text fields", () => {
    const ok = {
      raw_text: "  Shipped a side project.  ",
      normalized_summary: "Shipped a side project.",
      unit_type: "project",
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified",
      confidence_score: 0.8,
    };
    const result = ExtractedUnitV1Schema.safeParse(ok);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.raw_text).toBe("Shipped a side project.");
    }
  });
});
