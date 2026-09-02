/**
 * Zod response contract for `resume.v2.md`. The prompt's
 * `record_experience_units` tool must emit data that parses against
 * `ExtractionResponseV2`; anything else is retried once with a
 * stricter prompt, then surfaced as "needs manual review" per
 * spec § Execution targets / Reliability.
 *
 * v2 adds `competencies` — see the field's docblock and
 * `resume.v2.md` § rule 7. Everything else is unchanged from v1.
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
    // `.trim()` before `.min(1)`: a bare `.min(1)` only checks string
    // length, so a whitespace-only value (e.g. "   ") would pass and
    // get embedded/persisted as if it were real content. See #335.
    claim: z.string().trim().min(1),
    value: z.number().optional(),
    unit: z.string().optional(),
    direction: MetricDirectionSchema.optional(),
    confidence: MetricConfidenceSchema,
  })
  .strict();

// Two-stage validation: the regex enforces YYYY-MM-DD shape; the
// refine enforces that the string names a real calendar date.
// Example rejection: "2024-02-31" parses lexically but coerces to
// "2024-03-02" on round-trip, so we reject it — otherwise it would
// sneak into recency-scoring math as a real date.
const ISODateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine(
    (s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
    },
    { message: "must be a real calendar date (e.g. 2024-02-31 is not)" },
  );
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

export const ExtractedUnitV2Schema = z
  .object({
    // `.trim()` before `.min(1)`: see MetricSchema.claim above — a
    // bare `.min(1)` lets whitespace-only strings through. See #335.
    raw_text: z.string().trim().min(1),
    normalized_summary: z.string().trim().min(1),
    unit_type: UnitTypeSchema,

    skills: z.array(z.string().trim().min(1)),
    /**
     * Transferable capabilities the Unit DEMONSTRATES, as opposed
     * to `skills`, which is what the work literally was (#437).
     *
     * Separate field rather than more entries in `skills`, because
     * the two carry different epistemic weight: `skills` is read
     * off the page, `competencies` is an inference about what the
     * page evidences. Merging them would make that distinction
     * unrecoverable downstream, and "which of these did the model
     * infer?" is exactly the question a zero-fabrication product
     * has to be able to answer.
     *
     * Optional with a `[]` default so a v1-shaped response still
     * parses: the field is additive, and an extraction that
     * predates it is missing the layer, not malformed.
     */
    competencies: z.array(z.string().trim().min(1)).default([]),
    tools: z.array(z.string().trim().min(1)),
    domains: z.array(z.string().trim().min(1)),
    seniority_signals: z.array(z.string().trim().min(1)),
    scope_signals: z.array(z.string().trim().min(1)),
    business_outcomes: z.array(z.string().trim().min(1)),
    metrics: z.array(MetricSchema),

    evidence_type: EvidenceTypeSchema,
    // Prompt says "below 0.50 should not be emitted" — enforce at
    // schema level too so a hallucination flood is rejected.
    confidence_score: z.number().min(0.5).max(1),

    date_range: DateRangeSchema.optional(),
  })
  .strict();

export const ExtractionResponseV2Schema = z
  .object({
    units: z.array(ExtractedUnitV2Schema),
  })
  .strict();

export type ExtractedUnitV2 = z.infer<typeof ExtractedUnitV2Schema>;
export type ExtractionResponseV2 = z.infer<typeof ExtractionResponseV2Schema>;
