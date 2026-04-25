/**
 * Zod response contract for `traceability.v1.md`. The prompt's
 * `record_traceability` tool must emit data that parses against
 * `TraceabilityResponseV1Schema`.
 *
 * Per #107: the validation layer's per-claim zero-fab gate. Given
 * a claim + candidate Experience Units, the LLM emits a single
 * verdict — does any Unit support the claim, which one, and why?
 *
 * The strict yes/no shape matters: a fuzzy "kind of supports"
 * verdict would defeat the validation layer's purpose. The model
 * is asked to commit to a binary decision per claim, and the
 * orchestrator (#109) treats `supports: false` as an export-blocking
 * flag.
 */

import { z } from "zod";

export const TraceabilityResponseV1Schema = z
  .object({
    /**
     * Strict binary verdict. The prompt's hard rules force the
     * model to err on `false` when in doubt — false-negatives
     * surface to the user as flags they can resolve, but
     * false-positives let fabrications slip through to export.
     * The risk register's #3 ("validator false-positives on
     * legitimate claims") sets the < 10% rate gate; that's a
     * threshold on the count, not on the schema shape.
     */
    supports: z.boolean(),
    /**
     * When `supports: true`, the id of the Unit that backs the
     * claim. The model picks the BEST single supporter — early-
     * exit semantics. When `supports: false`, this field is
     * absent (the prompt forbids emitting an id without
     * backing).
     */
    supporting_unit_id: z.string().min(1).optional(),
    /**
     * Plain-English explanation. Surfaces in the Application
     * Editor (#24) when the user inspects a flag. Length-bounded:
     * too short means no useful detail; too long means the
     * model rambled. 5-1000 chars is enough for one sentence
     * of detail.
     */
    rationale: z.string().min(5).max(1000),
  })
  .strict()
  .refine(
    (val) => {
      // When supports is true, supporting_unit_id MUST be present.
      // When supports is false, it MUST be absent (preventing the
      // model from emitting a supporter for a claim it just
      // rejected — which would confuse the orchestrator).
      if (val.supports) return val.supporting_unit_id !== undefined;
      return val.supporting_unit_id === undefined;
    },
    {
      message:
        "supporting_unit_id MUST be present when supports=true and absent when supports=false",
    },
  );

export type TraceabilityResponseV1 = z.infer<
  typeof TraceabilityResponseV1Schema
>;
