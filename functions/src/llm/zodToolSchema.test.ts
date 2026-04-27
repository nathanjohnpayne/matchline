import { describe, it, expect } from "vitest";
import { z } from "zod";

import { zodToToolSchema } from "./zodToolSchema.js";

// These tests are the cheapest insurance against the next
// "library bumped peerDeps but didn't actually fix the v3→v4
// converter" trap (see #170 / #171). The first assertion
// (`Object.keys(result).length > 0`) alone would have caught
// the `zod-to-json-schema@3.25.x` empty-`{}` regression that
// PR #169 fixed — every tool call would have shipped with no
// upstream schema enforcement, and the unit suite would still
// have been green.
//
// We only assert structural shape, not exact JSON Schema text.
// `z.toJSONSchema` is upstream code; pinning its output too
// tightly would force-fail the suite on benign zod-version
// bumps. The contract Anthropic actually reads is:
//   - top-level `type: "object"`
//   - `properties` map present
//   - `required` is the list of non-optional keys
//   - `additionalProperties: false` on `.strict()` schemas
//   - no $ref pointers anywhere (Anthropic input_schema cannot
//     resolve them)
describe("zodToToolSchema", () => {
  it("produces a non-empty JSON Schema for a v4 ZodObject", () => {
    const schema = z
      .object({
        name: z.string(),
        count: z.number().int(),
      })
      .strict();

    const result = zodToToolSchema(schema);

    expect(Object.keys(result).length).toBeGreaterThan(0);
    expect(result.type).toBe("object");
    expect(result.properties).toBeDefined();
    // `required` is set-like, not ordered; CodeRabbit on
    // PR #174 r1: assert membership + cardinality so a
    // benign re-ordering by future zod versions doesn't
    // force-fail the suite.
    expect(result.required).toEqual(
      expect.arrayContaining(["name", "count"]),
    );
    expect((result.required as unknown[]).length).toBe(2);
    expect(result.additionalProperties).toBe(false);
  });

  it("inlines refs (Anthropic input_schema cannot resolve $ref)", () => {
    const Inner = z.object({ x: z.string() });
    const schema = z.object({ a: Inner, b: Inner }).strict();

    const result = zodToToolSchema(schema);

    // Both `a` and `b` should have their full inlined object
    // shape, not a `$ref` pointer to a shared definition. The
    // converter's pre-#169 behavior on v4 schemas was to emit
    // a `$defs`-with-refs structure, which Anthropic silently
    // accepts but ignores at evaluation time — the model sees
    // an empty schema for the referenced fields.
    const props = result.properties as Record<
      string,
      { type?: string; $ref?: string; properties?: unknown }
    >;
    expect(props.a).toBeDefined();
    expect(props.b).toBeDefined();
    expect(props.a!.type).toBe("object");
    expect(props.b!.type).toBe("object");
    expect(props.a!.properties).toBeDefined();
    expect(props.b!.properties).toBeDefined();

    // Per CodeRabbit on PR #174 r1: enforce the full no-$ref
    // invariant, not just the top-level a/b properties. A
    // future regression that introduces $ref deeper in the
    // tree (e.g., on a nested array element type) would
    // otherwise pass the property-level checks but still
    // ship broken schemas to Anthropic.
    expect(hasRefAnywhere(result)).toBe(false);
  });
});

/**
 * Recursive structural assertion helper. Returns true iff the
 * input contains any `$ref` key anywhere in its
 * object/array tree — including inside `definitions`,
 * `$defs`, `oneOf`/`anyOf`/`allOf`, array `items`, and any
 * other JSON Schema structural slot. The `$ref` invariant is
 * absolute for Anthropic input_schema; a deeper ref would
 * silently break validation on the model side without
 * breaking this Vitest suite.
 */
function hasRefAnywhere(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasRefAnywhere);
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ("$ref" in obj) return true;
    return Object.values(obj).some(hasRefAnywhere);
  }
  return false;
}
