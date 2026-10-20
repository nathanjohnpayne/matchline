/**
 * Zod response contract for `fitBrief.v1.md`. The prompt's
 * `record_fit_brief` tool must emit data that parses against
 * `FitBriefResponseV1Schema`.
 *
 * Mirrors the PRD's `FitBrief` object (docs/projects/matchline/prds/
 * matchline.md § Dossier objects): the decision document every other
 * artifact in a dossier is derived from. #495 Phase 3 evaluates it
 * against the owner's own briefs before any product surface uses it.
 *
 * Evidence is quoted, not paraphrased: each strength carries the exact
 * résumé or inventory lines it rests on, so grounding can be checked
 * deterministically (the eval's evidence gate) before any model grades
 * the prose.
 */

import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

export const FitBriefStrengthV1Schema = z
  .object({
    /** The JD clause this strength answers, quoted or closely paraphrased. */
    jd_clause: nonEmpty,
    /**
     * Lines copied verbatim from the résumé or inventory that prove the
     * strength. At least one; a strength with no quotable evidence is
     * an argument, not a strength.
     */
    evidence: z.array(nonEmpty).min(1),
    /** Why the evidence answers the clause, in the candidate's terms. */
    argument: nonEmpty,
  })
  .strict();

export const FitBriefExposureV1Schema = z
  .object({
    /** The JD clause the candidate is exposed on. */
    jd_clause: nonEmpty,
    /** What is missing or thin, stated plainly. */
    gap: nonEmpty,
    /** How to handle it: reframe, homework, referral, or accept it. */
    handling: nonEmpty,
  })
  .strict();

export const FIT_BRIEF_VERDICTS = ["apply", "hold", "referral_needed", "skip"] as const;

export const FitBriefResponseV1Schema = z
  .object({
    /** Two to four sentences: is this worth pursuing, and on what pitch. */
    bottom_line: nonEmpty,
    /** May be empty only with verdict "skip" — see the refinement below. */
    strengths: z.array(FitBriefStrengthV1Schema),
    exposures: z.array(FitBriefExposureV1Schema),
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
  })
  .strict()
  // An honest weak-fit brief can have no supportable strength; demanding
  // one would push the model to stretch or invent (Codex P1 on #581).
  // Every other verdict rests on at least one.
  .refine((b) => b.verdict === "skip" || b.strengths.length > 0, {
    message: 'strengths may be empty only when verdict is "skip"',
    path: ["strengths"],
  });

export type FitBriefResponseV1 = z.infer<typeof FitBriefResponseV1Schema>;
export type FitBriefVerdict = (typeof FIT_BRIEF_VERDICTS)[number];
