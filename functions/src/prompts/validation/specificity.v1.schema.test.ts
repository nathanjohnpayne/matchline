import { describe, expect, it } from "vitest";

import { SpecificityResponseV1Schema } from "./specificity.v1.schema.ts";

describe("SpecificityResponseV1Schema", () => {
  it("accepts specific=true with a rationale", () => {
    const result = SpecificityResponseV1Schema.safeParse({
      specific: true,
      rationale: "The claim names a metric and surface — verifiable.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts specific=false with a rationale", () => {
    const result = SpecificityResponseV1Schema.safeParse({
      specific: false,
      rationale: "The claim names no metric or surface.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects rationale shorter than 5 chars", () => {
    const result = SpecificityResponseV1Schema.safeParse({
      specific: true,
      rationale: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects rationale longer than 1000 chars", () => {
    const result = SpecificityResponseV1Schema.safeParse({
      specific: false,
      rationale: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = SpecificityResponseV1Schema.safeParse({
      specific: true,
      rationale: "Verifiable.",
      surprise_field: "should fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when specific is missing", () => {
    const result = SpecificityResponseV1Schema.safeParse({
      rationale: "Some explanation.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when rationale is missing", () => {
    const result = SpecificityResponseV1Schema.safeParse({
      specific: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean specific (strict typing)", () => {
    const result = SpecificityResponseV1Schema.safeParse({
      specific: "true",
      rationale: "Verifiable.",
    });
    expect(result.success).toBe(false);
  });
});
