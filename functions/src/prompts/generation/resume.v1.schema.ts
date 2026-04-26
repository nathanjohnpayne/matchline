/**
 * Zod response contract for `resume.v1.md`. The prompt's
 * `record_resume` tool must emit data that parses against
 * `ResumeGenerationResponseV1Schema`.
 *
 * Per #119 (sub-issue 1/3 of #22): the structured output of
 * resume generation. Every fact-bearing item — summary, each
 * bullet, each skill, each education entry — carries
 * `source_unit_ids[]`. The validator (#23) consumes this shape.
 *
 * Server-stamped fields (deliberately excluded from the prompt's
 * response): `id` on every item. The pipeline (#120) stamps
 * UUIDs after schema validation. The LLM doesn't need to invent
 * them, and the IDs need to be stable across re-validation runs
 * via #109's content_snapshot mechanism — server-stamping is
 * the contract.
 *
 * Mirror of `GeneratedAssetContent` in
 * `functions/src/types/crm.ts` minus the `id` fields.
 */

import { z } from "zod";

/**
 * A single fact-bearing item — summary sentence, bullet, skill,
 * or education entry. Each MUST carry `source_unit_ids[]` with
 * at least one Unit id; the validator's traceability check
 * (#107) operates on this contract. An item with empty
 * source_unit_ids is a structural fabrication that bypasses
 * traceability — schema rejects to force a retry.
 *
 * `text.min(1)` is deliberately permissive: legitimate skills
 * are sometimes ≤2 chars ("AI", "ML", "Go", "C#"). Codex P2
 * round 1 on PR #122 caught a prior `min(3)` that excluded
 * these. The prompt's hard rule 8 ("tight prose") + the
 * specificity check in validation (#108) catch genuinely-junk
 * emissions; the schema doesn't need to gate length here.
 */
export const GenerationItemV1Schema = z
  .object({
    // `.min(1)` blocks empty strings; the `.refine` below blocks
    // whitespace-only strings (which Zod's `.min` would otherwise
    // accept — `"   ".length === 3`). CR Trivial round 2 on
    // PR #122 caught the gap.
    text: z
      .string()
      .min(1)
      .max(2000)
      .refine((v) => v.trim().length > 0, {
        message: "text must contain at least one non-whitespace character",
      }),
    source_unit_ids: z
      .array(
        z
          .string()
          .min(1)
          .refine((v) => v.trim().length > 0, {
            message:
              "source_unit_id must contain at least one non-whitespace character",
          }),
      )
      .min(1),
  })
  .strict();

/**
 * An experience section: title + company + date_range +
 * bullets.
 *
 * `title`, `company`, and `date_range` are NOT carried with
 * `source_unit_ids` at the schema level — by intent. They're
 * structural metadata about the section grouping (Disney+ from
 * 2018–2024 as the bucket containing the bullets). The PIPELINE
 * (#120) cross-validates these fields against the linked Units'
 * `employer` / `title` / `date_range` and rejects any section
 * whose metadata doesn't match a real Unit's. This separation
 * keeps the schema's job clean (shape) while the value-level
 * grounding (do these strings match real Unit fields?) lives
 * with the loaded-Unit context the schema doesn't have.
 *
 * Codex P1 round 1 on PR #122 surfaced this gap — a fabricated
 * employer would otherwise ship via passed validation since the
 * validator only iterates summary/bullets/skills/education.
 * Documented here + enforced at the pipeline.
 */
export const GenerationExperienceSectionV1Schema = z
  .object({
    title: z.string().min(1).max(200),
    company: z.string().min(1).max(200),
    date_range: z.string().min(1).max(100).optional(),
    /**
     * Bullets array can be empty for an experience section the
     * generator chose to acknowledge as a gap (per the prompt's
     * hard rule 3: "acknowledge gaps; never invent"). The
     * validator skips empty bullets — no claims to check.
     */
    bullets: z.array(GenerationItemV1Schema),
  })
  .strict();

export const ResumeGenerationResponseV1Schema = z
  .object({
    summary: GenerationItemV1Schema,
    experience: z.array(GenerationExperienceSectionV1Schema),
    skills: z.array(GenerationItemV1Schema),
    education: z.array(GenerationItemV1Schema).optional(),
  })
  .strict();

export type GenerationItemV1 = z.infer<typeof GenerationItemV1Schema>;
export type GenerationExperienceSectionV1 = z.infer<
  typeof GenerationExperienceSectionV1Schema
>;
export type ResumeGenerationResponseV1 = z.infer<
  typeof ResumeGenerationResponseV1Schema
>;
