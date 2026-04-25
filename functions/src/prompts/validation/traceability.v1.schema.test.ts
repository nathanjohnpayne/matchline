import { describe, expect, it } from "vitest";

import { TraceabilityResponseV1Schema } from "./traceability.v1.schema.ts";

/**
 * Schema-level tests for the traceability Zod contract.
 * Pure schema validation — no LLM, no fixtures-on-disk.
 */

describe("TraceabilityResponseV1Schema", () => {
  it("accepts a supports=true response with supporting_unit_id", () => {
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: true,
      supporting_unit_id: "unit-a",
      rationale: "Unit unit-a directly supports the claim.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a supports=false response without supporting_unit_id", () => {
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: false,
      rationale: "No Unit references this content.",
    });
    expect(result.success).toBe(true);
  });

  it("REJECTS supports=true without supporting_unit_id (load-bearing zero-fab pin)", () => {
    // The schema's refine() catches this combination: `supports:
    // true` MUST have `supporting_unit_id`. Without it, the
    // orchestrator can't render the claim → Unit lineage in the
    // Application Editor (#24), and the model would have
    // emitted a yes-vote without identifying which Unit backs
    // it — the kind of dangling reference that defeats the
    // validation layer's purpose.
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: true,
      rationale: "I think some Unit supports this.",
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS supports=false WITH supporting_unit_id (contradiction prevention)", () => {
    // Pin: a model that emits supports=false but ALSO names a
    // supporter is contradicting itself. The orchestrator would
    // need to disambiguate; we reject at the schema layer
    // instead so the model retries.
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: false,
      supporting_unit_id: "unit-a",
      rationale: "Mixed signals.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects rationale shorter than 5 chars", () => {
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: false,
      rationale: "no",
    });
    expect(result.success).toBe(false);
  });

  it("rejects rationale longer than 1000 chars", () => {
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: false,
      rationale: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty supporting_unit_id when supports=true", () => {
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: true,
      supporting_unit_id: "",
      rationale: "Unit supports.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strict mode pin)", () => {
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: false,
      rationale: "No support found.",
      surprise_field: "should fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when supports is missing", () => {
    const result = TraceabilityResponseV1Schema.safeParse({
      rationale: "Some explanation.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when rationale is missing", () => {
    const result = TraceabilityResponseV1Schema.safeParse({
      supports: false,
    });
    expect(result.success).toBe(false);
  });
});
