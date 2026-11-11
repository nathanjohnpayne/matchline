import { describe, expect, it } from "vitest";

import { ResumeGenerationResponseV1Schema } from "./resume.v1.schema.ts";
import { ResumeGenerationResponseV2Schema } from "./resume.v2.schema.ts";

const SUMMARY = { text: "Owned smart-TV device certification.", source_unit_ids: ["u1"] };

describe("ResumeGenerationResponseV2Schema (#485)", () => {
  it("is the v1 schema: only the prompt text changed", () => {
    expect(ResumeGenerationResponseV2Schema).toBe(ResumeGenerationResponseV1Schema);
  });

  it("accepts empty bullets and skills, which v2 tells the model is correct for thin evidence", () => {
    expect(
      ResumeGenerationResponseV2Schema.safeParse({ summary: SUMMARY, bullets: [], skills: [] }).success,
    ).toBe(true);
  });

  it("rejects whitespace-only text", () => {
    expect(
      ResumeGenerationResponseV2Schema.safeParse({
        summary: { ...SUMMARY, text: "   " },
        bullets: [],
        skills: [],
      }).success,
    ).toBe(false);
  });

  it("rejects an item with no source_unit_ids", () => {
    expect(
      ResumeGenerationResponseV2Schema.safeParse({
        summary: SUMMARY,
        bullets: [{ text: "Led it.", source_unit_ids: [] }],
        skills: [],
      }).success,
    ).toBe(false);
  });

  it("rejects a missing summary", () => {
    expect(ResumeGenerationResponseV2Schema.safeParse({ bullets: [], skills: [] }).success).toBe(false);
  });

  it("rejects a model-sent id (strict)", () => {
    expect(
      ResumeGenerationResponseV2Schema.safeParse({
        summary: { ...SUMMARY, id: "x" },
        bullets: [],
        skills: [],
      }).success,
    ).toBe(false);
  });
});
