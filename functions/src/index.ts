import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";

initializeApp();

/**
 * Sprint 0 health endpoint. Keeps the `functions` package deployable
 * before the real extraction / matching / generation endpoints land
 * in Sprint 1.
 */
export const health = onRequest((_req, res) => {
  res.json({ status: "ok", service: "matchline", version: "0.0.0" });
});

/** Phase 1: pasted resume → array of extracted ExperienceUnits. */
export { extractFromResumeCallable as extractFromResume } from "./callables/extractFromResume.js";

/** Phase 1: pasted JD + roleId → array of parsed JobRequirementUnits. */
export { parseJobRequirementsCallable as parseJobRequirements } from "./callables/parseJobRequirements.js";

/**
 * Phase 1: regenerate the embedding for a single ExperienceUnit
 * whose `reembed_pending` flag was set by an edit or a manual
 * insert. Atomic embed-and-clear.
 */
export { reembedExperienceUnitCallable as reembedExperienceUnit } from "./callables/reembedExperienceUnit.js";

/**
 * Phase 1: score every approved ExperienceUnit against every
 * JobRequirementUnit under a Role; atomically replace the
 * persisted UnitMatch set. Step 3 of the core loop.
 */
export { runMatchingCallable as runMatching } from "./callables/runMatching.js";
