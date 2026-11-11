/**
 * Which Zod response schema validates a JD parsing answer, by prompt
 * version (#656).
 *
 * `parseJobRequirements` builds its tool schema from, and validates the
 * model's answer against, the schema of the prompt version it actually
 * loaded. An eval override to `parsing/jd=v2` therefore runs the v2
 * prompt against the v2 contract, and a version with no entry here
 * refuses before any request is sent rather than validating against a
 * schema it was not written for.
 *
 * Every version's response type must equal v1's: the record type keeps
 * the compiler holding a new version to the shape `stampOne` maps onto
 * `JobRequirementUnit`. A version that changes the shape needs its own
 * mapping, not just an entry here.
 *
 * Pure and dependency-free apart from the schema modules, so the eval
 * harness can import `JD_PARSING_SCHEMA_VERSIONS` for its pre-flight
 * (`tests/eval/sweepScope.ts`).
 */

import { JdParsingResponseV1Schema } from "../prompts/parsing/jd.v1.schema.js";
import { JdParsingResponseV2Schema } from "../prompts/parsing/jd.v2.schema.js";

export type JdParsingResponseSchema = typeof JdParsingResponseV1Schema;

const JD_PARSING_RESPONSE_SCHEMAS: Readonly<Record<string, JdParsingResponseSchema>> = Object.freeze({
  v1: JdParsingResponseV1Schema,
  v2: JdParsingResponseV2Schema,
});

/** The `parsing/jd` prompt versions whose schema the parser dispatches to. */
export const JD_PARSING_SCHEMA_VERSIONS: readonly string[] = Object.freeze(
  Object.keys(JD_PARSING_RESPONSE_SCHEMAS),
);

/**
 * The response schema for a `parsing/jd` prompt version. Throws on a
 * version with no registered schema (an own-property check, so
 * `"__proto__"` or `"toString"` is not mistaken for a version).
 */
export function jdParsingResponseSchemaFor(version: string): JdParsingResponseSchema {
  if (!Object.hasOwn(JD_PARSING_RESPONSE_SCHEMAS, version)) {
    throw new Error(
      `No JD parsing schema registered for version "${version}". ` +
        `Registered: ${JD_PARSING_SCHEMA_VERSIONS.join(", ")}. ` +
        `Add the version's schema to functions/src/parsing/jdResponseSchema.ts.`,
    );
  }
  return JD_PARSING_RESPONSE_SCHEMAS[version]!;
}
