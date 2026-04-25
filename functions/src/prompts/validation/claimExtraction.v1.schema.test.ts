import { describe, expect, it } from "vitest";

import {
  ClaimExtractionResponseV1Schema,
  ClaimItemV1Schema,
} from "./claimExtraction.v1.schema.ts";

/**
 * Schema-level tests for the claim-extraction Zod contract.
 * Pure schema validation — no LLM, no fixtures-on-disk.
 */

const KNOWN_GOOD = {
  claims: [
    {
      text: "The user led a 64-bit NCP migration project.",
      raw_span: "Led 64-bit NCP migration",
    },
    {
      text: "The user achieved a 30% reduction in memory footprint.",
      raw_span: "reduced memory footprint 30%",
    },
    {
      text: "The user collaborated cross-functionally.",
      // raw_span absent — this is allowed for gestalt claims
    },
  ],
};

describe("ClaimExtractionResponseV1Schema", () => {
  it("parses a known-good response", () => {
    const result = ClaimExtractionResponseV1Schema.safeParse(KNOWN_GOOD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.claims).toHaveLength(3);
      expect(result.data.claims[0]!.text).toContain("64-bit NCP");
      expect(result.data.claims[2]!.raw_span).toBeUndefined();
    }
  });

  it("round-trips without data loss", () => {
    const parsed = ClaimExtractionResponseV1Schema.parse(KNOWN_GOOD);
    expect(parsed).toEqual(KNOWN_GOOD);
  });

  it("rejects an empty claims array (silent-skip prevention)", () => {
    // Codex P1 + CodeRabbit Major on PR #110: an LLM response
    // with zero claims for a non-empty bullet is silent-skip
    // territory — the validator can only check what it's given,
    // and the bullet bypasses validation entirely. The fix:
    // schema requires .min(1), so a zero-claim emission triggers
    // a retry, not silent success. The orchestrator (#109) is
    // responsible for not invoking this stage on bullets that
    // legitimately have zero fact-bearing content.
    const result = ClaimExtractionResponseV1Schema.safeParse({ claims: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a server-stamped field (strict schema)", () => {
    // Pin the strict-schema contract: the LLM must NOT emit
    // server-stamped fields like `id` or `bullet_id`. If a future
    // prompt drift starts including them, this test catches it.
    const withServerField = {
      claims: [
        {
          text: "x is true",
          id: "fabricated-id-from-llm",
        },
      ],
    };
    const result = ClaimExtractionResponseV1Schema.safeParse(withServerField);
    expect(result.success).toBe(false);
  });

  it("rejects when claims is not an array", () => {
    const result = ClaimExtractionResponseV1Schema.safeParse({
      claims: { not: "an array" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects when claims is missing entirely", () => {
    const result = ClaimExtractionResponseV1Schema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an item with empty text", () => {
    const result = ClaimItemV1Schema.safeParse({ text: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an item with text shorter than 3 chars (junk filter)", () => {
    const result = ClaimItemV1Schema.safeParse({ text: "ok" });
    expect(result.success).toBe(false);
  });

  it("rejects an item with text > 500 chars", () => {
    const tooLong = "x".repeat(501);
    const result = ClaimItemV1Schema.safeParse({ text: tooLong });
    expect(result.success).toBe(false);
  });

  it("rejects raw_span when empty (defensive: span must be a real substring)", () => {
    const result = ClaimItemV1Schema.safeParse({
      text: "The user did a thing",
      raw_span: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects raw_span > 500 chars", () => {
    const result = ClaimItemV1Schema.safeParse({
      text: "The user did a thing",
      raw_span: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("accepts an item with missing raw_span (it's optional)", () => {
    const result = ClaimItemV1Schema.safeParse({
      text: "The user did a thing",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields on the item (strict mode pin)", () => {
    const result = ClaimItemV1Schema.safeParse({
      text: "The user did a thing",
      raw_span: "did a thing",
      surprise_field: "should fail",
    });
    expect(result.success).toBe(false);
  });
});
