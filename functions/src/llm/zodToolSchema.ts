import { z } from "zod";

// Convert a zod v4 schema into a JSON Schema object suitable for
// Anthropic's tool_use `input_schema`. Uses zod v4's native
// `z.toJSONSchema` with the draft-7 target — Anthropic's tool API
// accepts draft-7 (the `$schema` field is ignored by the server).
//
// Why not zod-to-json-schema (3rd-party). Its 3.25.x line declares
// `peerDependencies.zod = "^3.25.28 || ^4"` but its converter still
// expects the v3 internal shape; passing a v4 schema collapses the
// output to `{}`. That silently removes upstream schema enforcement
// on every tool call (extraction / parsing / generation /
// validation), which Codex P1 caught on the first round of #165 —
// confirmed locally by passing a real v4 schema and getting `{}`
// back. Native `z.toJSONSchema` handles v4 correctly because it IS
// part of zod v4.
//
// Output shape comparison vs the prior `target: "openApi3" +
// $refStrategy: "none"` output: the new draft-7 form has the same
// `properties` / `required` / `additionalProperties` structure that
// Anthropic actually reads, with no $ref entries (zod v4's
// generator inlines by default, matching what `$refStrategy:
// "none"` used to do).
export function zodToToolSchema(
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}
