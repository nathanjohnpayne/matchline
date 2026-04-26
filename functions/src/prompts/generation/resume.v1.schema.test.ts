import { describe, expect, it } from "vitest";

import {
  GenerationItemV1Schema,
  ResumeGenerationResponseV1Schema,
} from "./resume.v1.schema.ts";

/**
 * Schema-level tests for the resume-generation Zod contract.
 * Pure schema validation — no LLM, no fixtures-on-disk.
 *
 * V1 is intentionally FLAT — `bullets[]` is a single list, no
 * experience-section grouping. cursor's CHANGES_REQUESTED rounds
 * 3 + 4 on PR #122 motivated dropping section metadata until
 * the data model has a real source of truth (#22's V2/Phase 2
 * work).
 */

const KNOWN_GOOD = {
  summary: {
    text: "Senior PM with streaming-video infrastructure experience.",
    source_unit_ids: ["u-disney", "u-edx"],
  },
  bullets: [
    {
      text: "Led 64-bit NCP migration on Disney+ playback (30% memory reduction).",
      source_unit_ids: ["u-disney"],
    },
    {
      text: "Owned smart-TV device certification across Samsung and LG.",
      source_unit_ids: ["u-edx"],
    },
  ],
  skills: [
    {
      text: "Streaming video infrastructure",
      source_unit_ids: ["u-disney", "u-edx"],
    },
  ],
};

describe("ResumeGenerationResponseV1Schema", () => {
  it("parses a known-good response", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse(KNOWN_GOOD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary.source_unit_ids).toEqual([
        "u-disney",
        "u-edx",
      ]);
      expect(result.data.bullets).toHaveLength(2);
      expect(result.data.skills).toHaveLength(1);
      expect(result.data.education).toBeUndefined();
    }
  });

  it("round-trips without data loss", () => {
    const parsed = ResumeGenerationResponseV1Schema.parse(KNOWN_GOOD);
    expect(parsed).toEqual(KNOWN_GOOD);
  });

  it("accepts an empty bullets array (gap-acknowledgment per prompt rule 3)", () => {
    // The prompt's hard rule 3 says "leave the Requirement-
    // linked bullet empty rather than invent". An empty
    // bullets array is the legitimate gap-acknowledgment shape
    // when the user has no Unit-backed content for the role.
    const result = ResumeGenerationResponseV1Schema.safeParse({
      ...KNOWN_GOOD,
      bullets: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty skills array (no Unit-backed skills available)", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse({
      ...KNOWN_GOOD,
      skills: [],
    });
    expect(result.success).toBe(true);
  });

  it("REJECTS legacy `experience` field (cursor #122 r4: V1 has flat bullets only)", () => {
    // Strict mode pin: a regression that re-introduces the
    // experience array (with section metadata) would fail
    // schema parse. Catches drift in either direction.
    const withExperience = {
      ...KNOWN_GOOD,
      experience: [
        {
          title: "Senior PM",
          company: "Disney+",
          bullets: [
            {
              text: "Led migration.",
              source_unit_ids: ["u-disney"],
            },
          ],
        },
      ],
    };
    const result = ResumeGenerationResponseV1Schema.safeParse(withExperience);
    expect(result.success).toBe(false);
  });

  // -- LOAD-BEARING PINS: source_unit_ids non-empty ------------------------

  it("REJECTS an item with empty source_unit_ids array (load-bearing zero-fab pin)", () => {
    // Every fact-bearing item MUST carry ≥1 source_unit_ids
    // entry. An item with [] bypasses traceability entirely —
    // the validator can't check what the generator didn't claim
    // to ground on. Schema rejects to force a retry.
    const result = GenerationItemV1Schema.safeParse({
      text: "Some claim",
      source_unit_ids: [],
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS a summary with empty source_unit_ids", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse({
      ...KNOWN_GOOD,
      summary: {
        text: "Senior PM with streaming experience.",
        source_unit_ids: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS a bullet with empty source_unit_ids", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse({
      ...KNOWN_GOOD,
      bullets: [
        {
          text: "Led migration.",
          source_unit_ids: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS a skill with empty source_unit_ids", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse({
      ...KNOWN_GOOD,
      skills: [
        {
          text: "Streaming",
          source_unit_ids: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  // -- Server-stamped field rejection (strict-schema pin) -----------------

  it("rejects an LLM-emitted server-stamped `id` on an item (strict schema)", () => {
    // The pipeline server-stamps `id`s; the LLM MUST NOT emit
    // them. If a future prompt drift starts including them,
    // this test catches it.
    const withId = {
      ...KNOWN_GOOD,
      summary: {
        id: "fabricated-llm-id",
        text: "x",
        source_unit_ids: ["u-1"],
      },
    };
    const result = ResumeGenerationResponseV1Schema.safeParse(withId);
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields on the response (strict mode)", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse({
      ...KNOWN_GOOD,
      certifications: [],
    });
    expect(result.success).toBe(false);
  });

  // -- Length bounds + missing fields --------------------------------------

  it("accepts short legitimate skill text (≥1 char) — Codex P2 round 1 on PR #122", () => {
    // "AI", "ML", "Go", "C#" are real skills the model should
    // be able to emit. The prior min(3) rejected them. The
    // prompt's "tight prose" rule + the specificity validator
    // catch genuine junk; the schema doesn't need a length
    // gate beyond non-empty.
    for (const skill of ["AI", "ML", "Go", "C#", "QA"]) {
      const result = GenerationItemV1Schema.safeParse({
        text: skill,
        source_unit_ids: ["u-1"],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects empty text (the length floor)", () => {
    const result = GenerationItemV1Schema.safeParse({
      text: "",
      source_unit_ids: ["u-1"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only text — CR Trivial round 2 on PR #122", () => {
    // Zod's `.min(1)` accepts "   " (length 3). The schema's
    // `.refine()` trims and rejects whitespace-only.
    for (const ws of ["   ", "\t", "\n", " \t\n "]) {
      const result = GenerationItemV1Schema.safeParse({
        text: ws,
        source_unit_ids: ["u-1"],
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects whitespace-only source_unit_id strings", () => {
    const result = GenerationItemV1Schema.safeParse({
      text: "Some claim",
      source_unit_ids: ["u-real", "   "],
    });
    expect(result.success).toBe(false);
  });

  it("rejects text longer than 2000 chars", () => {
    const result = GenerationItemV1Schema.safeParse({
      text: "x".repeat(2001),
      source_unit_ids: ["u-1"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty source_unit_id strings within the array", () => {
    const result = GenerationItemV1Schema.safeParse({
      text: "Some claim",
      source_unit_ids: ["u-real", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects when summary is missing", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse({
      bullets: [],
      skills: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts when education is omitted (it's optional)", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse(KNOWN_GOOD);
    expect(result.success).toBe(true);
  });

  it("accepts education when provided (each entry is a GeneratedItem)", () => {
    const result = ResumeGenerationResponseV1Schema.safeParse({
      ...KNOWN_GOOD,
      education: [
        { text: "BS, Computer Science, MIT", source_unit_ids: ["u-edu"] },
      ],
    });
    expect(result.success).toBe(true);
  });
});
