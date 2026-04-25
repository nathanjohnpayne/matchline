/**
 * Zod response contract for `claimExtraction.v1.md`. The prompt's
 * `record_claims` tool must emit data that parses against
 * `ClaimExtractionResponseV1Schema`.
 *
 * Per #106: the validation layer's first stage parses a generated
 * bullet/sentence into discrete atomic claims. Each claim becomes
 * the unit a downstream traceability + specificity check operates
 * on. Server-stamped fields (`id`, `bullet_id`) are not part of
 * the LLM's response — those are added by `extractClaims()`.
 *
 * "Atomic" = one verifiable statement a fact-checker could mark
 * true/false against an Experience Unit. The bullet "Led migration
 * of Disney+ playback stack to 64-bit NCP, reducing memory 30%"
 * decomposes into roughly:
 *   1. Led a migration project.
 *   2. Worked on Disney+ playback on NCP.
 *   3. Achieved 30% memory reduction.
 *
 * Each claim could be independently verified (or refuted) against
 * the source Unit. That's the granularity the validator needs.
 */

import { z } from "zod";

export const ClaimItemV1Schema = z
  .object({
    /**
     * The atomic claim, one verifiable statement. Min length 3
     * filters out junk like single-word emissions; the upper
     * bound (500) is a sanity check — a single claim shouldn't
     * be longer than the original bullet.
     */
    text: z.string().min(3).max(500),
    /**
     * Optional exact substring of the source bullet that backs
     * this claim. Helpful for the Application Editor's hover-
     * highlight UX (#24) — clicking a flag highlights the span
     * the claim came from. Optional because some claims are
     * gestalt summaries that don't trace to a single span (e.g.
     * "Led a migration project" from a bullet that says "Led
     * migration of Disney+ playback to 64-bit NCP" — the span
     * is the whole bullet).
     */
    raw_span: z.string().min(1).max(500).optional(),
  })
  .strict();

export const ClaimExtractionResponseV1Schema = z
  .object({
    /**
     * At least one claim required. Every generated bullet that
     * reaches this stage has fact-bearing content (the generator
     * doesn't emit pure-discourse bullets); zero claims = the
     * model didn't follow the prompt's "cover everything" rule
     * and the bullet would silently bypass the validator.
     * Codex P1 + CodeRabbit Major on PR #110.
     *
     * If a bullet legitimately has zero fact-bearing claims, the
     * caller (#109 orchestrator) is responsible for not invoking
     * this stage on it.
     */
    claims: z.array(ClaimItemV1Schema).min(1),
  })
  .strict();

export type ClaimItemV1 = z.infer<typeof ClaimItemV1Schema>;
export type ClaimExtractionResponseV1 = z.infer<
  typeof ClaimExtractionResponseV1Schema
>;
