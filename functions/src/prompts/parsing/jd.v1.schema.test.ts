import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  JdParsingResponseV1Schema,
  ParsedRequirementV1Schema,
} from "./jd.v1.schema.ts";

const FIXTURE_PATH = join(
  process.cwd(),
  "tests",
  "fixtures",
  "prompts",
  "parsing",
  "senior-pm-video-infra.json",
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

describe("JdParsingResponseV1Schema", () => {
  it("parses the hand-authored known-good fixture", () => {
    const result = JdParsingResponseV1Schema.safeParse(loadFixture());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requirements).toHaveLength(5);
      expect(result.data.requirements[0]!.category).toBe("skill");
      expect(result.data.requirements[0]!.must_have).toBe(true);
    }
  });

  it("round-trips without data loss on the known-good fixture", () => {
    const fixture = loadFixture();
    const parsed = JdParsingResponseV1Schema.parse(fixture);
    expect(parsed).toEqual(fixture);
  });

  it("rejects an LLM-emitted server-stamped field (strict schema)", () => {
    const bad = makeBase();
    (bad as Record<string, unknown>).id = "server-should-generate-this";
    expect(ParsedRequirementV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects an invalid category value", () => {
    const bad = { ...makeBase(), category: "made-up-category" };
    expect(ParsedRequirementV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects an invalid priority value", () => {
    const bad = { ...makeBase(), priority: "urgent" };
    expect(ParsedRequirementV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects an invalid extracted_from value", () => {
    const bad = { ...makeBase(), extracted_from: "somewhere" };
    expect(ParsedRequirementV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-boolean must_have", () => {
    const bad = { ...makeBase(), must_have: "true" };
    expect(ParsedRequirementV1Schema.safeParse(bad).success).toBe(false);
  });

  it("accepts omitted seniority_level (optional field)", () => {
    const ok = makeBase();
    delete (ok as Record<string, unknown>).seniority_level;
    expect(ParsedRequirementV1Schema.safeParse(ok).success).toBe(true);
  });

  it("rejects an invalid seniority_level when present", () => {
    const bad = { ...makeBase(), seniority_level: "god-tier" };
    expect(ParsedRequirementV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty strings for required text fields", () => {
    const bad = { ...makeBase(), raw_text: "" };
    expect(ParsedRequirementV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing required field (normalized_requirement)", () => {
    const bad = makeBase();
    delete (bad as Record<string, unknown>).normalized_requirement;
    expect(ParsedRequirementV1Schema.safeParse(bad).success).toBe(false);
  });
});

function makeBase(): Record<string, unknown> {
  return {
    raw_text: "Some requirement text.",
    normalized_requirement: "Some requirement.",
    category: "skill",
    keywords: ["x"],
    tools: [],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
  };
}
