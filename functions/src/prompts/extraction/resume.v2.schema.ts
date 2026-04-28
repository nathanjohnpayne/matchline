/**
 * Zod response contract for `resume.v2.md`.
 *
 * v2's prompt body changes only rule 4 (skills: prefer canonical;
 * see `resume.v2.md` for the full diff) — the response shape and
 * field set are identical to v1. Re-exporting the v1 schema keeps
 * the prompt-loader file-pair invariant satisfied
 * (`check_prompt_schema_pairs`) without duplicating contract code
 * that would drift the moment v2 lands a real change.
 *
 * If a future v3 changes the schema (new field, removed field,
 * tightened type), introduce `resume.v3.schema.ts` with its own
 * exports — do NOT mutate this file. Keeping v2 and v1 schema-
 * equivalent is the explicit promise of "rule-4-only iteration."
 *
 * The `V1` suffix on the re-exports is intentional and correct:
 * type identity is preserved across the version boundary, so
 * production code that imports `ExtractionResponseV1Schema`
 * directly continues to type-check whether the loader serves v1
 * or v2 from disk. Aliasing to a `V2` name would imply a contract
 * difference that doesn't exist.
 */

export {
  ExtractedUnitV1Schema,
  ExtractionResponseV1Schema,
  type ExtractedUnitV1,
  type ExtractionResponseV1,
} from "./resume.v1.schema.js";
