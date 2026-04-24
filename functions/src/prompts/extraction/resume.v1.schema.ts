/**
 * Zod response contract for `resume.v1.md`. The prompt's
 * `record_experience_units` tool must emit data that parses against
 * `ExtractionResponseV1`; anything else is retried once with a
 * stricter prompt, then surfaced as "needs manual review" per
 * spec § Execution targets / Reliability.
 *
 * Maps 1:1 onto `ExperienceUnit` (src/types/capability.ts) minus
 * server-stamped fields:
 *
 *   Server-stamped (not in the response):
 *     - id             (generated downstream)
 *     - owner_uid      (stamped from auth context, sub-issue #59)
 *     - embedding      (stamped by embedMany, sub-issue #17c)
 *     - user_approved  (false at creation, flipped in Unit Review)
 *     - source_type    (set from the input channel: "resume" here)
 *     - source_ref     (stamped by pipeline, sub-issue #17c)
 *     - created_at     (stamped by firebase-admin server timestamp)
 *     - updated_at     (same)
 *
 * Dropping these from the response contract keeps the model's
 * attention on the evidence-grounded fields it can actually produce
 * and prevents it from inventing ids, uids, or timestamps.
 */

import { z } from "zod";

const UnitTypeSchema = z.enum([
  "project",
  "achievement",
  "ownership",
  "skill_demo",
  "leadership",
  "technical_decision",
]);

const EvidenceTypeSchema = z.enum([
  // "user_confirmed" is deliberately excluded from extraction —
  // it's reserved for the Unit Review approval pass.
  "verified",
  "inferred",
]);

const MetricDirectionSchema = z.enum(["up", "down"]);
const MetricConfidenceSchema = z.enum(["high", "medium", "low"]);

// `.strict()` on every object: unknown fields fail validation
// rather than getting silently stripped. If the model emits a
// server-stamped field (id, owner_uid, embedding) or any other
// drift, we want retry / manual-review to fire — not a silent
// success with truncated data.
const MetricSchema = z
  .object({
    claim: z.string().min(1),
    value: z.number().optional(),
    unit: z.string().optional(),
    direction: MetricDirectionSchema.optional(),
    confidence: MetricConfidenceSchema,
  })
  .strict();

const ISODateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DateRangeSchema = z
  .object({
    start: ISODateSchema,
    end: ISODateSchema.optional(),
  })
  .strict()
  // Chronology check: if `end` is present, it must not precede
  // `start`. ISO-8601 YYYY-MM-DD strings sort lexically, so a
  // string compare is the same as a date compare.
  .refine((r) => r.end === undefined || r.end >= r.start, {
    message: "date_range.end must not precede date_range.start",
    path: ["end"],
  });

export const ExtractedUnitV1Schema = z
  .object({
    raw_text: z.string().min(1),
    normalized_summary: z.string().min(1),
    unit_type: UnitTypeSchema,

    skills: z.array(z.string()),
    tools: z.array(z.string()),
    domains: z.array(z.string()),
    seniority_signals: z.array(z.string()),
    scope_signals: z.array(z.string()),
    business_outcomes: z.array(z.string()),
    metrics: z.array(MetricSchema),

    evidence_type: EvidenceTypeSchema,
    // Prompt says "below 0.50 should not be emitted" — enforce at
    // schema level too so a hallucination flood is rejected.
    confidence_score: z.number().min(0.5).max(1),

    date_range: DateRangeSchema.optional(),
  })
  .strict();

export const ExtractionResponseV1Schema = z
  .object({
    units: z.array(ExtractedUnitV1Schema),
  })
  .strict();

export type ExtractedUnitV1 = z.infer<typeof ExtractedUnitV1Schema>;
export type ExtractionResponseV1 = z.infer<typeof ExtractionResponseV1Schema>;
