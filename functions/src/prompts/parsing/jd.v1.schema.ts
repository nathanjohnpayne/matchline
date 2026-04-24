/**
 * Zod response contract for `jd.v1.md`. The prompt's
 * `record_job_requirements` tool must emit data that parses against
 * `JdParsingResponseV1Schema`.
 *
 * Server-stamped fields (not in the response contract):
 *   - id          (generated downstream)
 *   - owner_uid   (stamped from auth)
 *   - role_id     (stamped from the callable's input)
 *   - embedding   (stamped by embedMany)
 *
 * Mirror of JobRequirementUnit in functions/src/types/capability.ts
 * minus the above fields.
 */

import { z } from "zod";

const CategorySchema = z.enum([
  "skill",
  "tool",
  "domain",
  "experience_level",
  "scope",
  "soft_skill",
  "credential",
]);

const SeniorityLevelSchema = z.enum([
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "director",
]);

const SourceSchema = z.enum([
  "responsibilities",
  "qualifications",
  "nice_to_have",
  "description",
]);

const PrioritySchema = z.enum(["high", "medium", "low"]);

export const ParsedRequirementV1Schema = z
  .object({
    raw_text: z.string().min(1),
    normalized_requirement: z.string().min(1),
    category: CategorySchema,

    keywords: z.array(z.string()),
    tools: z.array(z.string()),
    domains: z.array(z.string()),
    seniority_level: SeniorityLevelSchema.optional(),

    priority: PrioritySchema,
    must_have: z.boolean(),

    extracted_from: SourceSchema,
  })
  .strict();

export const JdParsingResponseV1Schema = z
  .object({
    requirements: z.array(ParsedRequirementV1Schema),
  })
  .strict();

export type ParsedRequirementV1 = z.infer<typeof ParsedRequirementV1Schema>;
export type JdParsingResponseV1 = z.infer<typeof JdParsingResponseV1Schema>;
