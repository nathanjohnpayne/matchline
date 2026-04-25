/**
 * Zod response contract for `specificity.v1.md`. The prompt's
 * `record_specificity` tool must emit data that parses against
 * `SpecificityResponseV1Schema`.
 *
 * Per #108: the LLM-based specificity fallback. Runs only on
 * claims that escape the deterministic deny-list. Strict yes/no
 * on whether the claim is specific enough that a fact-checker
 * could verify it.
 *
 * The orchestrator (#109) treats `specific: false` as a flag
 * status of `"specificity"` — distinct from traceability's
 * `"untraceable"`. Both block export.
 */

import { z } from "zod";

export const SpecificityResponseV1Schema = z
  .object({
    /**
     * Strict binary verdict. The prompt's hard rules force the
     * model to err on `specific: false` when the claim is
     * vacuous — false-positives let generic prose ship; false-
     * negatives surface as flags the user can dismiss with a
     * single click.
     */
    specific: z.boolean(),
    /**
     * Plain-English explanation. Surfaces in the Application
     * Editor (#24) when the user inspects the flag. 5-1000 chars
     * — same bounds as traceability's rationale.
     */
    rationale: z.string().min(5).max(1000),
  })
  .strict();

export type SpecificityResponseV1 = z.infer<
  typeof SpecificityResponseV1Schema
>;
