import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { JdParsingResponseV1Schema, ParsedRequirementV1Schema } from "./jd.v1.schema.ts";
import { JdParsingResponseV2Schema, ParsedRequirementV2Schema } from "./jd.v2.schema.ts";

const FIXTURE_PATH = join(process.cwd(), "tests", "fixtures", "prompts", "parsing", "senior-pm-video-infra.json");

function loadFixture(): { requirements: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { requirements: Record<string, unknown>[] };
}

/** A synthetic, schema-valid Requirement to vary one field at a time. */
const GOOD = {
  raw_text: "Experience shipping developer tools.",
  normalized_requirement: "Shipped developer tools.",
  category: "skill",
  keywords: ["developer tools"],
  tools: [],
  domains: [],
  priority: "medium",
  must_have: true,
  extracted_from: "qualifications",
} as const;

function issuesFor(input: unknown): { code: string; path: PropertyKey[] }[] {
  const result = JdParsingResponseV2Schema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : result.error.issues.map((i) => ({ code: i.code, path: i.path }));
}

describe("JdParsingResponseV2Schema (#656)", () => {
  it("is the v1 contract itself, so v2 differs from v1 only in prompt text", () => {
    expect(JdParsingResponseV2Schema).toBe(JdParsingResponseV1Schema);
    expect(ParsedRequirementV2Schema).toBe(ParsedRequirementV1Schema);
  });

  it("parses the hand-authored known-good fixture without loss", () => {
    const fixture = loadFixture();
    expect(JdParsingResponseV2Schema.parse(fixture)).toEqual(fixture);
  });

  it("accepts an omitted seniority_level, empty lists and an empty requirements array (boundaries)", () => {
    expect(JdParsingResponseV2Schema.safeParse({ requirements: [GOOD] }).success).toBe(true);
    expect(JdParsingResponseV2Schema.safeParse({ requirements: [{ ...GOOD, keywords: [] }] }).success).toBe(true);
    expect(JdParsingResponseV2Schema.safeParse({ requirements: [] }).success).toBe(true);
  });

  it.each(["education", "other", "experience", "Skill"])("rejects category %j with invalid_value at its path", (category) => {
    expect(issuesFor({ requirements: [{ ...GOOD, category }] })).toEqual([
      { code: "invalid_value", path: ["requirements", 0, "category"] },
    ]);
  });

  it("rejects a seniority_level outside the six values", () => {
    expect(issuesFor({ requirements: [{ ...GOOD, seniority_level: "manager" }] })).toEqual([
      { code: "invalid_value", path: ["requirements", 0, "seniority_level"] },
    ]);
    expect(issuesFor({ requirements: [{ ...GOOD, seniority_level: "" }] })).toEqual([
      { code: "invalid_value", path: ["requirements", 0, "seniority_level"] },
    ]);
  });

  it("rejects seniority_level: null, which the prompt tells the model never to send", () => {
    // zod 4 reports a non-member of an enum, null included, as invalid_value.
    expect(issuesFor({ requirements: [{ ...GOOD, seniority_level: null }] })).toEqual([
      { code: "invalid_value", path: ["requirements", 0, "seniority_level"] },
    ]);
  });

  it("rejects requirements sent as a string holding JSON", () => {
    expect(issuesFor({ requirements: JSON.stringify([GOOD]) })).toEqual([
      { code: "invalid_type", path: ["requirements"] },
    ]);
  });

  it("rejects a list field sent as a single string, and must_have sent as a string", () => {
    expect(issuesFor({ requirements: [{ ...GOOD, tools: "Figma" }] })).toEqual([
      { code: "invalid_type", path: ["requirements", 0, "tools"] },
    ]);
    expect(issuesFor({ requirements: [{ ...GOOD, must_have: "true" }] })).toEqual([
      { code: "invalid_type", path: ["requirements", 0, "must_have"] },
    ]);
  });

  it("rejects a whitespace-only list entry and a missing list field", () => {
    expect(issuesFor({ requirements: [{ ...GOOD, keywords: ["  "] }] })[0]).toMatchObject({
      code: "too_small",
      path: ["requirements", 0, "keywords", 0],
    });
    const { domains: _omitted, ...withoutDomains } = GOOD;
    expect(issuesFor({ requirements: [withoutDomains] })).toEqual([
      { code: "invalid_type", path: ["requirements", 0, "domains"] },
    ]);
  });

  it("rejects an unknown key on a Requirement and on the envelope", () => {
    expect(issuesFor({ requirements: [{ ...GOOD, id: "x" }] })).toEqual([
      { code: "unrecognized_keys", path: ["requirements", 0] },
    ]);
    expect(issuesFor({ requirements: [GOOD], notes: "" })).toEqual([{ code: "unrecognized_keys", path: [] }]);
  });
});
