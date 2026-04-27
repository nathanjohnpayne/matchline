import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod";

// zod-to-json-schema@3.25.2's TypeScript signature still uses zod v3's
// public type (`ZodType<any, ZodTypeDef, any>`). At runtime it accepts
// zod v4 schemas just fine — its peerDependencies declare
// `^3.25.28 || ^4` — but TS rejects the call because zod v4 dropped
// the `ZodTypeDef` generic from the public type.
//
// This helper bridges the gap: take any zod v4 schema, runtime-call
// zodToJsonSchema with the v3-flavored type cast, and return the
// JSON-schema-shaped object we hand to Anthropic's `input_schema`.
//
// Options mirror what every call site was passing:
//   target: "openApi3"     — produces the OpenAPI-3.0 flavor of
//                            JSON Schema that Anthropic's tool_use
//                            input_schema accepts.
//   $refStrategy: "none"   — inlines all $refs so the output is one
//                            self-contained schema (Anthropic does
//                            not resolve $ref).
//
// When zod-to-json-schema ships v4-typed declarations (or we migrate
// to zod v4's native z.toJSONSchema once it supports the OpenAPI-3.0
// target + ref-inlining we depend on), this helper can be removed.
export function zodToToolSchema(schema: ZodType): Record<string, unknown> {
  // Cast through unknown so the v3-typed parameter accepts our v4 schema.
  // Runtime is unaffected.
  return zodToJsonSchema(schema as unknown as Parameters<typeof zodToJsonSchema>[0], {
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}
