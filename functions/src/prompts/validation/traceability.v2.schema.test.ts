import { describe, expect, it } from "vitest";

import { TraceabilityResponseV1Schema } from "./traceability.v1.schema.ts";
import { TraceabilityResponseV2Schema } from "./traceability.v2.schema.ts";

describe("TraceabilityResponseV2Schema (#485)", () => {
  it("is the v1 schema: only the prompt text changed", () => {
    expect(TraceabilityResponseV2Schema).toBe(TraceabilityResponseV1Schema);
  });

  it("rejects supports=true without supporting_unit_id", () => {
    expect(
      TraceabilityResponseV2Schema.safeParse({ supports: true, rationale: "Unit says so." }).success,
    ).toBe(false);
  });

  it("accepts a valid false verdict", () => {
    expect(
      TraceabilityResponseV2Schema.safeParse({ supports: false, rationale: "No Unit states it." }).success,
    ).toBe(true);
  });
});
