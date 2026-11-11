/**
 * Zod response contract for `fitBrief.v2.md`. The prompt's
 * `record_fit_brief` tool must emit data that parses against
 * `FitBriefResponseV2Schema`.
 *
 * Same decision document as v1 (#655), with three additions:
 *
 * - Every point cites the span it rests on, and the span comes first:
 *   a strength's `evidence` precedes its `argument`, and an exposure
 *   now carries `evidence` too, before its `gap` (empty only when the
 *   sources are silent on the clause).
 * - `rule_audit`: one entry per numbered claim-rule check, in order.
 *   The count depends on the claim rules a run sends, so the generator
 *   checks it after parsing (`auditProblem` in generation/fitBrief.ts).
 * - `dropped_points`: what the self-audit removed and why, returned
 *   separately so recall lost to the audit stays visible instead of
 *   silently disappearing.
 *
 * Citations are the generator's own claim about its grounding; the
 * eval's evidence gate still checks every span against the canonical
 * résumé and inventory, never against these fields.
 */

import { z } from "zod";

import { FIT_BRIEF_VERDICTS } from "./fitBrief.v1.schema.js";

const nonEmpty = z.string().trim().min(1);
const checkNumber = z.number().int().min(1);

export const FitBriefStrengthV2Schema = z
  .object({
    /** The JD clause this strength answers, quoted or closely paraphrased. */
    jd_clause: nonEmpty,
    /** Verbatim résumé or inventory spans, cited before the argument. At least one. */
    evidence: z.array(nonEmpty).min(1),
    /** Why the cited spans answer the clause, saying no more than they do. */
    argument: nonEmpty,
  })
  .strict();

export const FitBriefExposureV2Schema = z
  .object({
    /** The JD clause the candidate is exposed on. */
    jd_clause: nonEmpty,
    /**
     * Verbatim spans the gap statement rests on, cited before it. Empty
     * only when the sources say nothing on the clause: an absence has no
     * span, and demanding one would push the model to quote an
     * irrelevant line.
     */
    evidence: z.array(nonEmpty),
    /** What is missing or thin, stated plainly. */
    gap: nonEmpty,
    /** How to handle it: reframe, homework, referral, or accept it. */
    handling: nonEmpty,
  })
  .strict();

export const RULE_AUDIT_OUTCOMES = ["obeyed", "not_applicable"] as const;

export const FitBriefRuleAuditV2Schema = z
  .object({
    /** The claim-rule check number, 1-based, as the request numbers it. */
    check: checkNumber,
    /** A point that would break the check is dropped, so only these two remain. */
    outcome: z.enum(RULE_AUDIT_OUTCOMES),
  })
  .strict();

export const DROPPED_POINT_REASONS = ["span_does_not_support", "no_span", "claim_rule"] as const;

export const FitBriefDroppedPointV2Schema = z
  .object({
    kind: z.enum(["strength", "exposure"]),
    jd_clause: nonEmpty,
    /** The point as it would have been written. */
    point: nonEmpty,
    /** The spans it cited, if any. */
    evidence: z.array(nonEmpty),
    reason: z.enum(DROPPED_POINT_REASONS),
    /** The failed check's number; present exactly when the reason is claim_rule. */
    check: checkNumber.optional(),
  })
  .strict()
  .refine((d) => (d.reason === "claim_rule") === (d.check !== undefined), {
    message: 'check is required for reason "claim_rule" and allowed only there',
    path: ["check"],
  });

export const FitBriefResponseV2Schema = z
  .object({
    /** Two to four sentences: is this worth pursuing, and on what pitch. */
    bottom_line: nonEmpty,
    /** May be empty only with verdict "skip" — see the refinement below. */
    strengths: z.array(FitBriefStrengthV2Schema),
    exposures: z.array(FitBriefExposureV2Schema),
    /** How the package should be positioned: the lead argument and what to foreground. */
    positioning: nonEmpty,
    /** Level, title or years considerations, when the posting raises them. */
    level_strategy: nonEmpty.optional(),
    /** Concrete preparation before any conversation. */
    homework: z.array(nonEmpty),
    /** Questions worth asking the hiring team. */
    questions_to_ask: z.array(nonEmpty),
    /** What this package deliberately does not claim. */
    does_not_claim: z.array(nonEmpty),
    verdict: z.enum(FIT_BRIEF_VERDICTS),
    /** The self-audit's record: exactly one entry per claim-rule check, in order. */
    rule_audit: z.array(FitBriefRuleAuditV2Schema),
    /** Points the self-audit removed; never repeated in strengths or exposures. */
    dropped_points: z.array(FitBriefDroppedPointV2Schema),
  })
  .strict()
  // As in v1: an honest weak-fit brief can have no supportable strength.
  .refine((b) => b.verdict === "skip" || b.strengths.length > 0, {
    message: 'strengths may be empty only when verdict is "skip"',
    path: ["strengths"],
  });

export type FitBriefResponseV2 = z.infer<typeof FitBriefResponseV2Schema>;
export type FitBriefDroppedPointV2 = z.infer<typeof FitBriefDroppedPointV2Schema>;
export type DroppedPointReason = (typeof DROPPED_POINT_REASONS)[number];
